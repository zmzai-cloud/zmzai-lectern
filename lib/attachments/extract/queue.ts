/**
 * 提取的调度与状态落库（规格 2 §7.3 / §10.3 / §14）。
 *
 * 【为什么提取不能在请求里同步做完】一份 300 页 PDF 要几秒到几十秒。放在上传请求里
 * 意味着用户盯着一个没有反馈的进度条，而且**一个 PDF 会占住整个请求**。所以上传只
 * 负责「存下字节 + 判定格式」，解析放到后台，状态从 `processing` 收敛到 `ready`
 * 或 `error`，前端按状态轮询（§7.4 每张卡独立显示解析状态）。
 *
 * 【为什么并发是 1】解析是内存与 CPU 都重的活：同时解十份 PDF 不会更快，只会让
 * 峰值内存乘十，而规格 §13 要求「解析失败不能拖垮主进程」。串行 + 上限，代价是
 * 大文件排队，收益是这份进程不会被用户一次拖十个文件搞死。
 *
 * 【为什么要有恢复扫描】进程在解析中途退出（更新、崩溃、用户强杀）会让记录永远卡在
 * `processing`——用户看到的是「一直转圈」，而重试按钮因为「不是 error」而不出现。
 * 所以每个项目第一次被访问时扫一遍超龄的 `processing`，重新排队。
 */

import type { ExtractedDocument } from "@zmzai/agent-framework";

import { EXTRACTOR_VERSION, extractionKindFor, runExtraction, type ExtractionCachePayload } from "./index.js";
import { summarize } from "./finalize.js";
import { formatForFilename } from "../limits.js";
import { readBlobBytes } from "../read.js";
import type { SqliteAttachmentStore, AttachmentRecord } from "../store.js";

/** 串行队列（模块级：一个 Node 进程内全局一份）。 */
type Job = { store: SqliteAttachmentStore; attachmentId: string };

declare global {
  // eslint-disable-next-line no-var
  var __lecternExtractionQueue: { pending: Job[]; running: boolean; swept: Set<string> } | undefined;
}

function queue() {
  return (globalThis.__lecternExtractionQueue ??= { pending: [], running: false, swept: new Set<string>() });
}

/** `processing` 超过这个时长视为「上一次进程死在中途」。 */
const STALE_PROCESSING_MS = 120_000;

/**
 * 排队解析一个附件（幂等：同一条记录重复入队只会跑一次）。
 */
export function scheduleExtraction(store: SqliteAttachmentStore, attachmentId: string): void {
  const state = queue();
  if (state.pending.some((job) => job.store === store && job.attachmentId === attachmentId)) return;
  state.pending.push({ store, attachmentId });
  void drain();
}

async function drain(): Promise<void> {
  const state = queue();
  if (state.running) return;
  state.running = true;
  try {
    while (state.pending.length > 0) {
      const job = state.pending.shift()!;
      await extractAttachment(job.store, job.attachmentId);
    }
  } finally {
    state.running = false;
  }
}

/**
 * 解析一个附件并把结果落库。
 *
 * 唯一的实现（后台队列与上传路径的同步快路径都调它），这样两条路径的状态与错误
 * 分类不可能分叉——分叉过一次的东西就是「为什么这个文件在选文件时能过、拖进来却
 * 报错」的来源。
 *
 * 前置：记录必须是 `processing`。其他状态一律跳过（`ready` 的重复入队、`error`
 * 的陈旧任务都不该覆盖已定下来的结论）。
 */
export async function extractAttachment(store: SqliteAttachmentStore, attachmentId: string): Promise<void> {
  const record = store.get(attachmentId);
  // 附件在排队期间被移除：直接跳过，不把已删记录写回去
  if (!record || record.status !== "processing") return;

  const kind = extractionKindFor(record.filename);
  if (kind === "none") {
    settleWithoutText(store, record);
    return;
  }

  const bytes = readBlobBytes(store, record.sha256);
  if (!bytes) {
    store.updateExtraction(record.id, {
      status: "error",
      error: { code: "corrupted", message: "附件文件已不可用（可能被外部清理）。", retryable: false },
      extraction: undefined,
    });
    return;
  }

  const outcome = await runExtraction({ attachmentId: record.id, filename: record.filename, bytes });
  if (outcome.ok) {
    store.saveExtractedDocument(record.sha256, { extractorVersion: EXTRACTOR_VERSION, document: outcome.document } satisfies ExtractionCachePayload);
    store.updateExtraction(record.id, {
      status: "ready",
      extraction: summarize(outcome.document),
      error: undefined,
    });
    return;
  }

  // 三类失败一律直接定论，**不自动重试**：解析是纯函数（同样的字节必然得到同样的
  // 结果），重试唯一可能改变的是「磁盘上的字节变了」，而那时更该让用户重新添加
  // 而不是在后台反复跑。§10.3「文件损坏：明确提示损坏，不无限重试」也是这个意思。
  store.updateExtraction(record.id, {
    status: "error",
    error: { code: outcome.code, message: outcome.message, retryable: false },
    extraction: undefined,
  });
}

/**
 * 不需要解析的附件：图片（走视觉输入，没有「文本正文」这回事）与本期不提取正文的
 * 旧格式（如 .xls）。
 *
 * 文案取自**格式表自己的 `note`**，不在这里另写一句：格式表已经为「接受但不提取」
 * 这个状态准备了给用户看的说明（含「另存为 .xlsx」这样的具体建议），两处各写一份
 * 迟早会分叉成两种说法。
 */
function settleWithoutText(store: SqliteAttachmentStore, record: AttachmentRecord): void {
  const note = record.kind === "image" ? undefined : formatForFilename(record.filename)?.note ?? "本期只保存该格式的文件、不提取正文。";
  store.updateExtraction(record.id, {
    status: "ready",
    error: undefined,
    ...(note ? { extraction: { warnings: [note] } } : {}),
  });
}

function summarizeForReceipt(document: ExtractedDocument) {
  return summarize(document);
}

/**
 * 恢复扫描：把卡在 `processing` 的超龄记录重新排队。
 *
 * 按项目做一次即可（`swept` 记在 globalThis 上，dev 热重载不会重复扫）。
 * 不主动扫全部项目：项目可能在别的进程里被访问，扫别人的库只会互相打架。
 */
export function resumeStaleExtractions(store: SqliteAttachmentStore): void {
  const state = queue();
  if (state.swept.has(store.dataDir)) return;
  state.swept.add(store.dataDir);
  const cutoff = Date.now() - STALE_PROCESSING_MS;
  for (const record of store.listProcessing()) {
    if (Date.parse(record.updatedAt) > cutoff) {
      // 还在处理窗口内：可能是本进程刚排上的任务，交给它自己跑完
      continue;
    }
    scheduleExtraction(store, record.id);
  }
}
