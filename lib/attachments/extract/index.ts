/**
 * 文档提取的调度入口（规格 2 §10.1 / §10.3 / §16 阶段 C）。
 *
 * 【职责边界】这里只决定「这份文件该用哪个适配器」，以及把异常归一成
 * `ExtractionOutcome`——**永不抛异常**。调用方（后台队列）要的是「成功/失败 + 原因」
 * 这种可以落库的结果，而不是一个可能在任何地方炸出来的 throw。
 *
 * 【为什么提取器版本单独算】解析结果按文件摘要缓存（同一份文件不必重复解析）。
 * 但缓存的有效性不只取决于文件，也取决于**解析器本身**：修了 PDF 的分行逻辑，
 * 老缓存就是错的。所以缓存里带一个适配器版本，版本不符就重新解析。framework 的
 * `EXTRACTION_VERSION` 管的是数据结构，两者不能混为一谈——改数据结构要让下游
 * 拒绝，改解析行为只需要重算。
 */

import type { ExtractedDocument } from "@zmzai/agent-framework";

import { formatForFilename } from "../limits.js";
import { ExtractionFailure, classifyThrown, type ExtractionFailureCode } from "./errors.js";
import { extractDocx } from "./docx.js";
import { extractPdf } from "./pdf.js";
import { extractPptx } from "./pptx.js";
import { extractPlainText } from "./text.js";
import { extractXlsx } from "./xlsx.js";

/**
 * 适配器版本。**改动任一适配器的解析行为就要 +1**，否则老缓存会继续被复用。
 * （缓存里存的是解析结果，不是文件本身。）
 */
export const EXTRACTOR_VERSION = 1;

/** 需要结构化提取的格式；`image` 不需要（走视觉输入），`null` 表示本期不提取正文。 */
export type ExtractionKind = "pdf" | "docx" | "xlsx" | "pptx" | "csv" | "text";

/** 该文件要不要走提取流程。`none` 的两种含义（图片 / 不支持的旧格式）由调用方区分。 */
export function extractionKindFor(filename: string): ExtractionKind | "none" {
  const format = formatForFilename(filename);
  if (!format) return "none";
  switch (format.extractor) {
    case "pdf":
    case "docx":
    case "xlsx":
    case "pptx":
    case "csv":
    case "text":
      return format.extractor;
    default:
      return "none";
  }
}

export type ExtractionInput = {
  attachmentId: string;
  filename: string;
  bytes: Uint8Array;
  signal?: AbortSignal;
};

export type ExtractionOutcome =
  | { ok: true; document: ExtractedDocument }
  | { ok: false; code: ExtractionFailureCode; message: string };

/**
 * 提取一份文件。**不抛异常**：失败以 outcome 的形式返回（§10.3 的错误分类）。
 */
export async function runExtraction(input: ExtractionInput): Promise<ExtractionOutcome> {
  const kind = extractionKindFor(input.filename);
  try {
    if (kind === "pdf") return { ok: true, document: await extractPdf(input) };
    if (kind === "docx") return { ok: true, document: await extractDocx(input) };
    if (kind === "xlsx") return { ok: true, document: await extractXlsx(input) };
    if (kind === "pptx") return { ok: true, document: await extractPptx(input) };
    if (kind === "csv") {
      const delimiter = input.filename.toLowerCase().endsWith(".tsv") ? "\t" : ",";
      return { ok: true, document: extractPlainText({ ...input, delimiter }) };
    }
    if (kind === "text") return { ok: true, document: extractPlainText(input) };
    // 走到这里说明调用方对不该提取的文件调了提取：这不是用户错误，是我们的 bug，
    // 但仍然以失败返回（队列要能落库），只是文案不去指责用户
    return { ok: false, code: "no_extractable_text", message: "该类型不需要文本提取。" };
  } catch (error) {
    const failure = error instanceof ExtractionFailure ? error : classifyThrown(error);
    return { ok: false, code: failure.code, message: failure.message };
  }
}

/** 缓存载荷：结果 + 生成它的适配器版本。 */
export type ExtractionCachePayload = {
  extractorVersion: number;
  document: ExtractedDocument;
};

export { ExtractionFailure, corrupted, noExtractableText } from "./errors.js";
export type { ExtractionFailureCode } from "./errors.js";
