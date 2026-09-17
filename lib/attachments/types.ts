/**
 * 附件的共享类型（规格 2026-09-17 §8 / §9.1 / §11）。
 *
 * 这里定义的是**跨进程契约**：浏览器侧的合并状态、上传回执、消息 part、服务端
 * 存储记录都由同一组类型描述，避免历史上「图片一套、普通附件一套」的分叉再次发生。
 */

import type { AttachmentKind } from "./limits";

/** 合并后的附件状态机（规格 §8）。图片与文档走同一状态流。 */
export type ComposerAttachmentStatus = "preparing" | "uploading" | "processing" | "ready" | "error";

/** 可重试性由错误码决定，不由文案决定。 */
export type AttachmentErrorCode =
  | "unsupported_format"
  | "too_large"
  | "too_many"
  | "total_too_large"
  | "duplicate"
  | "empty_file"
  | "bad_name"
  | "network"
  | "server"
  | "password_protected"
  | "no_extractable_text"
  | "corrupted"
  | "ownership"
  | "not_found"
  | "aborted";

export type AttachmentError = {
  code: AttachmentErrorCode;
  message: string;
  retryable: boolean;
};

/** Composer 内的待发附件（规格 §8）。`attachmentId` 在上传成功前为空。 */
export type ComposerAttachment = {
  localId: string;
  attachmentId?: string;
  /** 服务端回执里的摘要；上传成功后由回执填入，供发送时构造描述符。 */
  sha256?: string;
  file: File;
  name: string;
  mediaType: string;
  size: number;
  kind: AttachmentKind;
  status: ComposerAttachmentStatus;
  progress?: number;
  error?: AttachmentError;
  /** 仅图片：用于缩略图的 object URL，移除时必须 revoke。 */
  previewUrl?: string;
};

/** 工作区引用（规格 §5.2）：与本地附件是两种产品语义，UI 上必须可区分。 */
export type WorkspaceReference = {
  path: string;
  kind: "file" | "directory";
  workspaceId: string;
};

/** 服务端上传回执（规格 §9.1）。 */
export type AttachmentReceipt = {
  attachmentId: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  kind: AttachmentKind;
  status: "processing" | "ready" | "error";
  extraction?: {
    pages?: number;
    sheets?: string[];
    slides?: number;
    characters?: number;
    warnings?: string[];
  };
  error?: AttachmentError;
};

/** 附件持久状态（服务端存储 + 消息 part 共用）。 */
export type AttachmentStatus = "processing" | "ready" | "error";

/** 消息 part 中引用的附件描述（规格 §11 `InputAttachmentRef`）。 */
export type InputAttachmentRef = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  kind: AttachmentKind;
};
