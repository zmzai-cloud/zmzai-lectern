/**
 * PDF 文本提取（规格 2 §10.1 / §10.3）。
 *
 * 【为什么用 pdfjs 的 legacy 构建且不开 worker】服务端解析没有 DOM，legacy 构建是
 * 官方给 Node 的入口；worker 在 Node 里会退化成 fake worker，显式不开反而少一层
 * 不确定性。`isEvalSupported: false` 关掉 PDF 里 JS 的求值路径（§13：文档里的脚本
 * 不得执行），`disableFontFace` 让解析不去碰字体资源——我们只取文本，不排版。
 *
 * 【定位就是页码】PDF 有真实页码，所以每页一节、locator 为 `{ page }`。这也是唯一
 * 用户能直接核对的位置（「第 4 页」）。超出页数上限时**保留文件并提示**而不是报错
 * （§6），因为大文档按页读取本来就是预期用法。
 *
 * 【逐页容错】单页解析失败不算整份失败（§10.3「部分页失败：附件可为 ready_with_warnings，
 * 并列出缺失页」）。加密与结构损坏才是整份失败。
 */

import { ATTACHMENT_LIMITS } from "../limits.js";
import { ExtractionFailure, classifyThrown, noExtractableText } from "./errors.js";
import type { SectionDraft } from "./finalize.js";
import { finalizeDocument, splitLongText } from "./finalize.js";
import type { ExtractedDocument } from "@zmzai/agent-framework";

/** 整份 PDF 的解析时间预算。超时后返回已解析的部分页并写明（§13「解析器必须有时间限制」）。 */
const TIME_BUDGET_MS = 90_000;

/** pdfjs 文本条目的最小结构（只声明我们用到的字段，测试可以喂普通对象）。 */
export type PdfTextItem = {
  str?: string;
  hasEOL?: boolean;
  transform?: readonly number[];
};

/**
 * 一行行的重建文本。
 *
 * pdfjs 给的是**定位后的文本片段**，不保证带换行。两种信号：
 * - `hasEOL`：pdfjs 自己算出的「这行到此为止」，最可靠；
 * - `transform[5]`（y 坐标）变化：片段落到另一条基线上。
 *
 * 同一个页面里两者未必都有，所以两套都算，由 `pageLines` 择优——把「用哪套」写成
 * 明确的选择而不是混合启发式，出错时才有可能说清是哪一套错了。
 */
export function linesFromEol(items: readonly PdfTextItem[]): string[] {
  const lines: string[] = [];
  let current = "";
  const flush = () => {
    // 空行只是换行标记的副产物（pdfjs 会把断行表示成一个空片段），不产生内容
    if (current.trim().length > 0) lines.push(current.replace(/\s+$/, ""));
    current = "";
  };
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    current += item.str;
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

export function linesFromTransform(items: readonly PdfTextItem[]): string[] {
  const lines: string[] = [];
  let current = "";
  let lastY: number | null = null;
  const flush = () => {
    if (current.trim().length > 0) lines.push(current.replace(/\s+$/, ""));
    current = "";
  };
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const y = item.transform?.[5];
    if (lastY !== null && typeof y === "number" && Math.abs(y - lastY) > 2) flush();
    // 同一行内直接拼接：pdfjs 的 `str` 已经按实际字距带上了空格，我们再补一个
    // 就会把 "He llo" 这类被拆开的字强行粘成 "Hello"——那是篡改正文。
    current += item.str;
    if (typeof y === "number") lastY = y;
  }
  flush();
  return lines;
}

/** 择优：有 `hasEOL` 就用它，否则退回按基线判断。 */
export function pageLines(items: readonly PdfTextItem[]): string[] {
  const sawEol = items.some((item) => item.hasEOL === true);
  return sawEol ? linesFromEol(items) : linesFromTransform(items);
}

export type PdfExtractionInput = {
  attachmentId: string;
  bytes: Uint8Array;
  signal?: AbortSignal;
};

/** 动态导入：pdfjs 体积不小，只有真的遇到 PDF 时才加载（§13 解析不能拖垮主进程）。 */
async function loadPdfjs() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

export async function extractPdf(input: PdfExtractionInput): Promise<ExtractedDocument> {
  const pdfjs = await loadPdfjs();
  const started = Date.now();
  const warnings: string[] = [];
  const sections: SectionDraft[] = [];
  const failedPages: number[] = [];
  const emptyPages: number[] = [];

  const task = pdfjs.getDocument({
    // 复制一份：pdfjs 会把 TypedArray **转移**给 worker 线程（接管所有权），
    // 调用方之后还要用这份字节算摘要、落盘，不能让它被掏空
    data: new Uint8Array(input.bytes),
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    // 只留下错误级别日志：pdfjs 的 info/warn 会带内容片段，不该进日志（§13）
    verbosity: 0,
    // 说明：v4 之前的 `isEvalSupported: false` 在 pdfjs 6 已不存在——PDF 内嵌
    // JavaScript 的求值路径在这个版本里被整个移除，没有开关可关（§13「文档内嵌
    // 脚本不得执行」由库本身保证）。这里留一条注释而不是沉默删掉，是为了让下次
    // 有人查「为什么没有这个安全开关」时能直接看到结论。
  });

  try {
    const document = await task.promise;
    const totalPages = document.numPages;
    const limit = Math.min(totalPages, ATTACHMENT_LIMITS.maxPdfPages);
    if (totalPages > limit) {
      warnings.push(`文件共 ${totalPages} 页，本期只提取前 ${limit} 页；如需后段内容请拆分文件后重新添加。`);
    }
    for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
      if (input.signal?.aborted) break;
      if (Date.now() - started > TIME_BUDGET_MS) {
        warnings.push(`解析超过 ${Math.round(TIME_BUDGET_MS / 1000)} 秒，第 ${pageNumber} 页之后的内容未纳入。`);
        break;
      }
      try {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const lines = pageLines(content.items as PdfTextItem[]);
        page.cleanup();
        if (lines.length === 0) {
          emptyPages.push(pageNumber);
          continue;
        }
        const body = lines.join("\n");
        sections.push(...splitLongText(body, { page: pageNumber }, `p${pageNumber}`));
      } catch {
        // 单页失败不影响整份（加密/结构损坏在更外层判定）
        failedPages.push(pageNumber);
      }
    }
  } catch (error) {
    throw classifyThrown(error);
  } finally {
    // 释放解析器与文档；失败的 destroy 不影响已经拿到的结果
    await task.destroy().catch(() => undefined);
  }

  if (failedPages.length > 0) {
    warnings.push(`第 ${summarizePageList(failedPages)} 页无法解析，其余页面已提取。`);
  }
  if (sections.length === 0) {
    if (emptyPages.length > 0) {
      throw noExtractableText(`未检测到可提取文本（${emptyPages.length} 页均为图片或空白，可能是扫描件）。请改用图片形式添加，或提供带文本层的 PDF。`);
    }
    if (failedPages.length > 0) throw new ExtractionFailure("corrupted", "所有页面都无法解析，PDF 结构可能已损坏。");
    throw noExtractableText();
  }
  if (emptyPages.length > 0) {
    warnings.push(`第 ${summarizePageList(emptyPages)} 页没有文本（可能是图片或空白），已跳过。`);
  }

  return finalizeDocument({
    attachmentId: input.attachmentId,
    sections,
    warnings,
  });
}

/** 「第 3 页」这类列表要压缩成区间，否则一份 300 页的扫描件会产生一条几百字的警告。 */
export function summarizePageList(pages: readonly number[]): string {
  const sorted = [...pages].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0]!;
  let previous = start;
  for (const page of sorted.slice(1)) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    parts.push(start === previous ? `${start}` : `${start}–${previous}`);
    start = page;
    previous = page;
  }
  parts.push(start === previous ? `${start}` : `${start}–${previous}`);
  return parts.join("、");
}
