/**
 * 内容嗅探（规格 §6 / §13）。
 *
 * 【为什么不信客户端的 `file.type`】浏览器给的值来自扩展名或系统注册表，可以是空串、
 * `application/octet-stream`，也可以被恶意页面随意伪造。规格 §19 明确「不得信任客户端
 * MIME、大小、文件名或 attachment id 所有权」。这里按文件头给出真实类型，扩展名只用于
 * 早期提示。
 *
 * 【不做解压】OOXML（docx/xlsx/pptx）是 ZIP 容器。这里只扫描原始字节里的中央目录条目名
 * 来区分三种类型，**不解压**——解压总量/文件数/压缩比的限制属于提取阶段（zip bomb 防护），
 * 放在真正读取内容的地方才有意义。
 */

import { formatForFilename, type AttachmentFormat } from "./limits";

/** 嗅探出的规范类型；`null` 表示无法判定（未知或二进制）。 */
export type SniffedMediaType = string | null;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

function containsAscii(bytes: Uint8Array, needle: string): boolean {
  const target = new TextEncoder().encode(needle);
  outer: for (let i = 0; i <= bytes.length - target.length; i += 1) {
    for (let j = 0; j < target.length; j += 1) {
      if (bytes[i + j] !== target[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** 前 8KB 出现 NUL 即视为二进制（与 lib/api/fs/file 的判据一致）。 */
function looksBinary(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, Math.min(bytes.length, 8192));
  return window.includes(0);
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
    return true;
  } catch {
    return false;
  }
}

/** 按文件头给出真实类型。 */
export function sniffMediaType(bytes: Uint8Array): SniffedMediaType {
  if (bytes.length === 0) return null;
  if (startsWith(bytes, PDF_MAGIC)) return "application/pdf";
  if (startsWith(bytes, PNG_MAGIC)) return "image/png";
  if (startsWith(bytes, JPEG_MAGIC)) return "image/jpeg";
  if (startsWith(bytes, OLE2_MAGIC)) return "application/x-ole-storage";
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && new TextDecoder("latin1").decode(bytes.subarray(8, 12)) === "WEBP") return "image/webp";

  // ZIP 容器：按中央目录里的条目名区分 OOXML 三种类型（不解压）
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    if (containsAscii(bytes, "word/document.xml")) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    if (containsAscii(bytes, "xl/workbook.xml")) {
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    }
    if (containsAscii(bytes, "ppt/presentation.xml")) {
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    }
    // 其它 ZIP（含加密容器）：不是本期支持的格式
    return "application/zip";
  }

  if (!looksBinary(bytes) && isUtf8(bytes)) return "text/plain";
  return null;
}

export type SniffVerdict =
  | { ok: true; mediaType: string; warning?: string }
  | { ok: false; code: "unsupported_format" | "corrupted" | "password_protected"; message: string };

/** 声明为 OOXML 但内容是 OLE2 的三种格式（它们的加密版本长这样）。 */
const OOXML_FORMAT_IDS = new Set(["docx", "xlsx", "pptx"]);

/** OLE2 里只在这两种流出现时才说明是**加密**的 OOXML（ECMA-376 加密容器）。 */
const ENCRYPTION_STREAMS = ["EncryptedPackage", "EncryptionInfo"];

/** OLE2 目录里的名字是 UTF-16LE，所以逐字节比对时每个 ASCII 字符后面跟一个 0x00。 */
function containsUtf16(bytes: Uint8Array, needle: string): boolean {
  const probe = bytes.subarray(0, Math.min(bytes.length, 512 * 1024));
  outer: for (let at = 0; at <= probe.length - needle.length * 2; at += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (probe[at + index * 2] !== needle.charCodeAt(index) || probe[at + index * 2 + 1] !== 0) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * 声称是 OOXML、内容却是 OLE2 复合文档的两种情况。
 *
 * 【为什么要区分】它们对用户的下一步完全不同：加密的要「给我未加密的副本」，旧版二进制的
 * 要「在 Office 里另存为新版格式」。而两者在字节层面都是 OLE2——**唯一的区别是流名**
 * （加密容器里是 `EncryptedPackage` / `EncryptionInfo`）。§10.3 要求把两类失败分开，
 * 那么就必须真的去看一眼，而不是含糊地说「格式不符」。
 *
 * 【为什么不做完整 OLE2 解析】我们只需要回答「有没有这两个流名」这一件事，扫一段
 * 有界的字节范围就够了。为一个布尔判断引入完整的复合文档解析器，是把攻击面当零成本。
 */
function classifyOleContainer(declaredFormat: AttachmentFormat, bytes: Uint8Array): SniffVerdict {
  const encrypted = ENCRYPTION_STREAMS.some((stream) => containsUtf16(bytes, stream));
  if (encrypted) {
    return {
      ok: false,
      code: "password_protected",
      message: `「${declaredFormat.label}」是受密码保护的文档，无法读取内容。请提供未加密的副本后重新添加。`,
    };
  }
  return {
    ok: false,
    code: "unsupported_format",
    message: `文件内容是旧版二进制 Office 格式（OLE2 容器），并不是 ${declaredFormat.label}。请在 Office 中另存为新版格式后重新添加。`,
  };
}

/** 嗅探类型与声明格式是否相容（文本类互通：text / csv / tsv 都是纯文本）。 */
function compatible(format: AttachmentFormat, sniffed: string): boolean {
  switch (format.kind) {
    case "text":
      return sniffed === "text/plain";
    case "spreadsheet":
      // csv/tsv 就是纯文本；xlsx 必须是 OOXML；xls 必须是 OLE2 复合文档
      if (format.id === "csv" || format.id === "tsv") return sniffed === "text/plain";
      if (format.id === "xlsx") return sniffed === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      if (format.id === "xls") return sniffed === "application/x-ole-storage";
      return false;
    case "image":
      return sniffed.startsWith("image/");
    case "document":
      if (format.id === "pdf") return sniffed === "application/pdf";
      if (format.id === "docx") return sniffed === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      return false;
    case "presentation":
      return sniffed === "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
}

/**
 * 交叉校验扩展名与真实内容（规格 §6）。
 * 不一致时**拒绝**而不是「按实际类型处理」：一个声称是 PDF 的 ZIP 没有正当理由，
 * 而放宽到「按实际类型处理」等于把扩展名白名单变成空文（`.exe` 改名为 `.xlsx` 就能过）。
 */
export function verifyContent(declaredFormat: AttachmentFormat, bytes: Uint8Array): SniffVerdict {
  const sniffed = sniffMediaType(bytes);
  if (sniffed === null) {
    return { ok: false, code: "corrupted", message: "无法识别文件内容（可能已损坏或含不可读字节）" };
  }
  // 声明是 docx/xlsx/pptx 但内容是 OLE2：加密副本，或者被改名/另存错了的旧版文件。
  // 这两种都要给出**具体**原因，而不是笼统的「格式不符」（§10.3）。
  if (sniffed === "application/x-ole-storage" && OOXML_FORMAT_IDS.has(declaredFormat.id)) {
    return classifyOleContainer(declaredFormat, bytes);
  }
  if (!compatible(declaredFormat, sniffed)) {
    return {
      ok: false,
      code: "unsupported_format",
      message: `文件内容与扩展名不符：声明为 ${declaredFormat.label}，实际为 ${sniffed}`,
    };
  }
  return { ok: true, mediaType: sniffed };
}

/** 便捷入口：从文件名与字节一次性得到判定结果。 */
export function verifyUpload(filename: string, bytes: Uint8Array): SniffVerdict {
  const format = formatForFilename(filename);
  if (!format) return { ok: false, code: "unsupported_format", message: `暂不支持 ${filename} 的格式` };
  return verifyContent(format, bytes);
}
