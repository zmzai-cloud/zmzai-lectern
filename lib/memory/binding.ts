/**
 * 项目记忆绑定（K1 §4.1）：binding/outbox/candidates/recall_log 四表落在
 * 每项目库 projects/<id>/zmzai.db（决策 A——Next/Host 两进程可达，dev 与
 * Host 兜底模式记忆均可用）。本模块只管 schema 与绑定语义；outbox 消费、
 * 候选管线在 T19 落地，这里先把表建好、把 rebind 的孤儿语义钉死。
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { dataDirFor, registeredProjects, type Project } from "../projects.js";
import { memoryApiBase } from "./origin.js";
import { ensureMemoryInstallNonce, memoryAccountUserId } from "../settings.js";
import type { MemoryClient } from "./client.js";

export type MemorySyncPolicy = "off" | "manual" | "auto";
export type MemoryBindingSource = "auto" | "manual";

export type MemoryBinding = {
  projectId: string;
  origin: string;
  bankId: string;
  bankName: string;
  accountUserId: string | null;
  bindingVersion: number;
  enabled: 0 | 1;
  syncPolicy: MemorySyncPolicy;
  source: MemoryBindingSource;
  permission: string;
  lastRecallAt: string | null;
  createdAt: string;
};

/** 桌面端专属 bank 前缀（与 agent 的 ws_ 约定区分，服务端同规则校验）。 */
export const LECTERN_BANK_PREFIX = "lec_";

/**
 * 默认 bankId 按安装 + 账户 + 项目命名空间，避免跨设备/用户碰撞。
 * 未绑定账户时仍可计算一个仅用于展示/迁移的 unbound id；实际自动建库必须
 * 传入并验证 accountUserId，绝不将该 id 与 PAT 绑定。
 */
export function deterministicBankId(projectId: string, accountUserId: string | null = memoryAccountUserId()): string {
  const nonce = ensureMemoryInstallNonce();
  return `${LECTERN_BANK_PREFIX}${createHash("sha256").update(`${nonce}:${accountUserId ?? "unbound"}:${projectId}`).digest("hex").slice(0, 24)}`;
}

/** 仅用于迁移识别旧版 bank，不向新绑定暴露。 */
export function legacyDeterministicBankId(projectId: string): string {
  return `${LECTERN_BANK_PREFIX}${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}`;
}

/** 句柄缓存按 db 绝对路径（跨 dataDir 的测试切换不串）。 */
const handles = new Map<string, DatabaseSync>();

export function openMemoryDb(projectId: string): DatabaseSync {
  const dir = dataDirFor({ id: projectId } as Project);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "zmzai.db");
  const cached = handles.get(file);
  if (cached) return cached;
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000");
  ensureTables(db);
  handles.set(file, db);
  return db;
}

function ensureTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_bindings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      projectId TEXT NOT NULL,
      origin TEXT NOT NULL,
      bankId TEXT NOT NULL,
      bankName TEXT NOT NULL,
      accountUserId TEXT,
      bindingVersion INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      syncPolicy TEXT NOT NULL DEFAULT 'manual' CHECK (syncPolicy IN ('off','manual','auto')),
      source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual')),
      permission TEXT NOT NULL DEFAULT 'write',
      lastRecallAt TEXT,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId TEXT NOT NULL,
      bindingVersion INTEGER NOT NULL,
      idempotencyKey TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','accepted','succeeded','failed','unknown','orphaned')),
      attempts INTEGER NOT NULL DEFAULT 0,
      lastError TEXT,
      operationId TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_outbox_state ON memory_outbox(state);
    CREATE TABLE IF NOT EXISTS memory_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId TEXT NOT NULL,
      statement TEXT NOT NULL,
      kind TEXT NOT NULL,
      evidence TEXT,
      scope TEXT NOT NULL DEFAULT 'project',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','discarded')),
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_recall_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      goalDigest TEXT NOT NULL,
      hitCount INTEGER NOT NULL,
      hits TEXT,
      usedTokens INTEGER,
      at TEXT NOT NULL
    );
  `);
}

function rowToBinding(row: Record<string, unknown>): MemoryBinding {
  return {
    projectId: String(row.projectId),
    origin: String(row.origin),
    bankId: String(row.bankId),
    bankName: String(row.bankName),
    accountUserId: row.accountUserId == null ? null : String(row.accountUserId),
    bindingVersion: Number(row.bindingVersion),
    enabled: Number(row.enabled) === 1 ? 1 : 0,
    syncPolicy: String(row.syncPolicy) as MemorySyncPolicy,
    source: String(row.source) as MemoryBindingSource,
    permission: String(row.permission),
    lastRecallAt: row.lastRecallAt == null ? null : String(row.lastRecallAt),
    createdAt: String(row.createdAt),
  };
}

export function getMemoryBinding(projectId: string): MemoryBinding | null {
  const row = openMemoryDb(projectId)
    .prepare("SELECT * FROM memory_bindings WHERE id = 1")
    .get() as Record<string, unknown> | undefined;
  return row ? rowToBinding(row) : null;
}

export type EnsureBindingResult =
  | { ok: true; binding: MemoryBinding; created: boolean; migrated?: boolean }
  | { ok: false; reason: "bank-create-failed" | "identity-required"; message?: string };

/**
 * 项目维度自动建库（设计 §2.5）：无 binding 时创建 lec_ bank 并绑定。
 * 幂等：已有 binding 直接返回；bankId 确定性派生 + 服务端同 owner 幂等，
 * 建库失败不落 binding，下个根目标自然重触发。
 */
export async function ensureAutoBinding(project: Pick<Project, "id" | "name">, client: Pick<MemoryClient, "createBank">, accountUserId = memoryAccountUserId()): Promise<EnsureBindingResult> {
  const existing = getMemoryBinding(project.id);
  if (existing) {
    if (!accountUserId) return { ok: false, reason: "identity-required", message: "请先完成账户身份验证" };
    if (existing.accountUserId === accountUserId) return { ok: true, binding: existing, created: false };
    // One-time migration for the legacy project-only auto bank. Never reuse the
    // legacy bank for a different account; create a namespaced bank and rebind.
    if (existing.source === "auto" &&
      (existing.accountUserId !== null || existing.bankId === legacyDeterministicBankId(project.id))) {
      const migratedBankId = deterministicBankId(project.id, accountUserId);
      const created = await client.createBank(migratedBankId, project.name);
      if (!created.ok) return { ok: false, reason: "bank-create-failed", message: "账户切换建库失败" };
      return {
        ok: true,
        binding: rebindMemory(project.id, { bankId: migratedBankId, bankName: project.name, source: "auto", accountUserId }, existing.bindingVersion),
        created: false,
        migrated: true,
      };
    }
    return { ok: false, reason: "identity-required", message: "手动绑定属于其他账户，需要重新选择知识库" };
  }

  if (!accountUserId) return { ok: false, reason: "identity-required", message: "请先完成账户身份验证" };
  const bankId = deterministicBankId(project.id, accountUserId);
  const created = await client.createBank(bankId, project.name);
  if (!created.ok) {
    return { ok: false, reason: "bank-create-failed", message: created.ok === false ? "message" in created ? created.message ?? String(created.kind) : String(created.kind) : undefined };
  }

  const now = new Date().toISOString();
  openMemoryDb(project.id)
    .prepare(
      `INSERT INTO memory_bindings (id, projectId, origin, bankId, bankName, accountUserId, bindingVersion, enabled, syncPolicy, source, permission, lastRecallAt, createdAt)
       VALUES (1, ?, ?, ?, ?, ?, 1, 1, 'manual', 'auto', 'write', NULL, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(project.id, memoryApiBase(), bankId, project.name, accountUserId, now);

  // 并发双触发时以先落库者为准（ON CONFLICT DO NOTHING），读回真值
  return { ok: true, binding: getMemoryBinding(project.id)!, created: true };
}

/**
 * 换绑（高级路径，含跨端共享 agent ws_ bank）：
 * - bindingVersion 递增；旧 outbox 未终态记录标 orphaned（spec：不得发往新 bank）
 * - 解绑 vs 服务端删除严格区分——本函数只动本地，删 bank 走网页管理台
 */
export function rebindMemory(
  projectId: string,
  next: { bankId: string; bankName: string; source: MemoryBindingSource; syncPolicy?: MemorySyncPolicy; accountUserId?: string | null },
  expectedBindingVersion?: number,
): MemoryBinding {
  const db = openMemoryDb(projectId);
  const existing = getMemoryBinding(projectId);
  if (expectedBindingVersion !== undefined && existing?.bindingVersion !== expectedBindingVersion) {
    throw Object.assign(new Error("binding changed concurrently"), { code: "BINDING_VERSION_CONFLICT" });
  }
  const version = (existing?.bindingVersion ?? 0) + 1;
  const now = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO memory_bindings (id, projectId, origin, bankId, bankName, accountUserId, bindingVersion, enabled, syncPolicy, source, permission, lastRecallAt, createdAt)
       VALUES (1, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'write', NULL, ?)
       ON CONFLICT(id) DO UPDATE SET bankId = excluded.bankId, bankName = excluded.bankName,
         accountUserId = excluded.accountUserId, bindingVersion = excluded.bindingVersion,
         syncPolicy = excluded.syncPolicy, source = excluded.source`,
    ).run(
      projectId,
      memoryApiBase(),
      next.bankId,
      next.bankName,
      next.accountUserId ?? null,
      version,
      next.syncPolicy ?? existing?.syncPolicy ?? "manual",
      next.source,
      now,
    );
    db.prepare(
      "UPDATE memory_outbox SET state = 'orphaned', lastError = 'binding replaced', updatedAt = ? WHERE projectId = ? AND state IN ('pending','sending','failed','unknown')",
    ).run(now, projectId);
    // Candidates approved under the old binding must never enter the new bank.
    // Keep their audit rows but remove approval; the user can explicitly review
    // them again under the new binding if desired.
    db.prepare("UPDATE memory_candidates SET status = 'discarded' WHERE projectId = ? AND status = 'approved'").run(projectId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getMemoryBinding(projectId)!;
}

export function setMemorySyncPolicy(projectId: string, syncPolicy: MemorySyncPolicy): void {
  openMemoryDb(projectId).prepare("UPDATE memory_bindings SET syncPolicy = ? WHERE id = 1").run(syncPolicy);
}

export function setMemoryEnabled(projectId: string, enabled: boolean): void {
  openMemoryDb(projectId).prepare("UPDATE memory_bindings SET enabled = ? WHERE id = 1").run(enabled ? 1 : 0);
}

/** Logout/account switch fence: disable every local binding and orphan unsent work. */
export function isolateMemoryAccount(): void {
  const now = new Date().toISOString();
  for (const project of registeredProjects()) {
    const db = openMemoryDb(project.id);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE memory_bindings SET accountUserId = NULL, enabled = 0, bindingVersion = bindingVersion + 1 WHERE id = 1").run();
      db.prepare("UPDATE memory_outbox SET state = 'orphaned', lastError = 'account switched', updatedAt = ? WHERE projectId = ? AND state IN ('pending','sending','failed','unknown')").run(now, project.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function recordRecall(
  projectId: string,
  entry: { sessionId: string; goalDigest: string; hitCount: number; hits?: unknown; usedTokens?: number },
): void {
  openMemoryDb(projectId)
    .prepare(
      "INSERT INTO memory_recall_log (projectId, sessionId, goalDigest, hitCount, hits, usedTokens, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      projectId,
      entry.sessionId,
      entry.goalDigest,
      entry.hitCount,
      entry.hits === undefined ? null : JSON.stringify(entry.hits),
      entry.usedTokens ?? null,
      new Date().toISOString(),
    );
}

/** 测试专用：清句柄缓存（vitest 文件级共享 dataDir 约定的配套）。 */
export function resetMemoryDbHandlesForTest(): void {
  handles.clear();
}
