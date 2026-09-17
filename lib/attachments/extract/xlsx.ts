/**
 * Excel（.xlsx）提取（规格 2 §10.1 / §10.3 / §13）。
 *
 * 【定位是「工作表 + 单元格范围」】"Sheet1 A12:F30" 是用户在 Excel 里能直接框选出来的
 * 东西，也是唯一可核对的定位。所以每 200 行一个分节，范围取这一节里非空单元格的
 * **包围盒**——那正好是用户会框选的那个区域。
 *
 * 【公式只取缓存结果，绝不重算】按规格 §13「文档内嵌宏、外链和脚本不得执行」：
 * 重算公式等于执行文档里的表达式，而 Excel 的公式能调外部数据源。缓存结果缺失时
 * 就把公式原文交出去并说明，让用户知道这个格子是算出来的。
 *
 * 【表格过大的处理】§10.3 要求「提供 sheet/范围清单，由 Agent 按需读取」——所以
 * 超限不是报错，是把清单放进警告里、把每一段的行区间留在 locator 里。
 */

import type { ExtractedDocument } from "@zmzai/agent-framework";

import { ExtractionFailure } from "./errors";
import type { SectionDraft } from "./finalize";
import { finalizeDocument, splitLongText } from "./finalize";
import { gateZipBytes } from "./zip";

const MAX_SHEETS = 64;
const MAX_ROWS_PER_SHEET = 20_000;
const MAX_COLUMNS = 256;
const ROWS_PER_SECTION = 200;
/** 全表累计正文上限（远低于 framework 的 4M，留出余量给其它附件）。 */
const CHARS_BUDGET = 1_500_000;

export type XlsxExtractionInput = {
  attachmentId: string;
  bytes: Uint8Array;
};

/** 1 → A、27 → AA。 */
export function columnLetter(column: number): string {
  let value = column;
  let out = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

/**
 * 单元格 → 文本。
 *
 * 错误值（`#REF!`）原样保留：它本身就是要传达的信息，替换成空串会让用户以为格子是空的。
 * 超链接**只取显示文本、不取 URL**（§13 外链不访问、不传递）。
 */
export function valueToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
    if (Array.isArray(record.richText)) {
      return record.richText.map((run) => valueToText((run as { text?: unknown }).text)).join("");
    }
    if (typeof record.text === "string") return record.text;
    if ("formula" in record || "sharedFormula" in record) {
      const result = record.result;
      if (result === null || result === undefined) {
        const source = record.formula ?? record.sharedFormula;
        return typeof source === "string" ? `=${source}` : "";
      }
      return valueToText(result);
    }
  }
  return "";
}

/** 一段行区间 → 分节（范围 = 非空单元格包围盒）。 */
function sectionFor(sheetName: string, rows: RowRecord[]): SectionDraft | null {
  if (rows.length === 0) return null;
  const columns = rows.flatMap((row) => [row.min, row.max]).filter((value) => value > 0);
  if (columns.length === 0) return null;
  const min = Math.min(...columns);
  const max = Math.min(Math.max(...columns), MAX_COLUMNS);
  const body = rows
    .map((row) => {
      const cells: string[] = [];
      for (let column = min; column <= max; column += 1) cells.push(row.cells.get(column) ?? "");
      return cells.join("\t").replace(/\t+$/, "");
    })
    .join("\n");
  if (body.trim().length === 0) return null;
  const range = `${columnLetter(min)}${rows[0]!.number}:${columnLetter(max)}${rows[rows.length - 1]!.number}`;
  return { id: `${sheetName}!${range}`, locator: { sheet: sheetName, range }, text: body };
}

type RowRecord = { number: number; cells: Map<number, string>; min: number; max: number };

export async function extractXlsx(input: XlsxExtractionInput): Promise<ExtractedDocument> {
  const gate = gateZipBytes(input.bytes);
  if (!gate.ok) throw new ExtractionFailure(gate.code, gate.message);

  // exceljs 是 CJS 包：`default` 下才是命名空间，直接取 default 再回退
  const exceljs = await import("exceljs");
  const ExcelJS = exceljs.default ?? exceljs;
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(input.bytes) as unknown as ArrayBuffer);
  } catch {
    throw new ExtractionFailure("corrupted", "Excel 工作簿结构不完整，无法解析（可能已损坏、受密码保护或不是 .xlsx 格式）。");
  }

  const warnings: string[] = [];
  const sections: SectionDraft[] = [];
  let characters = 0;
  let formulaCount = 0;
  let hyperlinkCount = 0;
  let imageCount = 0;
  const truncatedSheets: string[] = [];

  const sheets = workbook.worksheets;
  if (sheets.length > MAX_SHEETS) {
    warnings.push(`工作簿含 ${sheets.length} 个工作表，本期只提取前 ${MAX_SHEETS} 个。`);
  }

  for (const sheet of sheets.slice(0, MAX_SHEETS)) {
    if (characters >= CHARS_BUDGET) {
      truncatedSheets.push(sheet.name);
      continue;
    }
    try {
      imageCount += typeof sheet.getImages === "function" ? sheet.getImages().length : 0;
    } catch {
      /* 图片清单拿不到不影响正文 */
    }

    let buffer: RowRecord[] = [];
    let rowsSeen = 0;
    let stopped = false;

    const flush = () => {
      const section = sectionFor(sheet.name, buffer);
      buffer = [];
      if (!section) return;
      for (const piece of splitLongText(section.text, section.locator, section.id)) {
        if (characters >= CHARS_BUDGET) {
          stopped = true;
          return;
        }
        sections.push(piece);
        characters += piece.text.length;
      }
    };

    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (stopped || rowsSeen >= MAX_ROWS_PER_SHEET) return;
      rowsSeen += 1;
      const cells = new Map<number, string>();
      let min = Number.POSITIVE_INFINITY;
      let max = 0;
      row.eachCell({ includeEmpty: false }, (cell, column) => {
        if (column > MAX_COLUMNS) return;
        const raw = cell.value;
        if (raw === null || raw === undefined) return;
        if (typeof raw === "object" && raw !== null && ("formula" in raw || "sharedFormula" in raw)) formulaCount += 1;
        if (typeof raw === "object" && raw !== null && typeof (raw as { hyperlink?: unknown }).hyperlink === "string") hyperlinkCount += 1;
        const text = valueToText(raw);
        if (text.length === 0) return;
        cells.set(column, text.replace(/[\t\r\n]+/g, " "));
        if (column < min) min = column;
        if (column > max) max = column;
      });
      if (cells.size === 0) return;
      buffer.push({ number: row.number, cells, min: min === Number.POSITIVE_INFINITY ? 0 : min, max });
      if (buffer.length >= ROWS_PER_SECTION) flush();
    });
    flush();

    if (rowsSeen >= MAX_ROWS_PER_SHEET) {
      truncatedSheets.push(sheet.name);
    }
  }

  if (imageCount > 0) warnings.push(`工作簿包含 ${imageCount} 张图片/图表，内容未纳入文本提取。`);
  if (formulaCount > 0) warnings.push(`工作簿含 ${formulaCount} 个公式，按缓存结果呈现，未重新计算。`);
  if (hyperlinkCount > 0) warnings.push(`工作簿含 ${hyperlinkCount} 处超链接，只保留显示文本，未访问链接目标。`);
  if (truncatedSheets.length > 0) {
    warnings.push(`工作表「${[...new Set(truncatedSheets)].join("、")}」超出提取上限，仅提取了前段；其余内容可按工作表与范围读取。`);
  }

  return finalizeDocument({
    attachmentId: input.attachmentId,
    sections,
    warnings,
  });
}
