import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { dataDir } from "./runtime-constants.js";
import { WorkflowError } from "./workflow-error.js";

/**
 * 会话级 git worktree 隔离（robustness-plan §9）：
 * - 「隔离副本」会话在 <repo>/.lectern-worktrees/<sessionId> 建独立 git worktree，
 *   分支 lectern/<sessionId>——agent 的读写/命令全部落在副本里，主工作区在
 *   显式「合并回主工作区」之前零污染。
 * - 映射存独立 SQLite（worktrees.db，与 audit.db 同模式，与 framework 会话库零耦合）。
 * - 非 git 项目 / git 命令失败 → 降级为普通会话并回传原因（渐进采用，不做一刀切）。
 */

const p_execFile = promisify(execFile);

export type WorktreeRecord = {
  sessionId: string;
  projectPath: string;
  path: string;
  branch: string;
  createdAt: string;
};

export type CreateWorktreeResult =
  | { ok: true; record: WorktreeRecord }
  | { ok: false; reason: string };

/** 会话 id 白名单（与 sessions route SAFE_ID 同源；同时是合法分支名字符子集）。 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
/** worktree 容器目录（挂在仓库内 .git/info/exclude 里，不污染 git status）。 */
const WORKTREE_DIR = ".lectern-worktrees";
const BRANCH_PREFIX = "lectern/";

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(join(resolve(dataDir), "worktrees.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS worktrees (
      session_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      path TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout } = await p_execFile("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, stdout: stdout.toString(), stderr: "" };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() || e.message || "git 失败",
    };
  }
}

export function isGitRepo(dir: string): boolean {
  return existsSync(resolve(dir, ".git")) || existsSync(resolve(dir, ".git", "HEAD"));
}

/** 会话 → worktree 映射（无则 null，即普通主工作区会话）。 */
export function worktreeForSession(sessionId: string): WorktreeRecord | null {
  try {
    const row = getDb()
      .prepare("SELECT session_id, project_path, path, branch, created_at FROM worktrees WHERE session_id = ?")
      .get(sessionId) as { session_id: string; project_path: string; path: string; branch: string; created_at: string } | undefined;
    if (!row) return null;
    return { sessionId: row.session_id, projectPath: row.project_path, path: row.path, branch: row.branch, createdAt: row.created_at };
  } catch {
    throw new WorkflowError("RESOURCE_UNAVAILABLE", "隔离副本映射不可读取，已阻止回落主工作区", 503, true);
  }
}

/** 把 worktree 容器目录写进 .git/info/exclude（本地忽略，不动 .gitignore）。 */
function ensureExcluded(projectPath: string): void {
  const excludeFile = resolve(projectPath, ".git", "info", "exclude");
  try {
    if (!existsSync(resolve(projectPath, ".git", "info"))) mkdirSync(resolve(projectPath, ".git", "info"), { recursive: true });
    const existing = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (!existing.split(/\r?\n/).includes(WORKTREE_DIR)) {
      appendFileSync(excludeFile, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${WORKTREE_DIR}\n`);
    }
  } catch {
    /* 只读仓库等场景：不阻塞创建（status 会多一条 untracked 目录，可接受） */
  }
}

/** 为会话创建隔离 worktree。任何失败都降级（返回 reason），绝不阻塞会话创建。 */
export async function createWorktree(sessionId: string, projectPath: string): Promise<CreateWorktreeResult> {
  if (!SAFE_ID.test(sessionId)) return { ok: false, reason: "invalid-session-id" };
  const root = resolve(projectPath);
  if (!isGitRepo(root)) return { ok: false, reason: "not-a-git-repo" };

  const wtPath = resolve(root, WORKTREE_DIR, sessionId);
  const branch = `${BRANCH_PREFIX}${sessionId}`;

  // 幂等：已登记且目录在 → 直接复用
  const existing = worktreeForSession(sessionId);
  if (existing && existsSync(existing.path)) return { ok: true, record: existing };

  ensureExcluded(root);
  // 分支已存在（上次创建中断）→ 挂旧分支；否则 -b 新建
  const branchCheck = await git(root, ["rev-parse", "--verify", branch]);
  const add = branchCheck.ok
    ? await git(root, ["worktree", "add", wtPath, branch])
    : await git(root, ["worktree", "add", "-b", branch, wtPath]);
  if (!add.ok) {
    return { ok: false, reason: `git-worktree-add-failed: ${add.stderr.trim().split("\n")[0] ?? ""}`.slice(0, 200) };
  }

  const record: WorktreeRecord = {
    sessionId,
    projectPath: root,
    path: wtPath,
    branch,
    createdAt: new Date().toISOString(),
  };
  try {
    getDb()
      .prepare("INSERT OR REPLACE INTO worktrees (session_id, project_path, path, branch, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(record.sessionId, record.projectPath, record.path, record.branch, record.createdAt);
  } catch {
    /* 映射落库失败仅影响断线后重进隔离态，不阻塞本次会话 */
  }
  return { ok: true, record };
}

/** 分支相对主工作区 HEAD 的领先提交数（尽力而为）。 */
export async function worktreeCommits(sessionId: string): Promise<number | undefined> {
  const wt = worktreeForSession(sessionId);
  if (!wt) return undefined;
  const res = await git(wt.projectPath, ["rev-list", "--count", `HEAD..${wt.branch}`]);
  if (!res.ok) return undefined;
  const n = Number(res.stdout.trim());
  return Number.isFinite(n) ? n : undefined;
}

/** 丢弃隔离副本：删 worktree 目录 + 分支 + 映射（尽力而为，未合并的提交随分支丢弃）。 */
export async function removeWorktree(sessionId: string): Promise<void> {
  const wt = worktreeForSession(sessionId);
  if (!wt) return;
  await git(wt.projectPath, ["worktree", "remove", "--force", wt.path]);
  await git(wt.projectPath, ["branch", "-D", wt.branch]);
  try {
    getDb().prepare("DELETE FROM worktrees WHERE session_id = ?").run(sessionId);
  } catch {
    /* 忽略 */
  }
}

/** 合并隔离分支回主工作区当前分支。成功后自动清理 worktree（会话随即回落主工作区）。
 *  冲突时返回冲突文件清单供 UI 引导，worktree 保留待用户处理。 */
export async function mergeWorktree(sessionId: string): Promise<{
  ok: boolean;
  output: string;
  conflicts?: string[];
}> {
  const wt = worktreeForSession(sessionId);
  if (!wt) return { ok: false, output: "会话没有隔离副本" };

  // 主工作区脏（未提交改动）时拒绝合并——避免把 agent 改动和用户手改搅在一起
  const status = await git(wt.projectPath, ["status", "--porcelain"]);
  if (status.ok && status.stdout.trim().length > 0) {
    return { ok: false, output: "主工作区有未提交改动，先提交或暂存（git stash）再合并" };
  }

  const merge = await git(wt.projectPath, ["merge", wt.branch, "--no-edit"]);
  if (!merge.ok) {
    const conflicts = await git(wt.projectPath, ["diff", "--name-only", "--diff-filter=U"]);
    const files = conflicts.ok
      ? conflicts.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
      : [];
    // 冲突：中止合并回原状，worktree 保留——用户可选择先提交主工作区再试或丢弃
    await git(wt.projectPath, ["merge", "--abort"]);
    return {
      ok: false,
      output: files.length
        ? `合并冲突（已中止，主工作区保持原状）：${files.join("、")}。可在主工作区手动 git merge ${wt.branch} 解决，或丢弃副本。`
        : `合并失败：${merge.stderr.trim().split("\n")[0] ?? ""}`,
      conflicts: files.length ? files : undefined,
    };
  }

  await removeWorktree(sessionId);
  const subject = merge.stdout.split("\n").find(Boolean) ?? "merge";
  return { ok: true, output: subject.trim() };
}
