/**
 * 附件分类与前置校验（规格 2026-09-17 §6 / §13 / §17.1）。
 *
 * 全部是纯函数，不含 DOM 与 node API，便于：
 * ① 前端在把文件交给上传队列之前给出**具体**拒绝原因（不是静默丢弃）；
 * ② 服务端用同一套函数复核（不信任客户端结论）；
 * ③ 单测直接喂普通对象，不必构造真 File。
 */

import {
  ATTACHMENT_LIMITS,
  formatForFilename,
  formatForMediaType,
  mediaTypeForFilename,
  type AttachmentFormat,
  type AttachmentKind,
} from "./limits";
import type { AttachmentError, AttachmentErrorCode } from "./types";

/** 判定所需的最小子集。真实 `File` 天然满足。 */
export type FileLike = { name: string; type?: string; size?: number };

export type ClassifiedFile = {
  /** 净化后的 basename（已去路径、去控制字符）。 */
  name: string;
  kind: AttachmentKind;
  /** 声明 MIME；浏览器没给时回退到格式表首选值。 */
  mediaType: string;
  format: AttachmentFormat;
};

export type Classification =
  | { ok: true; value: ClassifiedFile }
  | { ok: false; error: AttachmentError };

function fail(code: AttachmentErrorCode, message: string, retryable = false): { ok: false; error: AttachmentError } {
  return { ok: false, error: { code, message, retryable } };
}

/**
 * 只保留 basename 并剔除危险字符（规格 §13）。
 * Windows 路径用 `\`、POSIX 用 `/`，两种分隔符都要切断——一旦漏掉 `\`，
 * 在 macOS 上写日志/展示时会把整个 `C:\Users\…` 暴露出去。
 */
export function sanitizeFilename(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // 控制字符（含 NUL）与路径分隔符：先按分隔符取最后一段，再剔除控制字符。
  const lastSegment = raw.split(/[/\\]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = lastSegment.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  if (cleaned.length > ATTACHMENT_LIMITS.maxFilenameLength) return null;
  return cleaned;
}

/**
 * 识别文件类型（规格 §6）。**只做早期提示**：扩展名与声明 MIME 冲突时以扩展名
 * 归属格式，但服务端仍会按内容嗅探复核——客户端结论不可信。
 */
export function classifyFile(input: FileLike): Classification {
  const name = sanitizeFilename(input.name);
  if (!name) return fail("bad_name", "文件名不合法（含路径、控制字符或超长），已拒绝");

  const byExtension = formatForFilename(name);
  const byMediaType = formatForMediaType(input.type ?? "");
  const format = byExtension ?? byMediaType;

  if (!format) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
    return fail(
      "unsupported_format",
      ext ? `暂不支持 ${ext} 格式，已拒绝「${name}」` : `无法识别「${name}」的文件类型（缺少扩展名）`,
    );
  }
  if (byExtension && byMediaType && byExtension.id !== byMediaType.id) {
    // 扩展名与浏览器声明不一致：按扩展名处理，由服务端内容嗅探最终裁决（§6）。
    // 这里不拒绝——macOS 上常见 `file.type` 为空串或 `application/octet-stream`。
    return { ok: true, value: { name, kind: format.kind, mediaType: mediaTypeForFilename(name, format), format } };
  }
  // mediaType 一律由扩展名推导，不采信 `input.type`（§19：不得信任客户端 MIME）。
  // 服务端落库时会用内容嗅探结果覆盖它。
  return { ok: true, value: { name, kind: format.kind, mediaType: mediaTypeForFilename(name, format), format } };
}

/** 已选附件的去重/计数依据（只需要名字与大小）。 */
export type ExistingAttachment = { name: string; size: number };

/**
 * 追加一个文件前的完整校验（规格 §6 / §17.1.4）。
 * 顺序刻意固定：类型 → 空文件 → 单文件大小 → 数量 → 重复 → 总量。
 * 先报类型错能避免用户为「不支持的文件」去删别的文件腾位置。
 */
export function validateClientFile(
  input: FileLike,
  currentAttachments: readonly ExistingAttachment[] = [],
): Classification {
  const classified = classifyFile(input);
  if (!classified.ok) return classified;

  const { value } = classified;
  const size = input.size ?? value.format.maxBytes + 1;
  if (size <= 0) return fail("empty_file", `「${value.name}」是空文件（0 字节），已拒绝`);

  if (size > value.format.maxBytes) {
    return fail(
      "too_large",
      `「${value.name}」${formatMB(size)} 超过 ${value.format.label} 的 ${formatMB(value.format.maxBytes)} 上限`,
    );
  }
  if (currentAttachments.length >= ATTACHMENT_LIMITS.maxLocalPerMessage) {
    return fail("too_many", `每条消息最多 ${ATTACHMENT_LIMITS.maxLocalPerMessage} 个附件，请先移除一些文件`);
  }
  if (currentAttachments.some((item) => item.name === value.name && item.size === size)) {
    return fail("duplicate", `「${value.name}」已在附件列表中，未重复添加`);
  }
  const total = currentAttachments.reduce((sum, item) => sum + item.size, 0) + size;
  if (total > ATTACHMENT_LIMITS.maxTotalBytesPerMessage) {
    return fail(
      "total_too_large",
      `本条消息附件合计 ${formatMB(total)}，超过 ${formatMB(ATTACHMENT_LIMITS.maxTotalBytesPerMessage)} 上限，请移除部分文件`,
    );
  }
  return { ok: true, value };
}

/** 校验工作区引用路径（规格 §5.2 / §13）：只接受相对路径，且不含穿越段。 */
export function validateReferencePath(raw: unknown): { ok: true; path: string } | { ok: false; error: AttachmentError } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) {
    return { ok: false, error: { code: "bad_name", message: "引用路径不合法", retryable: false } };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return { ok: false, error: { code: "bad_name", message: "引用路径含控制字符", retryable: false } };
  }
  // 绝对路径（含 Windows 盘符）与 `..` 穿越一律拒绝；工作区穿越由 resolveWithinWorkspace 兜底。
  if (/^([a-zA-Z]:|[\\/])/.test(raw) || raw.split(/[/\\]/).includes("..")) {
    return { ok: false, error: { code: "bad_name", message: "引用路径必须位于当前工作区内", retryable: false } };
  }
  return { ok: true, path: raw.replace(/\\/g, "/").replace(/^\.\//, "") };
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}
