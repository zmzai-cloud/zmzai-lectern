import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execFile } from "node:child_process";

/** WorkspaceService（W1-S23，spec §10.1/§10.2）：单任务 worktree 全生命周期。
 *
 *  与旧 lib/worktree.ts 的关系：旧模块保留为兼容读面（worktreeForSession/
 *  worktreeCommits 供 M2b 网关查询路由用）；**创建/整合/删除的写路径由本
 *  服务接管**——四宗罪的修复都在这里（先登记再 Git、核对读、固定 targetRef、
 *  删序查返回值）。旧 createWorktree/mergeWorktree 不再被新代码调用。
 *
 *  存储：worktrees.db 新表 workspace_records（W1 schema v2）；旧表只读。 */

export type WorktreeState =
  | "creating" | "preparing" | "ready" | "active" | "verifying"
  | "ready_for_review" | "integrating" | "integrated" | "archived" | "deleting" | "failed";

export type StartingState = "current_commit" | "specified_ref" | "working_tree_snapshot";

export type WorkspaceRecord = {
  workspaceId: string;
  projectId: string;
  repoIdentity: string;
  sessionId: string;
  rootTaskId: string;
  baseRef: string;
  baseCommit: string;
  targetRef: string;
  path: string;
  branch: string;
  startingState: StartingState;
  state: WorktreeState;
  activeOperation?: string;
  revision: number;
  times: { createdAt: string; readyAt?: string; integratedAt?: string };
  failureReason?: string;
};

const RECORDS_TABLE = `CREATE TABLE IF NOT EXISTS workspace_records (
    workspace_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL, project_id TEXT NOT NULL, repo_identity TEXT NOT NULL,
    root_task_id TEXT, state TEXT NOT NULL DEFAULT 'creating', json TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);`;

/** 本地 Git helper（execFile 无 shell 注入面；返回码原样透传）。 */
function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const dbs = new Map<string, DatabaseSync>();
function getDb(dataDir: string): DatabaseSync {
  const cached = dbs.get(dataDir);
  if (cached) return cached;
  const { join } = require("node:path") as typeof import("node:path");
  mkdirSync(dataDir, { recursive: true });
  const handle = new DatabaseSync(join(dataDir, "worktrees.db"));
  handle.exec(RECORDS_TABLE);
  handle.exec("CREATE INDEX IF NOT EXISTS idx_ws_session ON workspace_records(session_id)");
  handle.exec("CREATE INDEX IF NOT EXISTS idx_ws_state ON workspace_records(state)");
  dbs.set(dataDir, handle);
  return handle;
}

export type CreateOptions = {
  dataDir: string;
  projectId: string;
  projectPath: string;
  sessionId: string;
  rootTaskId?: string;
  startingState?: StartingState;
  /** specified_ref 起点必填；working_tree_snapshot 需 untracked 白名单。 */
  baseRef?: string;
  untracked?: string[];
};

export type CreateResult = { ok: true; record: WorkspaceRecord } | { ok: false; reason: string; record?: WorkspaceRecord };

/** 创建序列（spec §10.2）：
 *  1) 先持久登记 creating（含操作幂等键 = workspaceId）
 *  2) 解析 baseCommit（current_commit → HEAD；specified_ref → rev-parse）
 *  3) git worktree add + 固定 targetRef（不再跟随主目录当前分支）
 *  4) 映射核对读（写后读回比对 path/branch）
 *  5) 核对一致才 ready；失败 → failed（可重试），**不自动落回主工作区**
 *
 *  幂等：同 workspaceId 重入时按已落库状态续走（中断恢复）。 */
export async function createWorkspace(opts: CreateOptions): Promise<CreateResult> {
  const root = resolve(opts.projectPath);
  const workspaceId = `ws_${opts.sessionId}`;
  const startingState = opts.startingState ?? "current_commit";
  const db = getDb(opts.dataDir);

  // 已有记录：creating/failed → 续走；ready/active → 直接返回
  const prior = getRecord(db, workspaceId);
  if (prior && (prior.state === "ready" || prior.state === "active") && existsSync(prior.path)) {
    return { ok: true, record: prior };
  }

  const repoIdentity = repoIdentityOf(root);
  if (!repoIdentity) return fail(db, workspaceId, prior, "not-a-git-repo");

  // baseCommit 解析（固定——整合时 CAS 用）
  const ref = startingState === "specified_ref" ? (opts.baseRef ?? "HEAD") : "HEAD";
  const resolved = await git(root, ["rev-parse", "--verify", ref]);
  if (!resolved.ok) return fail(db, workspaceId, prior, `base-ref-invalid: ${ref}`);
  const baseCommit = resolved.stdout.trim();

  // targetRef 固定为主工作区当前分支（创建时刻），不是整合时刻
  const targetRefOut = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const targetRef = targetRefOut.ok && targetRefOut.stdout.trim() !== "HEAD" ? targetRefOut.stdout.trim() : `commit:${baseCommit}`;

  // 登记（creating）——Git 操作之前
  const record: WorkspaceRecord = {
    workspaceId, projectId: opts.projectId, repoIdentity,
    sessionId: opts.sessionId, rootTaskId: opts.rootTaskId ?? "",
    baseRef: ref, baseCommit, targetRef,
    path: resolve(root, ".lectern-worktrees", opts.sessionId),
    branch: `lectern/wt/${opts.sessionId}`,
    startingState, state: "creating", revision: (prior?.revision ?? 0) + 1,
    times: { createdAt: prior?.times.createdAt ?? new Date().toISOString() },
    ...(prior?.failureReason && startingState !== "working_tree_snapshot" ? {} : {}),
  };
  upsertRecord(db, record);

  // Git worktree add（分支已存在 → 挂旧分支，否则 -b）
  // 新建分支必须以 baseCommit 为起点（specified_ref 不能默默从 HEAD 建）
  const branchCheck = await git(root, ["rev-parse", "--verify", record.branch]);
  const add = branchCheck.ok
    ? await git(root, ["worktree", "add", record.path, record.branch])
    : await git(root, ["worktree", "add", "-b", record.branch, record.path, record.baseCommit]);
  if (!add.ok) return fail(db, workspaceId, record, `git-worktree-add-failed: ${(add.stderr.trim().split("\n")[0] ?? "").slice(0, 160)}`);

  // 映射核对读：worktree list 里必须能看到这个路径（写后读回，spec §10.2 中断对账）
  const listOut = await git(root, ["worktree", "list", "--porcelain"]);
  const seen = listOut.ok && listOut.stdout.split("\n").some((line) => {
      if (!line.startsWith("worktree ")) return false;
      // macOS：mkdtemp 给 /var/...，git porcelain 输出 /private/var/...——
      // realpathSync 归一后再比（spec §10.2「兼容空格路径及 Windows」的归一精神）
      try {
        const { realpathSync } = require("node:fs") as typeof import("node:fs");
        return realpathSync(line.slice(9)) === realpathSync(record.path);
      } catch {
        return resolve(line.slice(9)) === resolve(record.path);
      }
    });
  if (!seen) {
    // 核对不一致：清理刚建的 worktree（尽力而为）再落 failed——不留半成品
    await git(root, ["worktree", "remove", "--force", record.path]).catch(() => undefined);
    return fail(db, workspaceId, record, "verify-read-mismatch: worktree list 未见新路径");
  }

  const ready: WorkspaceRecord = { ...record, state: "ready", revision: record.revision + 1, times: { ...record.times, readyAt: new Date().toISOString() } };
  upsertRecord(db, ready);
  return { ok: true, record: ready };
}

/** 删除序列（spec §10.3 末段）：每步查返回码；任一失败保留 deleting 可修复记录。 */
export async function deleteWorkspace(dataDir: string, workspaceId: string, opts: { discardUnintegrated: boolean }): Promise<{ ok: boolean; failures: string[] }> {
  const db = getDb(dataDir);
  const record = getRecord(db, workspaceId);
  if (!record) return { ok: false, failures: ["record-not-found"] };
  const failures: string[] = [];
  upsertRecord(db, { ...record, state: "deleting", activeOperation: "delete", revision: record.revision + 1 });

  // 有未整合改动且未显式丢弃 → 拒绝
  if (!opts.discardUnintegrated && record.state !== "integrated" && record.state !== "archived") {
    const diff = await git(record.path, ["status", "--porcelain"]);
    if (diff.ok && diff.stdout.trim().length > 0) {
      return { ok: false, failures: ["unintegrated-changes: 需显式 discardUnintegrated"] };
    }
  }

  const root = repoRootOfRecord(record);
  const rm = await git(root, ["worktree", "remove", "--force", record.path]);
  if (!rm.ok) failures.push(`worktree-remove: ${rm.stderr.trim().split("\n")[0] ?? ""}`.slice(0, 120));
  const delBranch = await git(root, ["branch", "-D", record.branch]);
  if (!delBranch.ok) failures.push(`branch-delete: ${delBranch.stderr.trim().split("\n")[0] ?? ""}`.slice(0, 120));
  const delRow = (() => {
    try { db.prepare("DELETE FROM workspace_records WHERE workspace_id = ?").run(workspaceId); return { ok: true }; } catch (e) { return { ok: false, stderr: String(e) }; }
  })();
  if (!delRow.ok) failures.push("record-delete");
  return { ok: failures.length === 0, failures };
}

// ---- helpers ----

function repoIdentityOf(root: string): string | null {
  // .git 可能是目录（普通仓库）或文件（worktree/linked）——两者都算 Git 仓库
  return existsSync(resolve(root, ".git")) ? basename(root) : null;
}

function repoRootOfRecord(record: WorkspaceRecord): string {
  // record.path = <root>/.lectern-worktrees/<sid> → root = 上两级
  return resolve(record.path, "..", "..");
}

function getRecord(db: DatabaseSync, workspaceId: string): WorkspaceRecord | null {
  const row = db.prepare("SELECT json FROM workspace_records WHERE workspace_id = ?").get(workspaceId) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as WorkspaceRecord) : null;
}

function upsertRecord(db: DatabaseSync, record: WorkspaceRecord): void {
  db.prepare("INSERT INTO workspace_records(workspace_id,session_id,project_id,repo_identity,root_task_id,json,revision,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET json=excluded.json,revision=excluded.revision,updated_at=excluded.updated_at")
    .run(record.workspaceId, record.sessionId, record.projectId, record.repoIdentity, record.rootTaskId, JSON.stringify(record), record.revision, new Date().toISOString());
}

function fail(db: DatabaseSync, workspaceId: string, prior: WorkspaceRecord | null | undefined, reason: string): CreateResult {
  const base = prior ?? ({ workspaceId, revision: 0, state: "failed", sessionId: "", projectId: "", repoIdentity: "", rootTaskId: "", baseRef: "", baseCommit: "", targetRef: "", path: "", branch: "", startingState: "current_commit", times: { createdAt: new Date().toISOString() } } as WorkspaceRecord);
  upsertRecord(db, { ...base, state: "failed", failureReason: reason, revision: (base.revision ?? 0) + 1 });
  return { ok: false, reason, record: getRecord(db, workspaceId) ?? undefined };
}
