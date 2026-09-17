/**
 * 提取结果的收口（规格 2 §10.1 / §13）。
 *
 * 【为什么每个适配器都必须过这里】`EXTRACTION_LIMITS` 是「解析器输出不可信」这条
 * 判断的执行点：一个 25MB 的 XLSX 能解出几百万个格子，一个畸形 PDF 能声明几万页。
 * 如果靠每个适配器自觉，迟早有一个忘了——而它忘掉的后果不是少几行文本，是把
 * 几百万字符写进缓存、再塞进模型的上下文。所以适配器只负责「把文件读成带定位的
 * 文本」，由这里统一做切分、截断、去重和上限判定。
 *
 * 截断是**有损但诚实**的：我们丢掉超出上限的内容，并在 warnings 里写明丢了什么。
 * 悄悄丢内容会让模型以为文件就这么点内容——那比报错更糟。
 */

import { EXTRACTION_LIMITS, EXTRACTION_VERSION, type ExtractedDocument, type ExtractedSection, type ExtractionLocator } from "@zmzai/agent-framework";

import { noExtractableText } from "./errors";

export type SectionDraft = { id: string; locator: ExtractionLocator; text: string };

/** 单节切分阈值：留一半余量，避免刚好卡在上限上因为一行之差被整体拒绝。 */
const SECTION_SPLIT_CHARS = Math.floor(EXTRACTION_LIMITS.maxSectionChars / 2);

/**
 * 按行把超长文本切成多节，尽量在空行处断开（段落边界比任意字符处更自然）。
 * 定位沿用同一 locator：`sectionsForLocator` 的区间相交语义天然支持「一页被切成
 * 多节」，按页码读取时会一并返回。
 */
export function splitLongText(text: string, locator: ExtractionLocator, idPrefix: string): SectionDraft[] {
  if (text.length <= SECTION_SPLIT_CHARS) return [{ id: idPrefix, locator, text }];
  const lines = text.split("\n");
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = [];
    size = 0;
  };
  for (const line of lines) {
    // 单行就超限（例如压缩成一行的 JSON）：硬切，否则这一行永远放不进去
    if (line.length > SECTION_SPLIT_CHARS) {
      flush();
      for (let at = 0; at < line.length; at += SECTION_SPLIT_CHARS) {
        chunks.push([line.slice(at, at + SECTION_SPLIT_CHARS)]);
      }
      continue;
    }
    if (size + line.length + 1 > SECTION_SPLIT_CHARS) flush();
    current.push(line);
    size += line.length + 1;
  }
  flush();
  if (chunks.length <= 1) return [{ id: idPrefix, locator, text }];
  return chunks.map((chunk, index) => ({ id: `${idPrefix}#${index + 1}`, locator, text: chunk.join("\n") }));
}

export type FinalizeInput = {
  attachmentId: string;
  title?: string;
  sections: SectionDraft[];
  warnings?: readonly string[];
};

/**
 * 收口成合法且受限的 `ExtractedDocument`。
 *
 * 抛 `no_extractable_text` 而不是返回空文档：一份没有任何文本的文件（扫描件、
 * 全是图片的 PPT）对 Agent 没有价值，让状态停在 error 并说清原因，比给模型一个
 * 空壳、让它自己猜「是不是没读到」要好。
 */
export function finalizeDocument(input: FinalizeInput): ExtractedDocument {
  const warnings = dedupeWarnings(input.warnings ?? []);
  const sections: ExtractedSection[] = [];
  const seen = new Set<string>();
  let totalChars = 0;

  outer: for (const draft of input.sections) {
    if (draft.text.trim().length === 0) continue;
    for (const piece of splitLongText(draft.text, draft.locator, draft.id)) {
      if (sections.length >= EXTRACTION_LIMITS.maxSections) {
        warnings.push(`文档分节数超过 ${EXTRACTION_LIMITS.maxSections} 上限，其余内容未纳入。`);
        break outer;
      }
      if (totalChars + piece.text.length > EXTRACTION_LIMITS.maxTotalChars) {
        warnings.push(`文档正文超过 ${EXTRACTION_LIMITS.maxTotalChars} 字符上限，后续内容未纳入；请按页码/工作表读取剩余部分。`);
        break outer;
      }
      // 节 id 必须唯一：重复 id 会让「按 section_id 读取」一次返回多节，模型无法确认读到了哪一段
      let id = piece.id;
      let suffix = 1;
      while (seen.has(id)) id = `${piece.id}~${++suffix}`;
      seen.add(id);
      sections.push({ id, locator: piece.locator, text: piece.text });
      totalChars += piece.text.length;
    }
  }

  if (sections.length === 0) throw noExtractableText();

  return {
    attachmentId: input.attachmentId,
    ...(input.title ? { title: input.title.slice(0, EXTRACTION_LIMITS.maxTitleChars) } : {}),
    sections,
    warnings: dedupeWarnings(warnings).slice(0, EXTRACTION_LIMITS.maxWarnings),
    version: EXTRACTION_VERSION,
  };
}

/** 警告去重：同一份文件里逐页重复的同一句话没有信息量，只会把上限占满。 */
function dedupeWarnings(warnings: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const warning of warnings) {
    const text = warning.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text.length > 1_000 ? `${text.slice(0, 997)}…` : text);
    if (out.length >= EXTRACTION_LIMITS.maxWarnings) break;
  }
  return out;
}

/** 提取结果 → 回执摘要（规格 §9.1 的 `extraction` 字段）。 */
export function summarize(document: ExtractedDocument): {
  pages?: number;
  sheets?: string[];
  slides?: number;
  characters?: number;
  warnings?: string[];
} {
  const pages = new Set<number>();
  const sheets = new Set<string>();
  const slides = new Set<number>();
  let characters = 0;
  for (const section of document.sections) {
    if (typeof section.locator.page === "number") pages.add(section.locator.page);
    if (section.locator.sheet) sheets.add(section.locator.sheet);
    if (typeof section.locator.slide === "number") slides.add(section.locator.slide);
    characters += section.text.length;
  }
  return {
    ...(pages.size > 0 ? { pages: pages.size } : {}),
    ...(sheets.size > 0 ? { sheets: [...sheets] } : {}),
    ...(slides.size > 0 ? { slides: slides.size } : {}),
    characters,
    ...(document.warnings.length > 0 ? { warnings: document.warnings } : {}),
  };
}
