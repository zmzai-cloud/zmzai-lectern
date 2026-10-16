/**
 * 记忆 outbox（K1 §2.3 写入链后半）：pending→sending→accepted→succeeded，
 * 网络失败同键指数退避 3 次→failed（手动重试）；unknown 只查 operationStatus
 * 不盲重发（提交途中断且无回执时保留待人工裁决——服务端幂等保证手动重发不重复）。
 *
 * 恢复扫描：sending 悬置（进程崩溃）→ unknown。accepted/unknown 有 operationId
 * 的轮询 operationStatus 收敛终态。401 暂停整轮（PAT 自愈后下轮续传）。
 */
import { createHash } from "node:crypto";

import { getMemoryBinding, openMemoryDb } from "./binding.js";
import { memoryAccountUserId } from "../settings.js";
import { createMemoryClient, type MemoryClient } from "./client.js";

export type OutboxState = "pending" | "sending" | "accepted" | "succeeded" | "failed" | "unknown" | "orphaned";

export type OutboxRow = {
  id: number;
  projectId: string;
  bindingVersion: number;
  idempotencyKey: string;
  state: OutboxState;
  attempts: number;
  lastError: string | null;
  operationId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** sending 悬置判定阈值：超过即视为提交途中断（进程崩溃/断流）。 */
const SENDING_STALE_MS = 90_000;
/** 网络失败退避：attempts=0（未发过）立即发，1 → 30s，2 → 120s。 */
function backoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return attempts === 1 ? 30_000 : 120_000;
}

export function outboxIdempotencyKey(bindingVersion: number, candidateId: number, statement: string): string {
  return createHash("sha256").update(`${bindingVersion}:${candidateId}:${statement}`).digest("hex");
}

/**
 * approved 候选入队（auto 档直通 + manual 审阅通过后的统一入口）。
 * 幂等：确定性 idempotencyKey + UNIQUE 约束，重复扫描零副作用。
 */
export function enqueueApprovedCandidates(projectId: string): number {
  const binding = getMemoryBinding(projectId);
  const accountUserId = memoryAccountUserId();
  if (!binding || binding.enabled !== 1 || !accountUserId || binding.accountUserId !== accountUserId) return 0;

  const db = openMemoryDb(projectId);
  const candidates = db
    .prepare("SELECT id, statement, kind, scope FROM memory_candidates WHERE projectId = ? AND status = 'approved'")
    .all(projectId) as Array<{ id: number; statement: string; kind: string; scope: string }>;

  const now = new Date().toISOString();
  let enqueued = 0;
  for (const candidate of candidates) {
    const payload = JSON.stringify({
      content: candidate.statement,
      tags: [candidate.kind, candidate.scope],
      context: JSON.stringify({ source: "lectern", candidateId: candidate.id }),
    });
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO memory_outbox (projectId, bindingVersion, idempotencyKey, payload, state, attempts, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(
        projectId,
        binding.bindingVersion,
        outboxIdempotencyKey(binding.bindingVersion, candidate.id, candidate.statement),
        payload,
        now,
        now,
      );
    if (result.changes === 1) enqueued += 1;
  }
  return enqueued;
}

export function listOutbox(projectId: string): Array<OutboxRow & { payload: { content: string; tags: string[] } }> {
  const rows = openMemoryDb(projectId)
    .prepare("SELECT * FROM memory_outbox WHERE projectId = ? ORDER BY id DESC LIMIT 100")
    .all(projectId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    projectId: String(row.projectId),
    bindingVersion: Number(row.bindingVersion),
    idempotencyKey: String(row.idempotencyKey),
    state: String(row.state) as OutboxState,
    attempts: Number(row.attempts),
    lastError: row.lastError == null ? null : String(row.lastError),
    operationId: row.operationId == null ? null : String(row.operationId),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    payload: JSON.parse(String(row.payload)) as { content: string; tags: string[] },
  }));
}

/** 手动重试：failed/unknown → pending（清退避与错误）。 */
export function retryOutboxRow(projectId: string, id: number): boolean {
  const result = openMemoryDb(projectId)
    .prepare("UPDATE memory_outbox SET state = 'pending', attempts = 0, lastError = NULL, updatedAt = ? WHERE id = ? AND projectId = ? AND state IN ('failed','unknown')")
    .run(new Date().toISOString(), id, projectId);
  return result.changes === 1;
}

export type DrainReport = { sent: number; succeeded: number; failed: number; paused: boolean };

export async function drainOutbox(projectId: string, client: Pick<MemoryClient, "retain" | "operationStatus"> = createMemoryClient()): Promise<DrainReport> {
  const report: DrainReport = { sent: 0, succeeded: 0, failed: 0, paused: false };
  const binding = getMemoryBinding(projectId);
  const accountUserId = memoryAccountUserId();
  if (!binding || binding.enabled !== 1 || !accountUserId || binding.accountUserId !== accountUserId) return report;

  const db = openMemoryDb(projectId);
  const now = new Date().toISOString();

  // 恢复扫描：sending 悬置 → unknown（提交后状态不明，等对账/人工）
  db.prepare("UPDATE memory_outbox SET state = 'unknown', lastError = 'interrupted', updatedAt = ? WHERE state = 'sending' AND updatedAt < ?")
    .run(now, new Date(Date.now() - SENDING_STALE_MS).toISOString());

  const select = (state: OutboxState) =>
    db.prepare("SELECT * FROM memory_outbox WHERE projectId = ? AND state = ? ORDER BY id LIMIT 20").all(projectId, state) as Array<Record<string, unknown>>;

  // accepted / unknown(有回执)：轮询 operationStatus 收敛终态
  for (const state of ["accepted", "unknown"] as const) {
    for (const row of select(state)) {
      const operationId = row.operationId == null ? null : String(row.operationId);
      if (!operationId) continue; // 无回执的 unknown：保留待人工（服务端幂等保证手动重发不重复）
      const status = await client.operationStatus(binding.bankId, operationId);
      if (!status.ok) continue; // 查询失败：下轮再查
      const upstream = String((status.data as { status?: unknown }).status ?? "");
      if (upstream === "succeeded" || upstream === "completed" || upstream === "success") {
        db.prepare("UPDATE memory_outbox SET state = 'succeeded', updatedAt = ? WHERE id = ?").run(now, Number(row.id));
        report.succeeded += 1;
      } else if (upstream === "failed" || upstream === "error") {
        db.prepare("UPDATE memory_outbox SET state = 'failed', lastError = ?, updatedAt = ? WHERE id = ?").run(`upstream: ${upstream}`, now, Number(row.id));
        report.failed += 1;
      }
    }
  }

  // pending 发送（退避到期才发；bindingVersion 不匹配的跳过——重绑后旧记录只标 orphaned，不在此路径）
  const due = select("pending").filter((row) => {
    const attempts = Number(row.attempts);
    const updatedAt = new Date(String(row.updatedAt)).getTime();
    return Date.now() - updatedAt >= backoffMs(attempts);
  });

  for (const row of due) {
    if (Number(row.bindingVersion) !== binding.bindingVersion) {
      db.prepare("UPDATE memory_outbox SET state = 'orphaned', lastError = 'binding replaced', updatedAt = ? WHERE id = ?").run(now, Number(row.id));
      continue;
    }
    const payload = JSON.parse(String(row.payload)) as { content: string; tags?: string[]; context?: string };
    const claimed = db.prepare(
      "UPDATE memory_outbox SET state = 'sending', updatedAt = ? WHERE id = ? AND projectId = ? AND state = 'pending' AND bindingVersion = ?",
    ).run(now, Number(row.id), projectId, binding.bindingVersion);
    if (claimed.changes !== 1) continue;

    const result = await client.retain(binding.bankId, payload.content, {
      idempotencyKey: String(row.idempotencyKey),
      async: true,
      ...(payload.tags?.length ? { tags: payload.tags } : {}),
      ...(payload.context ? { context: payload.context } : {}),
    });

    if (result.ok) {
      const operationId = (result.data as { operationId?: unknown }).operationId;
      if (typeof operationId === "string" && operationId) {
        db.prepare("UPDATE memory_outbox SET state = 'accepted', operationId = ?, attempts = attempts + 1, lastError = NULL, updatedAt = ? WHERE id = ? AND state = 'sending' AND bindingVersion = ?").run(operationId, now, Number(row.id), binding.bindingVersion);
      } else {
        // 未走 async（服务端同步完成）——直接终态
        db.prepare("UPDATE memory_outbox SET state = 'succeeded', attempts = attempts + 1, lastError = NULL, updatedAt = ? WHERE id = ? AND state = 'sending' AND bindingVersion = ?").run(now, Number(row.id), binding.bindingVersion);
        report.succeeded += 1;
      }
      report.sent += 1;
      continue;
    }

    if (result.kind === "unauthenticated") {
      // 401：PAT 失效，暂停本轮（不做失败计数）；Next 自动重签自愈后下轮续传
      db.prepare("UPDATE memory_outbox SET state = 'pending', lastError = 'UNAUTHENTICATED', updatedAt = ? WHERE id = ? AND state = 'sending' AND bindingVersion = ?").run(now, Number(row.id), binding.bindingVersion);
      report.paused = true;
      break;
    }

    const attempts = Number(row.attempts) + 1;
    if (attempts >= 3) {
      db.prepare("UPDATE memory_outbox SET state = 'failed', attempts = ?, lastError = ?, updatedAt = ? WHERE id = ? AND state = 'sending' AND bindingVersion = ?").run(attempts, result.kind, now, Number(row.id), binding.bindingVersion);
      report.failed += 1;
    } else {
      db.prepare("UPDATE memory_outbox SET state = 'pending', attempts = ?, lastError = ?, updatedAt = ? WHERE id = ? AND state = 'sending' AND bindingVersion = ?").run(attempts, result.kind, now, Number(row.id), binding.bindingVersion);
    }
  }

  return report;
}

/** 进程级 worker（60s 一轮：入队 approved + drain）。globalThis 守卫防热重载重复。 */
export function startMemoryOutboxWorker(projectId: string): void {
  const workers = ((globalThis as { __lecternMemoryWorkers?: Map<string, ReturnType<typeof setInterval>> }).__lecternMemoryWorkers ??= new Map());
  if (workers.has(projectId)) return;
  const tick = () => {
    try {
      enqueueApprovedCandidates(projectId);
    } catch {
      /* 入队失败不影响 drain */
    }
    return drainOutbox(projectId).catch(() => undefined);
  };
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref?.();
  workers.set(projectId, timer);
  void tick();
}

/** 测试专用。 */
export function resetMemoryWorkerForTest(): void {
  const workers = (globalThis as { __lecternMemoryWorkers?: Map<string, ReturnType<typeof setInterval>> }).__lecternMemoryWorkers;
  if (!workers) return;
  for (const timer of workers.values()) clearInterval(timer);
  workers.clear();
}
