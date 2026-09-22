/**
 * 工作区文件「能不能当文本打开」的判定（`GET /api/fs/file` 的判据）。
 *
 * 【为什么不能只看 NUL 字节】旧判据是 `buf.includes(0)`。它漏掉了一整类
 * **纯 ASCII 的二进制格式**——ReportLab 生成的 PDF 就是典型：整个文件零个 NUL、
 * 99.97% 的字节落在可打印 ASCII 区间（字体宽度数组、未压缩的对象流），于是被
 * 判成文本塞进了 CodeMirror，用户看到的是 `/BaseFont /STSong-Light /W [ 1 [ 207
 * 270 342 … ] ]` 这样的源码。判据必须看**文件头**，而不只是「有没有零字节」。
 *
 * 【为什么复用附件链路的嗅探表】`lib/attachments/sniff.ts` 已经有一张
 * 「文件头 → 真实类型」的表（PDF / PNG / JPEG / GIF / WEBP / OLE2 / ZIP 容器），
 * 且它的注释本来就写着「与 lib/api/fs/file 的判据一致」——一直没一致。这里把它
 * 接上，两处从此同源。嗅探表只用于**识别**，不在这里做格式白名单：工作区里出现
 * `.icns`、`.wasm`、`.db` 都正常，它们只是不该被当文本读。
 *
 * 本模块必须保持纯净（无 node / DOM API）：路由与单测共用。
 */

import { sniffMediaType } from "./attachments/sniff.js";

export type FileContent =
  /** 可以按文本打开（编辑器 / `<pre>`）。空文件也算——它本来就是空的。 */
  | { text: true; mediaType: "text/plain" }
  /** 不是文本。`mediaType` 有值时是嗅探出的确凿类型，`null` 表示「不像文本但认不出是什么」。 */
  | { text: false; mediaType: string | null };

/**
 * 可打印字节占比的下限（`file(1)` 的老办法）。
 *
 * 【为什么用占比而不是「是不是合法 UTF-8」】工作区里的文本不保证是 UTF-8：
 * 一份 GBK 编码的 `.txt` 解不开，但它无疑该能用编辑器打开。合法性判不出文件的
 * 种类，占比可以——真正文本的绝大多数字节都落在可打印区间或空白上。
 *
 * 高位字节（≥ 0x80）计为可打印是刻意的：GBK / Latin-1 里它们就是字。二进制会
 * 在低控制字节（0x00–0x08、0x0b、0x0c、0x0e–0x1f）上大量露馅，那一关足以区分，
 * 不需要在这里猜编码。
 *
 * 【已知边界】满屏 ANSI 转义序列的终端日志可能落在线下被判成二进制。这是可以
 * 接受的：那种内容该去终端读，而不是在编辑器里。
 */
const PRINTABLE_MIN = 0.9;

function printableRatio(bytes: Uint8Array): number {
  let printable = 0;
  for (const byte of bytes) {
    if (byte >= 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) printable += 1;
  }
  return printable / bytes.length;
}

/**
 * 按内容判定这批字节是不是文本。前一步能定论就不看后一步：
 *
 * ① 空文件 → 文本（编辑器打开是空的，不是「二进制」）
 * ② 文件头命中已知格式 → 二进制，并给出具体类型（PDF / image/… / zip…）
 * ③ 通篇出现 NUL → 二进制。这一步**不能只扫前 8KB**：`sniffMediaType` 的
 *    `looksBinary` 只看窗口，而 NUL 是合法 UTF-8，落在 8KB 之后就会被漏掉
 *    （`.wasm` 的头部、SQLite 的文件头都在这个盲区里）。
 * ④ 其余按可打印占比判——这一步同时覆盖 UTF-8、GBK 与（认不出文件头的）二进制。
 */
export function classifyFileBytes(bytes: Uint8Array): FileContent {
  if (bytes.length === 0) return { text: true, mediaType: "text/plain" };

  const sniffed = sniffMediaType(bytes);
  if (sniffed !== null && sniffed !== "text/plain") return { text: false, mediaType: sniffed };

  if (bytes.includes(0)) return { text: false, mediaType: null };
  if (printableRatio(bytes) >= PRINTABLE_MIN) return { text: true, mediaType: "text/plain" };
  return { text: false, mediaType: null };
}

/**
 * 只看文件头一截时的「确凿二进制」判定，用于超过文本上限的大文件：
 * 我们不会把大文件塞进编辑器，所以这里只需要回答「它到底是二进制还是单纯太大」，
 * 好让调用方给出**正确**的那条提示。没有确凿证据时返回 false，由调用方报「过大」。
 *
 * 刻意不做可打印占比判定：截断的头部可能正好切断一个多字节字符，据一个残缺样本
 * 报「二进制」是把读取上限问题说成了文件格式问题。
 */
export function looksBinaryHead(head: Uint8Array): boolean {
  const sniffed = sniffMediaType(head);
  if (sniffed !== null && sniffed !== "text/plain") return true;
  return head.includes(0);
}
