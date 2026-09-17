/**
 * ZIP 容器的读取与 zip bomb 防护（规格 2 §13）。
 *
 * 【为什么自己解析中央目录，而不是交给 zip 库一次性解压】Office 三种格式都是 ZIP，
 * 而 ZIP 的头字段是**声明值**：一个 20MB 的 .docx 可以在中央目录里声明解压后 200GB，
 * 一个对「解压后再检查」的实现会在检查之前就把内存吃光。所以顺序必须是
 * **先只读中央目录（不解压一个字节）→ 逐条判定 → 通过之后才按名单解压需要的条目**。
 * 顺带的好处是「只解压需要的条目」也把内存占用压到了实际用量的量级。
 *
 * 【为什么只解压需要的条目而不是全部】我们只读 `xl/worksheets/*.xml` 这类已知路径；
 * 文档里带的图片、嵌入对象、字体（往往占体积 90% 以上）不需要进内存。既省内存，
 * 也避免把内嵌的 `.docx`/`.bin` 展开——**嵌套深度天然为 1**，不存在解压炸弹的递归路径。
 *
 * 【不执行任何东西】宏（`vbaProject.bin`）、外链一律不读、不解析、不执行，只在
 * 名单层面识别出来给用户一条提示（规格 §13）。
 */

import { inflateSync } from "fflate";

export const ZIP_LIMITS = {
  /** 中央目录条目数上限。正常 OOXML 几十到几百条，2000 已经非常宽松。 */
  maxEntries: 2_000,
  /**
   * 声明解压总量上限。
   *
   * 定得比「单条上限 × 条目数」宽松得多，是因为这个数字**不是真正在起作用的那个**：
   * 我们只解压名单里的条目，OOXML 里占体积的图片/字体/嵌入对象从不进内存（嵌套深度
   * 天然为 1）。真正拦炸弹的是单条上限与压缩比。总量这一条只用来挡「中央目录里声明
   * 了天文数字」这类明显畸形的包，所以它宁可宽松也不要误伤一份图片很多的正经文档。
   */
  maxUncompressedTotal: 512 * 1024 * 1024,
  /** 单条目声明解压体积上限：任何一条超过这个数的条目都不该进内存。 */
  maxEntryUncompressed: 48 * 1024 * 1024,
  /** 压缩比上限：正常 XML 文本约 5–15 倍，200 倍只可能是炸弹。 */
  maxRatio: 200,
} as const;

export type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  encrypted: boolean;
  /** 本地文件头相对文件起点的偏移。 */
  localOffset: number;
};

export type ZipGate =
  | { ok: true; entries: ZipEntry[] }
  | { ok: false; code: "corrupted" | "password_protected"; message: string };

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
}

/** 从尾部向前找 EOCD（注释最长 64KB，所以最多回看 64KB + 22）。 */
function findEocd(bytes: Uint8Array): number {
  const floor = Math.max(0, bytes.length - 65_557);
  for (let at = bytes.length - 22; at >= floor; at -= 1) {
    if (u32(bytes, at) === SIG_EOCD) return at;
  }
  return -1;
}

/**
 * 只读中央目录。**不调用任何解压**——这一步的产物只有元数据。
 *
 * 加密判定用「通用位标记 bit0」，这是 OOXML 密码保护在 ZIP 层的表现；而
 * Office 的密码保护实际上会把整个包变成 OLE2 复合文档（连 ZIP 头都没有），
 * 那条路径在嗅探阶段就拦下了（见 `sniff.ts`）。
 */
export function readZipDirectory(bytes: Uint8Array): ZipGate {
  const eocd = findEocd(bytes);
  if (eocd < 0) return { ok: false, code: "corrupted", message: "不是有效的 ZIP 容器（缺少中央目录结束记录）。" };
  const total = u16(bytes, eocd + 10);
  let offset = u32(bytes, eocd + 16);

  // Zip64：条目数或偏移被写成哨兵值时，真正的值在 EOCD 之前的 Zip64 记录里。
  if (total === 0xffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && u32(bytes, locator) === 0x07064b50) {
      const zip64 = Number(bytes[locator + 8]! | (bytes[locator + 9]! << 8) | (bytes[locator + 10]! << 16) | (bytes[locator + 11]! << 24)) >>> 0;
      if (zip64 > 0 && u32(bytes, zip64) === 0x06064b50) {
        const count = u32(bytes, zip64 + 32);
        const dirOffset = u32(bytes, zip64 + 48);
        // Zip64 的 64 位字段这里用不到（超过 4GB 的文件在附件上限之外），
        // 低 32 位足够描述我们要读的包。
        return walkCentralDirectory(bytes, count, dirOffset);
      }
    }
  }
  return walkCentralDirectory(bytes, total, offset);
}

function walkCentralDirectory(bytes: Uint8Array, total: number, start: number): ZipGate {
  const entries: ZipEntry[] = [];
  let at = start;
  for (let index = 0; index < total; index += 1) {
    if (at + 46 > bytes.length || u32(bytes, at) !== SIG_CENTRAL) {
      return { ok: false, code: "corrupted", message: "ZIP 中央目录已损坏，无法列举条目。" };
    }
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const compressedSize = u32(bytes, at + 20);
    const uncompressedSize = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const localOffset = u32(bytes, at + 42);
    const name = new TextDecoder("utf-8").decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.push({ name, method, compressedSize, uncompressedSize, encrypted: (flags & 0x0001) !== 0, localOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (entries.length === 0) return { ok: false, code: "corrupted", message: "ZIP 容器里没有任何条目。" };
  return { ok: true, entries };
}

/**
 * 逐条判定。**必须在解压之前调用**（这是整个防护的意义所在）。
 *
 * 判定顺序刻意从「最便宜的检查」到「最需要计算的检查」：条目数、单条体积、
 * 总量都是读元数据，压缩比才需要一次除法。
 */
export function guardZip(entries: readonly ZipEntry[]): { ok: true } | { ok: false; code: "corrupted" | "password_protected"; message: string } {
  if (entries.some((entry) => entry.encrypted)) {
    return { ok: false, code: "password_protected", message: "文件受密码保护，无法读取内容。请提供未加密的副本后重新添加。" };
  }
  if (entries.length > ZIP_LIMITS.maxEntries) {
    return { ok: false, code: "corrupted", message: `压缩容器条目数超过 ${ZIP_LIMITS.maxEntries}，已拒绝解析。` };
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.uncompressedSize > ZIP_LIMITS.maxEntryUncompressed) {
      return { ok: false, code: "corrupted", message: `压缩容器内单个条目声明解压后超过 ${Math.round(ZIP_LIMITS.maxEntryUncompressed / 1024 / 1024)}MB，已拒绝解析。` };
    }
    total += entry.uncompressedSize;
    if (total > ZIP_LIMITS.maxUncompressedTotal) {
      return { ok: false, code: "corrupted", message: `压缩容器声明解压总量超过 ${Math.round(ZIP_LIMITS.maxUncompressedTotal / 1024 / 1024)}MB，已拒绝解析。` };
    }
    if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > ZIP_LIMITS.maxRatio) {
      return { ok: false, code: "corrupted", message: `压缩容器的压缩比超过 ${ZIP_LIMITS.maxRatio} 倍，已拒绝解析。` };
    }
  }
  return { ok: true };
}

/**
 * 一步完成「读中央目录 + 判定」。
 *
 * 交给别的库（mammoth / exceljs）解析之前必须先过这里。它们内部各自有 zip 读取器，
 * 而那些读取器默认不做任何体积判定——「先让库解压、解完再检查」的写法在炸弹上就是
 * 已经输了。所以防护必须在**把字节交出去之前**完成。
 */
export function gateZipBytes(bytes: Uint8Array): ZipGate {
  const directory = readZipDirectory(bytes);
  if (!directory.ok) return directory;
  const gate = guardZip(directory.entries);
  if (!gate.ok) return gate;
  return directory;
}

/** 条目名是否命中名单（前缀或精确）。 */function matches(name: string, wanted: readonly string[]): boolean {
  for (const candidate of wanted) {
    if (candidate.endsWith("/")) {
      if (name.startsWith(candidate)) return true;
    } else if (name === candidate) return true;
  }
  return false;
}

export type ZipReadResult =
  | { ok: true; files: Map<string, Uint8Array> }
  | { ok: false; code: "corrupted" | "password_protected"; message: string };

/**
 * 按名单解压。**调用前必须先 `guardZip`**——本函数只负责解压，不做任何防护判定，
 * 它假设调用方已经证明了这个容器是安全的。
 *
 * 单条解压后仍复查一次体积：中央目录写的是声明值，实际解压结果超限说明声明是假的
 * （这在畸形包里是真实存在的），此时宁可失败也不把超量数据留给下游。
 */
export function readZipEntries(bytes: Uint8Array, wanted: readonly string[]): ZipReadResult {
  const directory = readZipDirectory(bytes);
  if (!directory.ok) return directory;
  const gate = guardZip(directory.entries);
  if (!gate.ok) return gate;

  const files = new Map<string, Uint8Array>();
  for (const entry of directory.entries) {
    if (!matches(entry.name, wanted)) continue;
    const start = localDataOffset(bytes, entry);
    if (start === null) {
      return { ok: false, code: "corrupted", message: `ZIP 条目 ${entry.name} 的本地头已损坏。` };
    }
    const slice = bytes.subarray(start, start + entry.compressedSize);
    let content: Uint8Array;
    try {
      if (entry.method === 0) content = slice;
      else if (entry.method === 8) content = inflateSync(slice);
      else return { ok: false, code: "corrupted", message: `ZIP 条目 ${entry.name} 使用了不支持的压缩方式（${entry.method}）。` };
    } catch {
      return { ok: false, code: "corrupted", message: `ZIP 条目 ${entry.name} 解压失败（数据已损坏）。` };
    }
    if (content.byteLength > ZIP_LIMITS.maxEntryUncompressed) {
      return { ok: false, code: "corrupted", message: `ZIP 条目 ${entry.name} 实际解压体积超过上限，已拒绝。` };
    }
    files.set(entry.name, content);
  }
  return { ok: true, files };
}

/**
 * 本地文件头里的数据起点。
 *
 * 只用它定位起点，**不用它取大小**：流式写入的 ZIP 会把大小写 0 并把真实值放在
 * 数据描述符里，那时只有中央目录的值是对的。
 */
function localDataOffset(bytes: Uint8Array, entry: ZipEntry): number | null {
  const at = entry.localOffset;
  if (at + 30 > bytes.length || u32(bytes, at) !== SIG_LOCAL) return null;
  const nameLength = u16(bytes, at + 26);
  const extraLength = u16(bytes, at + 28);
  const start = at + 30 + nameLength + extraLength;
  return start <= bytes.length ? start : null;
}

/** 条目名清单（给解析器挑路径用，不列出内容）。 */
export function zipEntryNames(entries: readonly ZipEntry[]): string[] {
  return entries.map((entry) => entry.name);
}

/** 容器里是否存在某个条目（如宏工程）。 */
export function zipHas(entries: readonly ZipEntry[], name: string): boolean {
  return entries.some((entry) => entry.name === name);
}
