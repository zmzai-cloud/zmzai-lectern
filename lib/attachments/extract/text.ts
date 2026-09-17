/**
 * 纯文本类附件的提取：text / csv / tsv（规格 2 §10.1）。
 *
 * 【为什么 CSV 要自己解析分隔符】朴素的「按行 split」在带引号字段上会错：一个
 * 含逗号或换行的单元格（`"北京, 朝阳"`）会把一行切成两行，此后**所有行号都是错的**
 * ——而行号正是 CSV 唯一的定位方式。既然定位必须可核对，就必须按引号规则切。
 *
 * 【为什么文本行号就是定位】文本文件里没有「页」也没有「工作表」，行号是用户和
 * 编辑器都能直接跳到的东西。CSV 额外把行号渲染进正文（`行 1-200`），这样模型
 * 引用「第 137 行」时用户能在 Excel 里找到同一行。
 */

import type { SectionDraft } from "./finalize";
import { finalizeDocument, splitLongText } from "./finalize";
import type { ExtractedDocument } from "@zmzai/agent-framework";

import { corrupted } from "./errors";

/** 每个分节覆盖的记录数：小到模型能按「行区间」精准读取，大到不会产生上千个分节。 */
const RECORDS_PER_SECTION = 200;
/** 记录总数上限（真实文件极少超过；超出时截断并写明）。 */
const MAX_RECORDS = 50_000;

export type PlainTextInput = {
  attachmentId: string;
  filename: string;
  bytes: Uint8Array;
  /** CSV/TSV 用；纯文本不传。 */
  delimiter?: "," | "\t";
};

/**
 * 解码 UTF-8。
 *
 * 严格模式失败时不猜编码、不做字符集探测：猜错编码的后果是把大量正文变成乱码
 * 却看起来「解析成功」，而模型完全无法分辨。宁可原样存下带替换字符的文本并给出
 * 明确警告，让用户自己另存为 UTF-8 再传一次。
 */
function decodeText(bytes: Uint8Array): { text: string; warning?: string } {
  const body = bytes.subarray(0, Math.min(bytes.length, 12 * 1024 * 1024));
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body) };
  } catch {
    const lossy = new TextDecoder("utf-8").decode(body);
    return {
      text: lossy,
      warning: "文件不是合法的 UTF-8 文本，部分字符已用替换符显示。请另存为 UTF-8 编码后重新添加。",
    };
  }
}

/** 按引号规则切记录；引号内的分隔符与换行都属于单元格内容。 */
export function splitRecords(text: string, delimiter: string, maxRecords: number): { records: string[][]; truncated: boolean } {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let truncated = false;

  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[at + 1] === '"') {
          field += '"';
          at += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      endField();
      continue;
    }
    if (char === "\n") {
      endRecord();
      if (records.length >= maxRecords) {
        truncated = true;
        return { records, truncated };
      }
      continue;
    }
    if (char === "\r") continue;
    field += char;
  }
  if (field.length > 0 || record.length > 0) endRecord();
  return { records, truncated };
}

/** 文本/CSV/TSV → 提取结果。行号即 locator（规格 §10.1 的 lineStart/lineEnd）。 */
export function extractPlainText(input: PlainTextInput): ExtractedDocument {
  if (input.bytes.byteLength === 0) throw corrupted("文件为空。");
  const { text, warning } = decodeText(input.bytes);
  const warnings: string[] = [];
  if (warning) warnings.push(warning);

  if (!input.delimiter) {
    const lines = text.split(/\r\n|\r|\n/);
    const sections: SectionDraft[] = [];
    for (let start = 0; start < lines.length; start += RECORDS_PER_SECTION) {
      const end = Math.min(lines.length, start + RECORDS_PER_SECTION);
      const body = lines.slice(start, end).join("\n");
      if (body.trim().length === 0) continue;
      const locator = { lineStart: start + 1, lineEnd: end };
      sections.push(...splitLongText(body, locator, `l${start + 1}`));
    }
    return finalizeDocument({
      attachmentId: input.attachmentId,
      title: input.filename,
      sections,
      warnings: [
        ...warnings,
        ...(lines.length > RECORDS_PER_SECTION ? [`文件共 ${lines.length} 行，请按行号区间读取需要的部分。`] : []),
      ],
    });
  }

  const { records, truncated } = splitRecords(text, input.delimiter, MAX_RECORDS);
  if (truncated) warnings.push(`记录数超过 ${MAX_RECORDS} 上限，其余记录未纳入。`);
  const rendered = records.map((record) => record.join("\t"));
  const sections: SectionDraft[] = [];
  for (let start = 0; start < rendered.length; start += RECORDS_PER_SECTION) {
    const end = Math.min(rendered.length, start + RECORDS_PER_SECTION);
    const body = rendered.slice(start, end).join("\n");
    if (body.trim().length === 0) continue;
    const locator = { lineStart: start + 1, lineEnd: end };
    sections.push(...splitLongText(body, locator, `r${start + 1}`));
  }
  const columns = records[0]?.length ?? 0;
  return finalizeDocument({
    attachmentId: input.attachmentId,
    title: input.filename,
    sections,
    warnings: [
      ...warnings,
      ...(records.length > RECORDS_PER_SECTION
        ? [`文件共 ${records.length} 行${columns > 0 ? `、${columns} 列` : ""}，请按行号区间读取需要的部分。`]
        : []),
    ],
  });
}
