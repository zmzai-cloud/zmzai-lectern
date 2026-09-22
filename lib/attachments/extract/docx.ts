/**
 * Word（.docx）提取（规格 2 §10.1 / §10.3 / §13）。
 *
 * 【为什么 DOCX 的 locator 没有页码】分页是 Word **渲染期**的概念——文件里根本不存在
 * 「第几页」，同一份文档换个字体、换个纸张就会重新分页。从渲染结果倒推页码只会给出
 * 一个明天就变的假定位，而用户拿它去核对时对不上。所以 Word 用 `lineStart/lineEnd`
 * 定位（§10.1 允许的字段），并保留标题层级：行号在提取出的纯文本里是稳定且可复现的
 * （同一份文件解析两次必然得到同样的行号）。
 *
 * 【为什么先过 ZIP 闸门再交给 mammoth】mammoth 内部用 jszip 解压，而它默认不做任何
 * 体积判定。防护必须在把字节交出去之前完成（见 `zip.ts`）。
 *
 * 【为什么不执行、也不读宏】`word/vbaProject.bin` 从不读；文档里的外部链接
 * （`TargetMode="External"`）不解析。识别到就只给一条提示（§13）。
 */

import type { ExtractedDocument } from "@zmzai/agent-framework";

import { ExtractionFailure } from "./errors.js";
import type { SectionDraft } from "./finalize.js";
import { finalizeDocument } from "./finalize.js";
import { decodeEntities, decodeXml, stripTags } from "./xml.js";
import { gateZipBytes, readZipEntries } from "./zip.js";

/** 一个分节覆盖的行数上限：超过就断开，避免「一份没有标题的文档」变成单独一节。 */
const LINES_PER_SECTION = 120;
const CHARS_PER_SECTION = 8_000;
/** 标题层级 ≤ 这个值的标题一定开启新分节（h1/h2 是文档的真实骨架）。 */
const SECTION_HEADING_LEVEL = 2;

type HtmlLine = { text: string; level?: number };

/**
 * mammoth 的 HTML → 带标题层级的行。
 *
 * 【为什么不用 DOM】服务端没有 DOM，而这里要做的事只有「把块级标签变成换行」。
 * 用一次字符串替换链而不是树遍历，还有个附带好处：嵌套块级标签（`<blockquote><p>`、
 * `<td><p>`）多产生的空行会在最后一步被折叠掉，不需要为每种嵌套写一条规则。
 *
 * 【表格必须单独处理】表格行是**一行**，而单元格里的多段文字会带来换行——如果让
 * 通用的换行规则先去处理，一个表格行会散成好几行，「表格第 3 行」就对不上了。
 * 所以先把 `<tr>` 渲染成占位符，等其余规则跑完再还原。
 */
export function htmlToLines(html: string): HtmlLine[] {
  const rows: string[][] = [];
  let work = html.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_match, rowHtml: string) => {
    const cells = [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
      // 单元格里的块级标签换成空格再剥标签：`<p>甲</p><p>乙</p>` 是「甲 乙」两段，
      // 直接剥标签会粘成「甲乙」——把两个段落读成了同一个词
      stripTags(cell[1]!.replace(/<[^>]*>/g, (tag) => (/^<\/?(p|div|br|li|h[1-6]|blockquote|pre)\b/i.test(tag) ? " " : "")))
        .replace(/\s+/g, " ")
        .trim(),
    );
    rows.push(cells);
    return `\u0004${rows.length - 1}\u0004`;
  });

  // 标题：把层级编码进占位符，`###` 前缀与标题层级是同一件事的两种表示
  work = work.replace(/<h([1-6])\b[^>]*>/gi, "\n\u0003$1\u0003");
  work = work.replace(/<li\b[^>]*>/gi, "\n\u2022 ");
  work = work.replace(/<br\s*\/?>/gi, "\n");
  work = work.replace(/<\/(p|li|h[1-6]|blockquote|pre|div|table|ul|ol)>/gi, "\n");
  work = work.replace(/<(p|blockquote|pre|div|table|ul|ol)\b[^>]*>/gi, "\n");
  work = work.replace(/<[^>]*>/g, "");
  work = decodeEntities(work);
  // 占位符独占一行，这样还原时不会和相邻正文粘在一起
  work = work.replace(/\u0004(\d+)\u0004/g, "\n\u0004$1\u0004\n");

  const lines: HtmlLine[] = [];
  for (const piece of work.split("\n")) {
    const placeholder = /^\u0004(\d+)\u0004$/.exec(piece.trim());
    if (placeholder) {
      const cells = rows[Number(placeholder[1])] ?? [];
      if (cells.some((cell) => cell.length > 0)) lines.push({ text: cells.join(" | ") });
      continue;
    }
    const text = piece.replace(/\s+$/, "");
    const heading = /^\u0003([1-6])\u0003\s*(.*)$/.exec(text);
    if (heading) {
      lines.push({ text: `${"#".repeat(Number(heading[1]))} ${heading[2]!.trim()}`, level: Number(heading[1]) });
      continue;
    }
    if (text.trim().length === 0) continue;
    lines.push({ text });
  }
  return lines;
}

export type DocxExtractionInput = {
  attachmentId: string;
  filename: string;
  bytes: Uint8Array;
};

export async function extractDocx(input: DocxExtractionInput): Promise<ExtractedDocument> {
  const gate = gateZipBytes(input.bytes);
  if (!gate.ok) throw new ExtractionFailure(gate.code, gate.message);

  const warnings: string[] = [];
  collectPackageSignals(input.bytes, warnings);

  const mammoth = await import("mammoth");
  let html: string;
  let messages: Array<{ type: string; message: string }>;
  try {
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(input.bytes) });
    html = result.value;
    messages = result.messages as Array<{ type: string; message: string }>;
  } catch {
    // mammoth 的原始错误可能带内部路径；对外只说「结构不对」（§13 日志不含文件内容）
    throw new ExtractionFailure("corrupted", "Word 文档结构不完整，无法解析（可能已损坏或不是 .docx 格式）。");
  }

  const images = (html.match(/<img\b/gi) ?? []).length;
  if (images > 0) warnings.push(`文档包含 ${images} 张图片，图片内容未纳入文本提取。`);
  const styleWarnings = [...new Set(messages.filter((message) => message.type === "warning").map((message) => message.message))];
  if (styleWarnings.length > 0) {
    warnings.push(`有 ${styleWarnings.length} 处样式未识别，已按普通段落处理，正文不受影响。`);
  }

  const lines = htmlToLines(html);
  const sections = groupLines(lines);
  const title = lines.find((line) => line.level === 1)?.text.replace(/^#+\s*/, "");

  return finalizeDocument({
    attachmentId: input.attachmentId,
    ...(title ? { title } : {}),
    sections,
    warnings,
  });
}

/**
 * 按标题与体量分行成节。
 *
 * 行号 1-based 指**提取出的纯文本行**（不是 Word 里的行），同一份文件两次解析必然一致。
 * 每节的行区间写进 locator，于是「读第 12–18 行」是精确的、可核对的。
 */
export function groupLines(lines: readonly HtmlLine[]): SectionDraft[] {
  const sections: SectionDraft[] = [];
  let start = 0;
  let chars = 0;

  const flush = (end: number) => {
    if (end <= start) return;
    const body = lines.slice(start, end).map((line) => line.text).join("\n");
    if (body.trim().length === 0) return;
    sections.push({ id: `l${start + 1}`, locator: { lineStart: start + 1, lineEnd: end }, text: body });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const startsSection =
      index > start &&
      ((line.level !== undefined && line.level <= SECTION_HEADING_LEVEL) || chars >= CHARS_PER_SECTION || index - start >= LINES_PER_SECTION);
    if (startsSection) {
      flush(index);
      start = index;
      chars = 0;
    }
    chars += line.text.length + 1;
  }
  flush(lines.length);
  return sections;
}

/**
 * 只读容器名单层面的安全信号：宏与外部链接。
 *
 * **不读内容、不解析、不执行**，只是让用户知道这份文档带了这些东西——「已忽略」和
 * 「不知道有」是两回事，前者用户还能自己判断要不要换个版本。
 */
function collectPackageSignals(bytes: Uint8Array, warnings: string[]): void {
  const names = readZipEntries(bytes, ["word/vbaProject.bin", "word/_rels/document.xml.rels"]);
  if (!names.ok) return;
  if (names.files.has("word/vbaProject.bin")) {
    warnings.push("文档包含宏（vbaProject.bin），已忽略且不会执行。");
  }
  const rels = names.files.get("word/_rels/document.xml.rels");
  if (rels) {
    const external = (decodeXml(rels).match(/TargetMode\s*=\s*"External"/gi) ?? []).length;
    if (external > 0) warnings.push(`文档包含 ${external} 处外部链接，未访问、未解析。`);
  }
}
