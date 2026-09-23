/**
 * Lectern「本地可信交付」P0 核心：TaskDelivery / 不可变 DeliveryAttempt 的
 * 持久化、验证快照、Git CAS 合并，以及服务端 owner 推导。
 *
 * 对应设计文档「交付模型」与「API 与模块边界」中的 lib/delivery.ts。
 *
 * 安全不变量（P0 必须守住）：
 * - DeliveryOwner 由服务端从「sessionId -> worktree/项目映射」推导，
 *   绝不信任客户端提交的 projectId / sessionId / root / artifact path / 父子关系。
 * - 验证快照以临时 Git index 物化 immutable delivery commit，不改用户 worktree。
 * - 合并是 compare-and-swap：只从 immutable delivery commit 建 merge commit，
 *   并以 `git update-ref <baseRef> <mergeCommit> <verifiedBaseHeadSha>` 原子更新 ref；
 *   任何 base 并发推进、源快照变化或 ref precondition 失败均拒绝。
 * - snapshot_stale 的 attempt 永不可接受；no_required_checks 可二次确认后走同一 CAS。
 */
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { dataDir } from "./runtime-constants.js";
import { resolveCwdWithin } from "./delivery-path.js";
import { worktreeForSession } from "./worktree.js";
import { resolveSessionOwner } from "./session-owner.js";
import { WorkflowError } from "./workflow-error.js";
import { integrateWorkspace, markReadyForReview, workspaceRecordForSession } from "./workspace-service.js";
import {
  casUpdateRef,
  currentBranch,
  git,
  headSha,
  isGitRepo,
  listChangedPaths,
  materializeDeliveryCommit,
  worktreeFingerprint,
} from "./delivery-git.js";
import {
  assertTransition,
  canAccept,
  resolveVerificationStatus,
} from "./delivery-state.js";
import type {
  CommandRun,
  DeliveryAttempt,
  DeliveryMergeRejectReason,
  DeliveryMergeResult,
  DeliveryOwner,
  DeliverySnapshot,
  DeliveryStatus,
  TaskDelivery,
} from "./delivery-types.js";


/** 交付数据目录（delivery.db 与临时 index / 输出都放这里）。 */
const deliveryDataDir = () => join(resolve(dataDir), "deliveries");

let db: DatabaseSync | null = null;

/** deliveries.db 连接（browser-verification 等交付族模块共享同一句柄，
 *  避免同进程多实例写同一文件的锁冲突）。 */
export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(deliveryDataDir(), { recursive: true });
  db = new DatabaseSync(join(deliveryDataDir(), "deliveries.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      effective_workspace_root TEXT NOT NULL,
      base_ref TEXT,
      worktree_branch TEXT,
      active_attempt_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS delivery_attempts (
      id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      status TEXT NOT NULL,
      unverified_reason TEXT,
      approved_execution_plan_id TEXT,
      verification_snapshot TEXT,
      supersedes_attempt_id TEXT,
      superseded_at TEXT,
      changed_paths TEXT NOT NULL,
      summary TEXT,
      risks TEXT NOT NULL,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      effective_workspace_root TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS command_runs (
      id TEXT PRIMARY KEY,
      delivery_attempt_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      requirement TEXT NOT NULL,
      label TEXT NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_code INTEGER,
      duration_ms INTEGER,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      output TEXT NOT NULL,
      output_truncated INTEGER NOT NULL,
      output_bytes INTEGER NOT NULL,
      verification_snapshot_fingerprint TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_delivery ON delivery_attempts(delivery_id);
    CREATE INDEX IF NOT EXISTS idx_runs_attempt ON command_runs(delivery_attempt_id);
  `);
  return db;
}

/** 生成 id（hex，含时间戳前缀便于排序）。 */
function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

// ===== 服务端 owner 推导（绝不信任客户端字段）=====

/**
 * 从 sessionId 推导 DeliveryOwner。这是所有 API 的唯一入口：
 * - 隔离会话 -> worktree 的 projectPath + path + branch。
 * - 普通会话 -> 持久化会话所在项目，不依赖 UI 的活动项目。
 * 无法确认归属时抛出结构化错误，绝不创建猜测归属的交付。
 */
export function resolveOwner(sessionId: string): DeliveryOwner | null {
  const owner = resolveSessionOwner(sessionId);
  const resolved = {
    projectId: owner.project.id,
    sessionId,
    effectiveWorkspaceRoot: owner.effectiveWorkspaceRoot,
  };
  // Existing records created by older versions may have captured the then-active
  // project. Never execute or expose those records under the corrected owner.
  const delivery = getDeliveryForSession(sessionId);
  const attempt = delivery ? getActiveAttempt(delivery.id) : null;
  for (const record of [delivery, attempt]) {
    if (record && (record.projectId !== resolved.projectId || record.sessionId !== sessionId
      || resolve(record.effectiveWorkspaceRoot) !== resolve(resolved.effectiveWorkspaceRoot))) {
      throw new WorkflowError("CONFLICT", "已有交付记录的工作区与会话归属不一致，请核对记录后重新建立交付", 409);
    }
  }
  return resolved;
}

// re-export 路径守卫（独立模块，供 API 层与单测直接使用）
export { resolveCwdWithin };

// ===== TaskDelivery 读写 =====

function rowToDelivery(row: Record<string, unknown>): TaskDelivery {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    sessionId: row.session_id as string,
    effectiveWorkspaceRoot: row.effective_workspace_root as string,
    ...(row.base_ref ? { baseRef: row.base_ref as string } : {}),
    ...(row.worktree_branch ? { worktreeBranch: row.worktree_branch as string } : {}),
    ...(row.active_attempt_id ? { activeAttemptId: row.active_attempt_id as string } : {}),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** 获取（或惰性创建）某个 owner 下的 TaskDelivery。每个 session 一个 delivery。 */
export function getOrCreateDelivery(owner: DeliveryOwner): TaskDelivery {
  const d = getDb();
  const now = new Date().toISOString();
  const existing = d
    .prepare("SELECT * FROM deliveries WHERE session_id = ?")
    .get(owner.sessionId) as Record<string, unknown> | undefined;
  if (existing) return rowToDelivery(existing);

  const delivery: TaskDelivery = {
    id: newId("del"),
    ...owner,
    baseRef: undefined,
    worktreeBranch: undefined,
    createdAt: now,
    updatedAt: now,
  };
  d.prepare(
    "INSERT INTO deliveries (id, project_id, session_id, effective_workspace_root, base_ref, worktree_branch, active_attempt_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    delivery.id,
    owner.projectId,
    owner.sessionId,
    owner.effectiveWorkspaceRoot,
    null,
    null,
    null,
    now,
    now,
  );
  return delivery;
}

/** 按 sessionId 查 delivery（无则 null）。 */
export function getDeliveryForSession(sessionId: string): TaskDelivery | null {
  const row = getDb().prepare("SELECT * FROM deliveries WHERE session_id = ?").get(sessionId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToDelivery(row) : null;
}

// ===== DeliveryAttempt 读写 =====

function snapshotToJson(s: DeliverySnapshot): string {
  return JSON.stringify(s);
}
function snapshotFromJson(s: string | null | undefined): DeliverySnapshot | undefined {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as DeliverySnapshot;
  } catch {
    return undefined;
  }
}

function rowToAttempt(row: Record<string, unknown>): DeliveryAttempt {
  return {
    id: row.id as string,
    deliveryId: row.delivery_id as string,
    runId: row.run_id as string,
    sequence: row.sequence as number,
    status: row.status as DeliveryStatus,
    ...(row.unverified_reason ? { unverifiedReason: row.unverified_reason as DeliveryAttempt["unverifiedReason"] } : {}),
    ...(row.approved_execution_plan_id ? { approvedExecutionPlanId: row.approved_execution_plan_id as string } : {}),
    verificationSnapshot: snapshotFromJson(row.verification_snapshot as string | null),
    ...(row.supersedes_attempt_id ? { supersedesAttemptId: row.supersedes_attempt_id as string } : {}),
    ...(row.superseded_at ? { supersededAt: row.superseded_at as string } : {}),
    changedPaths: JSON.parse(row.changed_paths as string) as string[],
    ...(row.summary ? { summary: row.summary as string } : {}),
    risks: JSON.parse(row.risks as string) as string[],
    projectId: row.project_id as string,
    sessionId: row.session_id as string,
    effectiveWorkspaceRoot: row.effective_workspace_root as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function writeAttempt(attempt: DeliveryAttempt): void {
  const d = getDb();
  d.prepare(
    `INSERT OR REPLACE INTO delivery_attempts
      (id, delivery_id, run_id, sequence, status, unverified_reason, approved_execution_plan_id,
       verification_snapshot, supersedes_attempt_id, superseded_at, changed_paths, summary, risks,
       project_id, session_id, effective_workspace_root, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attempt.id,
    attempt.deliveryId,
    attempt.runId,
    attempt.sequence,
    attempt.status,
    attempt.unverifiedReason ?? null,
    attempt.approvedExecutionPlanId ?? null,
    attempt.verificationSnapshot ? snapshotToJson(attempt.verificationSnapshot) : null,
    attempt.supersedesAttemptId ?? null,
    attempt.supersededAt ?? null,
    JSON.stringify(attempt.changedPaths),
    attempt.summary ?? null,
    JSON.stringify(attempt.risks),
    attempt.projectId,
    attempt.sessionId,
    attempt.effectiveWorkspaceRoot,
    attempt.createdAt,
    attempt.updatedAt,
  );
}

export function getAttempt(attemptId: string): DeliveryAttempt | null {
  const row = getDb().prepare("SELECT * FROM delivery_attempts WHERE id = ?").get(attemptId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToAttempt(row) : null;
}

/** 获取 delivery 的 active attempt（无则 null）。 */
export function getActiveAttempt(deliveryId: string): DeliveryAttempt | null {
  const delivery = getDb().prepare("SELECT active_attempt_id FROM deliveries WHERE id = ?").get(deliveryId) as
    | { active_attempt_id: string | null }
    | undefined;
  if (!delivery?.active_attempt_id) return null;
  return getAttempt(delivery.active_attempt_id);
}

/** 列出某个 attempt 的全部命令记录。 */
export function listCommandRuns(attemptId: string): CommandRun[] {
  const rows = getDb()
    .prepare("SELECT * FROM command_runs WHERE delivery_attempt_id = ? ORDER BY started_at ASC")
    .all(attemptId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    deliveryAttemptId: row.delivery_attempt_id as string,
    kind: row.kind as CommandRun["kind"],
    requirement: row.requirement as CommandRun["requirement"],
    label: row.label as string,
    command: row.command as string,
    cwd: row.cwd as string,
    status: row.status as CommandRun["status"],
    ...(row.exit_code != null ? { exitCode: row.exit_code as number } : {}),
    ...(row.duration_ms != null ? { durationMs: row.duration_ms as number } : {}),
    startedAt: row.started_at as string,
    ...(row.ended_at ? { endedAt: row.ended_at as string } : {}),
    output: row.output as string,
    outputTruncated: Boolean(row.output_truncated),
    outputBytes: row.output_bytes as number,
    ...(row.verification_snapshot_fingerprint ? { verificationSnapshotFingerprint: row.verification_snapshot_fingerprint as string } : {}),
  }));
}

function writeCommandRun(run: CommandRun): void {
  const d = getDb();
  d.prepare(
    `INSERT OR REPLACE INTO command_runs
      (id, delivery_attempt_id, kind, requirement, label, command, cwd, status, exit_code,
       duration_ms, started_at, ended_at, output, output_truncated, output_bytes, verification_snapshot_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.id,
    run.deliveryAttemptId,
    run.kind,
    run.requirement,
    run.label,
    run.command,
    run.cwd,
    run.status,
    run.exitCode ?? null,
    run.durationMs ?? null,
    run.startedAt,
    run.endedAt ?? null,
    run.output,
    run.outputTruncated ? 1 : 0,
    run.outputBytes,
    run.verificationSnapshotFingerprint ?? null,
  );
}

// ===== attempt 生命周期 =====

/**
 * 开始一个新 attempt（一个 run 的开始）。会 supersede 旧的 active attempt。
 * 返回新 attempt。创建时状态为 running。
 */
export function beginAttempt(owner: DeliveryOwner, runId: string): DeliveryAttempt {
  const delivery = getOrCreateDelivery(owner);
  const d = getDb();
  const now = new Date().toISOString();

  // supersede 旧 active attempt
  const oldActive = getActiveAttempt(delivery.id);
  const nextSeq = (oldActive?.sequence ?? 0) + 1;
  const attempt: DeliveryAttempt = {
    id: newId("att"),
    deliveryId: delivery.id,
    runId,
    sequence: nextSeq,
    status: "running",
    ...(oldActive ? { supersedesAttemptId: oldActive.id } : {}),
    changedPaths: [],
    risks: [],
    projectId: owner.projectId,
    sessionId: owner.sessionId,
    effectiveWorkspaceRoot: owner.effectiveWorkspaceRoot,
    createdAt: now,
    updatedAt: now,
  };

  if (oldActive) {
    d.prepare("UPDATE delivery_attempts SET superseded_at = ?, updated_at = ? WHERE id = ?").run(now, now, oldActive.id);
  }

  writeAttempt(attempt);
  // 更新 delivery：baseRef / worktreeBranch / activeAttemptId
  const baseRef = delivery.baseRef ?? undefined;
  const wt = worktreeForSession(owner.sessionId);
  d.prepare(
    "UPDATE deliveries SET active_attempt_id = ?, worktree_branch = ?, updated_at = ? WHERE id = ?",
  ).run(attempt.id, wt?.branch ?? null, now, delivery.id);

  void baseRef;
  return attempt;
}

/**
 * 原子转换到 verifying：捕获验证快照，并以临时 Git index 物化 immutable
 * delivery commit/tree。不修改用户 worktree。
 * 非 git 仓库时跳过 commit 物化（snapshot 仍记录 fingerprint）。
 */
export async function transitionToVerifying(
  attemptId: string,
): Promise<DeliveryAttempt> {
  const attempt = getAttempt(attemptId);
  if (!attempt) throw new Error("attempt 不存在");
  assertTransition(attempt.status, "verifying");

  const root = attempt.effectiveWorkspaceRoot;
  const now = new Date().toISOString();
  const isGit = isGitRepo(root);
  const baseSha = isGit ? await headSha(root) : undefined;
  const fingerprint = isGit ? await worktreeFingerprint(root) : await plainFingerprint(root);
  // 变更文件是证据的一部分，必须由服务端从 git 推导，绝不信任客户端提交的路径。
  const changedPaths = isGit ? await listChangedPaths(root) : [];

  const snapshot: DeliverySnapshot = {
    ...(baseSha ? { baseHeadSha: baseSha, worktreeHeadSha: baseSha } : {}),
    worktreeFingerprint: fingerprint,
    capturedAt: now,
  };

  if (isGit && baseSha) {
    // 物化 immutable delivery commit/tree（临时 index，不碰用户 worktree）
    const tmpIndex = join(deliveryDataDir(), `index-${attempt.id}`);
    try {
      const materialized = await materializeDeliveryCommit(root, tmpIndex);
      snapshot.deliveryCommitSha = materialized.commitSha;
      snapshot.deliveryTreeSha = materialized.treeSha;
    } catch (err) {
      // 物化失败不阻断进入 verifying，但快照无 delivery commit，合并时会拒绝
      const _e = err as Error;
      void _e;
    } finally {
      rmSync(tmpIndex, { force: true });
    }
  }

  // W1-S27：隔离会话补捕获整合目标 ref 的 HEAD（接受时的目标 CAS 锚点——
  // 目标在验证后推进 → 拒绝重新验证，与 base 推进同语义，spec §11.2）
  const wsRecord = workspaceRecordForSession(dataDir, attempt.sessionId);
  if (wsRecord && !wsRecord.targetRef.startsWith("commit:")) {
    const repoRoot = resolve(wsRecord.path, "..", "..");
    const fullRef = wsRecord.targetRef.startsWith("refs/") ? wsRecord.targetRef : `refs/heads/${wsRecord.targetRef}`;
    const targetHead = await git(repoRoot, ["rev-parse", "--verify", fullRef]);
    if (targetHead.ok) snapshot.targetHeadSha = targetHead.stdout.trim();
  }

  attempt.status = "verifying";
  attempt.verificationSnapshot = snapshot;
  attempt.changedPaths = changedPaths;
  attempt.updatedAt = now;
  writeAttempt(attempt);
  return attempt;
}

/** 非 git 目录的轻量指纹（目录内文件大小+mtime 哈希）。 */
async function plainFingerprint(root: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { readdirSync, statSync } = await import("node:fs");
  const hash = createHash("sha256");
  try {
    const entries = readdirSync(root).sort();
    for (const e of entries) {
      if (e === ".git" || e === ".lectern-worktrees") continue;
      try {
        const st = statSync(join(root, e));
        hash.update(`${e}:${st.size}:${st.mtimeMs}`);
      } catch {
        /* 忽略不可读项 */
      }
    }
  } catch {
    /* 目录不可读 */
  }
  return hash.digest("hex");
}

/**
 * 完成验证：根据 command runs 聚合结果设置终态（ready_for_review /
 * verification_failed / unverified）。
 */
export function finishVerification(attemptId: string): DeliveryAttempt {
  const attempt = getAttempt(attemptId);
  if (!attempt) throw new Error("attempt 不存在");
  if (attempt.status !== "verifying") throw new Error("attempt 不在 verifying 状态");

  const runs = listCommandRuns(attemptId);
  const resolved = resolveVerificationStatus(runs);
  const now = new Date().toISOString();

  assertTransition(attempt.status, resolved.status);
  attempt.status = resolved.status;
  if (resolved.unverifiedReason) attempt.unverifiedReason = resolved.unverifiedReason;
  attempt.updatedAt = now;
  writeAttempt(attempt);
  return attempt;
}

/** 记录一条命令（结构化 CommandRun）。 */
export function recordCommandRun(run: CommandRun): CommandRun {
  writeCommandRun(run);
  return run;
}

/**
 * 把 attempt 标记为 snapshot_stale（验证后工作区被修改、base 前进等）。
 * 只对已持有验证快照的非终态 attempt 有意义；终态 attempt 不在此列。
 */
export function markSnapshotStale(attemptId: string): DeliveryAttempt {
  const attempt = getAttempt(attemptId);
  if (!attempt) throw new Error("attempt 不存在");
  if (attempt.status === "accepted" || attempt.status === "discarded" || attempt.status === "cancelled") {
    return attempt;
  }
  if (!attempt.verificationSnapshot) return attempt;
  const now = new Date().toISOString();
  // 允许从 ready_for_review / verification_failed 退回 unverified(snapshot_stale)
  attempt.status = "unverified";
  attempt.unverifiedReason = "snapshot_stale";
  attempt.updatedAt = now;
  writeAttempt(attempt);
  return attempt;
}

/** 取消 attempt（running/verifying -> cancelled）。 */
export function cancelAttempt(attemptId: string): DeliveryAttempt {
  const attempt = getAttempt(attemptId);
  if (!attempt) throw new Error("attempt 不存在");
  if (attempt.status === "cancelled" || attempt.status === "accepted" || attempt.status === "discarded") {
    return attempt;
  }
  assertTransition(attempt.status, "cancelled");
  attempt.status = "cancelled";
  attempt.updatedAt = new Date().toISOString();
  writeAttempt(attempt);
  return attempt;
}

/** 接受（用户确认合并成功 / 记录 accepted）。仅 active attempt 可进入终态。 */
export function markAccepted(attemptId: string): DeliveryAttempt {
  const attempt = getAttempt(attemptId);
  if (!attempt) throw new Error("attempt 不存在");
  if (!canAccept(attempt.status, attempt.unverifiedReason)) {
    throw new Error("该 attempt 不可接受（需 ready_for_review 或 no_required_checks）");
  }
  assertTransition(attempt.status, "accepted");
  attempt.status = "accepted";
  attempt.updatedAt = new Date().toISOString();
  writeAttempt(attempt);
  return attempt;
}

/** 丢弃 attempt（终态）。 */
export function markDiscarded(attemptId: string): DeliveryAttempt {
  const attempt = getAttempt(attemptId);
  if (!attempt) throw new Error("attempt 不存在");
  if (attempt.status === "accepted" || attempt.status === "discarded") return attempt;
  assertTransition(attempt.status, "discarded");
  attempt.status = "discarded";
  attempt.updatedAt = new Date().toISOString();
  writeAttempt(attempt);
  return attempt;
}

// ===== Git CAS 合并 =====

/** 重新计算当前 worktree 指纹是否仍等于 attempt 的验证快照。 */
export async function isSnapshotStillValid(attempt: DeliveryAttempt): Promise<boolean> {
  const snap = attempt.verificationSnapshot;
  if (!snap) return false;
  const root = attempt.effectiveWorkspaceRoot;
  if (!isGitRepo(root)) return false;
  const current = await worktreeFingerprint(root);
  return current === snap.worktreeFingerprint;
}

/**
 * 「接受并合并」：Git compare-and-swap。
 * 只从 immutable delivery commit 建 merge commit，并以
 * `git update-ref <baseRef> <mergeCommit> <verifiedBaseHeadSha>` 原子更新目标 ref。
 * 禁止从可写 worktree 直接 merge。
 */
export async function mergeAttemptCas(attemptId: string, allowUnverified = false): Promise<DeliveryMergeResult> {
  const attempt = getAttempt(attemptId);
  if (!attempt) return { ok: false, reason: "no_attempt" };

  const delivery = getDb().prepare("SELECT * FROM deliveries WHERE id = ?").get(attempt.deliveryId) as
    | Record<string, unknown>
    | undefined;
  if (!delivery) return { ok: false, reason: "no_attempt" };
  if (delivery.active_attempt_id !== attemptId) return { ok: false, reason: "not_active_attempt" };

  // 状态门槛：ready_for_review 直接可合；unverified 仅 no_required_checks 可（allowUnverified）。
  if (!canAccept(attempt.status, attempt.unverifiedReason)) {
    return { ok: false, reason: "bad_status", detail: `状态 ${attempt.status} 不可合并` };
  }
  if (attempt.status === "unverified" && !allowUnverified) {
    return { ok: false, reason: "bad_status", detail: "未验证快照需二次确认" };
  }
  if (attempt.status === "unverified" && attempt.unverifiedReason === "snapshot_stale") {
    return { ok: false, reason: "snapshot_stale" };
  }

  const snap = attempt.verificationSnapshot;
  if (!snap || !snap.deliveryCommitSha) {
    return { ok: false, reason: "no_delivery_commit" };
  }

  const root = attempt.effectiveWorkspaceRoot;
  if (!isGitRepo(root)) return { ok: false, reason: "not_git_repo" };

  // 前置：快照仍相等（验证后工作区被改则拒绝）
  const currentFingerprint = await worktreeFingerprint(root);
  if (currentFingerprint !== snap.worktreeFingerprint) {
    return { ok: false, reason: "snapshot_stale" };
  }

  // 前置：base ref 仍等于验证时的 baseHeadSha（并发推进则拒绝）
  const baseRef = (delivery.base_ref as string | undefined) ?? (await currentBranch(root));
  if (!baseRef) return { ok: false, reason: "base_ref_moved" };
  const nowBase = await git(root, ["rev-parse", baseRef]);
  const verifiedBase = snap.baseHeadSha;
  if (verifiedBase && nowBase.ok && nowBase.stdout.trim() !== verifiedBase) {
    return { ok: false, reason: "base_ref_moved", detail: "base 分支已推进，请重新验证" };
  }

  // 工作区脏（相对 HEAD 还有未提交改动）时拒绝——避免把未验证内容一起卷进 merge commit。
  // 注意：验证快照本身可能包含未提交改动；这里要求的是「进入合并时工作区与快照一致」，
  // 而 delivery commit 已把快照内容固化，merge 只基于 delivery commit，不依赖工作区。
  // 但为了防「合并过程中工作区被并发改动」，先检查 HEAD 未变。
  const headNow = await headSha(root);
  if (snap.worktreeHeadSha && headNow !== snap.worktreeHeadSha) {
    return { ok: false, reason: "snapshot_stale", detail: "worktree HEAD 已变化" };
  }

  // ===== W1-S27 收敛：隔离会话（workspace 记录在案）的合并+推进委托
  // WorkspaceService 整合序列（repo 锁/受管临时 worktree/FF-only/journal/重试去重）。
  // evidence 约束仍由上面的既有前置检查承担（canAccept/快照有效/base 未动/HEAD 未变）；
  // 整合目标 = 创建时固定的 targetRef（四宗罪之三：不跟随主目录当前分支），
  // 目标 CAS 锚点 = 验证时捕获的 targetHeadSha（推进 → 拒绝重新验证）。 =====
  const wsRecord = workspaceRecordForSession(dataDir, attempt.sessionId);
  if (wsRecord) {
    if (wsRecord.targetRef.startsWith("commit:")) {
      return { ok: false, reason: "base_ref_moved", detail: "workspace 创建于 detached HEAD，无有效整合目标分支；请显式指定目标分支后接受" };
    }
    const repoRoot = resolve(wsRecord.path, "..", "..");
    const fullRef = wsRecord.targetRef.startsWith("refs/") ? wsRecord.targetRef : `refs/heads/${wsRecord.targetRef}`;
    const targetNow = await git(repoRoot, ["rev-parse", "--verify", fullRef]);
    if (!targetNow.ok) return { ok: false, reason: "base_ref_moved", detail: `整合目标 ref 不存在：${wsRecord.targetRef}` };
    const nowTip = targetNow.stdout.trim();
    if (snap.targetHeadSha && nowTip !== snap.targetHeadSha) {
      return { ok: false, reason: "base_ref_moved", detail: "整合目标分支已推进，请重新验证后再接受" };
    }
    // 交付验证完成 = 审查完成（幂等；integrated/integrating 由整合门槛自理）
    markReadyForReview(dataDir, wsRecord.workspaceId);
    const integrated = await integrateWorkspace(dataDir, wsRecord.workspaceId, {
      expectedTargetCommit: nowTip,
      targetRef: wsRecord.targetRef,
      sourceCommit: snap.deliveryCommitSha, // 合并 immutable delivery commit，不是分支 tip
    });
    if (!integrated.ok) {
      const mapped: DeliveryMergeRejectReason =
        integrated.reason === "target-moved" || integrated.reason === "bad-target-ref" ? "base_ref_moved"
        : integrated.reason === "target-dirty" ? "worktree_dirty"
        : integrated.reason === "cas-failed" || integrated.reason === "not-fast-forward" ? "cas_failed"
        : integrated.reason === "conflict" ? "integration_conflict"
        : "integration_failed";
      return { ok: false, reason: mapped, detail: integrated.record?.failureReason ?? integrated.reason };
    }
    return { ok: true, mergeCommitSha: integrated.record.integrationCommit ?? "", baseRef: wsRecord.targetRef };
  }

  // ===== 非 workspace 会话（普通主工作区，无隔离层）：维持既有直接 CAS =====
  // 从 immutable delivery commit 建 merge commit（--no-ff 保证记录 merge 节点）。
  const mergeCommit = await git(root, [
    "commit-tree",
    snap.deliveryCommitSha,
    "-p",
    verifiedBase ?? "HEAD",
    "-m",
    "lectern: accept delivery",
  ]);
  if (!mergeCommit.ok) {
    return { ok: false, reason: "cas_failed", detail: `merge commit 创建失败：${mergeCommit.stderr.slice(0, 200)}` };
  }
  const mergeSha = mergeCommit.stdout.trim();

  // 原子 CAS：update-ref <baseRef> <mergeCommit> <verifiedBaseHeadSha>
  const update = await casUpdateRef(root, baseRef, mergeSha, verifiedBase);
  if (!update.ok) {
    return { ok: false, reason: "cas_failed", detail: `update-ref 失败：${update.stderr.slice(0, 200)}` };
  }

  return { ok: true, mergeCommitSha: mergeSha, baseRef };
}
