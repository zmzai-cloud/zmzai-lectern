/**
 * 读取附件原始字节（规格 2 §9.2）。
 *
 * 【为什么解析路径用同步读】解析本身就是同步的重活（pdfjs 与 exceljs 都会占住
 * 事件循环数十到数百毫秒），把 25MB 的读盘拆成异步流只是让「已经阻塞的循环」多切
 * 几次上下文，收益是零。同步读一次反而更简单，也避免流读一半失败时的半截状态。
 * 交互路径（下载/预览）仍走流式，那里要的是不占内存而不是简单。
 */

import { existsSync, readFileSync } from "node:fs";

import type { SqliteAttachmentStore } from "./store.js";

/** 读 blob 全部字节；文件不存在或读取失败返回 null（历史消息仍要能渲染，§12）。 */
export function readBlobBytes(store: SqliteAttachmentStore, sha256: string): Uint8Array | null {
  const path = store.blobPath(sha256);
  if (!existsSync(path)) return null;
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    return null;
  }
}
