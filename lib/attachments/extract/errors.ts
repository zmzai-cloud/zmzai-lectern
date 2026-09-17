/**
 * 提取失败的分类（规格 2 §10.3）。
 *
 * 【为什么错误要分类而不是一个 "解析失败"】三类失败对用户意味着完全不同的下一步：
 * 密码保护要换一份未加密副本、扫描件无文本要改用图片或文字版、文件损坏要重新导出。
 * 统一成「解析失败，请重试」会让用户做无效的重试，也让 UI 无法给出正确的可重试性
 * （重试一个密码保护的 PDF 一百次结果都一样）。
 *
 * 与 `AttachmentErrorCode` 的取值一一对应，host 侧把它翻成回执里的 `error`。
 */

export type ExtractionFailureCode = "password_protected" | "no_extractable_text" | "corrupted";

/** 重试永远不会改变结果的三类失败。 */
export class ExtractionFailure extends Error {
  readonly code: ExtractionFailureCode;

  constructor(code: ExtractionFailureCode, message: string) {
    super(message);
    this.name = "ExtractionFailure";
    this.code = code;
  }
}

export function passwordProtected(detail?: string): ExtractionFailure {
  return new ExtractionFailure(
    "password_protected",
    detail ?? "文件受密码保护，无法读取内容。请提供未加密的副本后重新添加。",
  );
}

export function noExtractableText(detail?: string): ExtractionFailure {
  return new ExtractionFailure("no_extractable_text", detail ?? "未检测到可提取文本（可能是扫描件或纯图片文档）。");
}

export function corrupted(detail?: string): ExtractionFailure {
  return new ExtractionFailure("corrupted", detail ?? "文件已损坏或不是有效的文档结构，无法解析。");
}

/**
 * 把任意异常归一成 `ExtractionFailure`。
 *
 * 解析库抛出的错误信息里可能带文件内容片段（§13：日志与回执不得含正文），所以
 * 对外文案一律用我们自己的话，原始信息只保留错误类型名用于判断。
 */
export function classifyThrown(error: unknown): ExtractionFailure {
  if (error instanceof ExtractionFailure) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  // pdfjs 的密码错误类型名固定为 PasswordException；不同版本措辞不同，按名字判。
  if (name === "PasswordException" || /password/i.test(message)) return passwordProtected();
  if (name === "InvalidPDFException" || /invalid pdf|not a pdf/i.test(message)) return corrupted("PDF 文件已损坏或结构不完整，无法解析。");
  return corrupted();
}
