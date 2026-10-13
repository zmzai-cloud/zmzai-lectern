/**
 * 记忆召回服务（K1 §2.2）：framework memoryContextFor 钩子的 Lectern 实现。
 *
 * 钩子每个 attempt 都会被 ContextBuilder 调用，本模块内部按 sessionId 缓存
 * 命中结果（根目标一次；条目绑定 bankId，换绑自动失效）实现 spec「新根目标
 * 召回一次、内部续跑复用」。子代理会话（ses_sub_）不注入——结论由父归并。
 * 一切失败（未接通/超时/401/建库失败）返回 undefined：任务无记忆照常运行。
 */
import { createHash } from "node:crypto";

import { memoryPat } from "../settings.js";
import type { Project } from "../projects.js";
import { ensureAutoBinding, getMemoryBinding, recordRecall } from "./binding.js";
import { createMemoryClient, type MemoryRecallHit } from "./client.js";

const client = createMemoryClient();

const RECALL_MAX_TOKENS = 2000;
const RECALL_MAX_FACTS = 12;
const QUERY_MAX_CHARS = 400;
const CACHE_MAX_ENTRIES = 64;

type CacheEntry = { bankId: string; section: string | undefined; hits: MemoryRecallHit[] };

const cache = new Map<string, CacheEntry>();

export type RecallSectionDeps = {
  /** 测试注入：替换 binding/client/settings 行为 */
  getBinding: typeof getMemoryBinding;
  ensureBinding: typeof ensureAutoBinding;
  recall: typeof client.recall;
  record: typeof recordRecall;
  pat: () => string | null;
};

export async function recallSection(
  project: Pick<Project, "id" | "name">,
  sessionId: string,
  text: string,
  deps?: RecallSectionDeps,
): Promise<string | undefined> {
  // 子代理不注入长期记忆（spec §13.3：子结论由父归并去重）
  if (sessionId.startsWith("ses_sub_")) return undefined;

  const get = deps?.getBinding ?? getMemoryBinding;
  let binding = get(project.id);

  if (!binding) {
    // 未接通不建库（无 PAT 的 createBank 必失败，白打）；接通后首个根目标补建
    const pat = (deps?.pat ?? memoryPat)();
    if (!pat) return undefined;
    const ensured = await (deps?.ensureBinding ?? ensureAutoBinding)(project, client);
    if (!ensured.ok) return undefined;
    binding = ensured.binding;
  }
  if (!binding.enabled) return undefined;

  // 根目标级缓存：同 session 命中且 bank 未换 → 直接复用（换绑条目失效）
  const cached = cache.get(sessionId);
  if (cached && cached.bankId === binding.bankId) return cached.section;

  const recall = deps?.recall ?? client.recall.bind(client);
  const result = await recall(binding.bankId, text.slice(0, QUERY_MAX_CHARS), { maxTokens: RECALL_MAX_TOKENS });
  if (!result.ok) return undefined; // 超时/401/网络——无记忆继续，不缓存失败

  const hits = result.data.hits.slice(0, RECALL_MAX_FACTS);
  const section =
    hits.length === 0
      ? undefined
      : [
          `## 项目记忆（自动召回自「${binding.bankName}」，可能过期——以当前代码与用户指令为准）`,
          "",
          ...hits.map((hit) => `- ${hit.text}${hit.memoryId ? ` [id:${hit.memoryId}]` : ""}`),
        ].join("\n");

  // LRU：超容量淘汰最旧条目
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(sessionId, { bankId: binding.bankId, section, hits });

  const record = deps?.record ?? recordRecall;
  record(project.id, {
    sessionId,
    goalDigest: createHash("sha256").update(text).digest("hex").slice(0, 16),
    hitCount: hits.length,
    hits,
  });

  return section;
}

/** rewind / 会话回退后显式失效（下个 attempt 重召）。 */
export function invalidateMemoryForSession(sessionId: string): void {
  cache.delete(sessionId);
}

/** 测试专用。 */
export function resetMemoryCacheForTest(): void {
  cache.clear();
}
