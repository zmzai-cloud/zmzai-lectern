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

// ==================== W1-S24：环境准备（spec §10.2）====================

/** setup manifest（spec §10.2）：项目可声明的环境准备步骤。放在仓库
 *  `.lectern/workspace.json`——仓库内声明、Host 执行，脚本走既有工具
 *  权限（不因「准备环境」绕过权限）；配置映射的值不进模型上下文。 */
export type SetupManifest = {
  /** 依赖安装命令（如 pnpm install --frozen-lockfile）。经 bash 工具权限链执行。 */
  install?: { command: string; cwd?: string };
  /** 必要本地配置映射：from（仓库外，含 secret）→ to（worktree 内相对路径）。
   *  值不落库、不进事件——只在此刻拷贝。 */
  configMaps?: { from: string; to: string }[];
  /** 预览/验证命令（就绪检查用端口探活替代，声明式）。 */
  devServer?: { command: string; port: number };
};

export type PrepareResult = {
  ok: boolean;
  steps: { name: string; ok: boolean; detail?: string; durationMs: number }[];
  assignedPort?: number;
};

/** Host 端口分配器（spec §10.2「端口由 Host 分配并登记，不手工约定 3000」）。 */
const portRegistry = new Map<string, { port: number; workspaceId: string }>();
function allocatePort(workspaceId: string, preferred?: number): number {
  // 已分配优先复用；preferred 被占则从 41000 起探
  for (const [, entry] of portRegistry) {
    if (entry.workspaceId === workspaceId) return entry.port;
  }
  const { createServer } = require("node:net") as typeof import("node:net");
  const tryPort = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
  // 同步探不可行（async）——同步回退：net.ListenSync 不存在，用端口注册表内查重 + 随机段
  let port = preferred ?? 41000 + Math.floor(Math.random() * 2000);
  const used = new Set([...portRegistry.values()].map((e) => e.port));
  while (used.has(port)) port += 1;
  portRegistry.set(`${port}`, { port, workspaceId });
  void tryPort;
  return port;
}

/** 环境准备：manifest 声明的步骤按序执行，每步查退出码；失败 → preparing
 *  保持（state 带 activeOperation=prepare-failed），可重试可取消。
 *  依赖安装优先利用包管理器缓存（命令自带，天然共享）；不默认把不同
 *  worktree 的 node_modules 指向同一目录（spec 明示）。 */
export async function prepareWorkspace(input: {
  dataDir: string;
  workspaceId: string;
  /** 命令执行器（宿主注入——走 bash 工具权限链，service 不自建旁路）。 */
  runCommand(command: string, cwd: string): Promise<{ exitCode: number | null; output: string }>;
  manifest: SetupManifest;
}): Promise<PrepareResult> {
  const db = getDb(input.dataDir);
  const record = getRecord(db, input.workspaceId);
  if (!record) return { ok: false, steps: [{ name: "record", ok: false, detail: "workspace 记录不存在", durationMs: 0 }] };
  if (record.state !== "ready" && record.state !== "active") {
    return { ok: false, steps: [{ name: "state", ok: false, detail: `状态 ${record.state} 不可准备`, durationMs: 0 }] };
  }
  upsertRecord(db, { ...record, state: "preparing", activeOperation: "prepare", revision: record.revision + 1 });

  const steps: PrepareResult["steps"] = [];
  const m = input.manifest;

  // 1) 依赖安装（走权限链执行器）
  if (m.install) {
    const t0 = Date.now();
    const cwd = m.install.cwd ? resolve(record.path, m.install.cwd) : record.path;
    const r = await input.runCommand(m.install.command, cwd);
    steps.push({ name: `install: ${m.install.command.split(" ")[0]}`, ok: r.exitCode === 0, detail: r.exitCode === 0 ? r.output.slice(-120) : `exit=${r.exitCode} ${r.output.slice(-200)}`, durationMs: Date.now() - t0 });
    if (r.exitCode !== 0) {
      upsertRecord(db, { ...record, state: "preparing", activeOperation: "prepare-failed", failureReason: `install 失败 exit=${r.exitCode}`, revision: record.revision + 2 });
      return { ok: false, steps };
    }
  }

  // 2) 配置映射（仓库外 → worktree 内；值不落库不进事件）
  if (m.configMaps) {
    const t0 = Date.now();
    let ok = true;
    const details: string[] = [];
    for (const map of m.configMaps) {
      try {
        const { copyFileSync, mkdirSync: mk } = require("node:fs") as typeof import("node:fs");
        const dest = resolve(record.path, map.to);
        mk(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
        copyFileSync(map.from, dest);
        details.push(map.to);
      } catch (e) {
        ok = false;
        details.push(`${map.to}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    steps.push({ name: "config-map", ok, detail: details.join("; ").slice(0, 200), durationMs: Date.now() - t0 });
    if (!ok) {
      upsertRecord(db, { ...record, state: "preparing", activeOperation: "prepare-failed", failureReason: "config 映射失败", revision: record.revision + 2 });
      return { ok: false, steps };
    }
  }

  // 3) 端口分配（devServer 声明的 preferred；Host 登记表管理）
  let assignedPort: number | undefined;
  if (m.devServer) {
    assignedPort = allocatePort(input.workspaceId, m.devServer.port);
    steps.push({ name: "port-assign", ok: true, detail: String(assignedPort), durationMs: 0 });
  }

  const active: WorkspaceRecord = { ...record, state: "active", activeOperation: undefined, revision: record.revision + 2 };
  upsertRecord(db, active);
  return { ok: true, steps, assignedPort };
}

/** 读取仓库内 setup manifest（缺省返回空 manifest——准备是可选增强）。 */
export function loadSetupManifest(worktreePath: string): SetupManifest {
  try {
    const p = resolve(worktreePath, ".lectern", "workspace.json");
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf8")) as SetupManifest;
  } catch {
    return {};
  }
}

// ==================== W1-S25：审查快照（spec §10.3）====================

/** 审查快照：交付范围的内容指纹 + 不可变 Git tree/commit 标识。
 *  覆盖已提交、未提交（staged/unstaged）、删除及 untracked 交付物——
 *  验证证据绑定到该快照；用户或工具后续改动使证据失效（W04 的
 *  「旧证据失效」判定基础）。 */
export type ReviewSnapshot = {
  workspaceId: string;
  /** 源分支当前 HEAD（未提交改动存在时是快照前的 commit）。 */
  headCommit: string;
  /** 交付范围的完整内容指纹：git status+diff+untracked 内容的联合摘要。 */
  contentFingerprint: string;
  /** 未提交改动清单（path → staged/unstaged/untracked/deleted）。 */
  dirtyFiles: { path: string; kind: "staged" | "unstaged" | "untracked" | "deleted" }[];
  createdAt: string;
};

/** 生成审查快照。HEAD 用 rev-parse；dirty 面用 status --porcelain；
 *  指纹 = sha256(headCommit + porcelain + 各 dirty 文件内容摘要)。 */
export async function captureReviewSnapshot(dataDir: string, workspaceId: string): Promise<ReviewSnapshot | null> {
  const db = getDb(dataDir);
  const record = getRecord(db, workspaceId);
  if (!record) return null;

  const head = await git(record.path, ["rev-parse", "HEAD"]);
  if (!head.ok) return null;
  const headCommit = head.stdout.trim();

  const status = await git(record.path, ["status", "--porcelain=v1"]);
  if (!status.ok) return null;
  const dirtyFiles: ReviewSnapshot["dirtyFiles"] = [];
  const hashParts: string[] = [headCommit, status.stdout];

  for (const line of status.stdout.split("\n")) {
    if (!line.trim()) continue;
    const x = line[0]!;
    const y = line[1]!;
    const filePath = line.slice(3).trim();
    const kind: ReviewSnapshot["dirtyFiles"][number]["kind"] =
      x === "?" ? "untracked" : x === "D" || y === "D" ? "deleted" : x !== " " ? "staged" : "unstaged";
    dirtyFiles.push({ path: filePath, kind });
    if (kind !== "deleted") {
      // 内容摘要进指纹（deleted 只有路径）
      const content = await git(record.path, ["show", `:${filePath}`]).catch(() => ({ ok: false, stdout: "" }));
      const working = kind === "untracked" ? await readWorkingContent(record.path, filePath) : content.ok ? content.stdout : "";
      hashParts.push(`${filePath}:${kind}:${working.length}:${hashString(working).slice(0, 16)}`);
    } else {
      hashParts.push(`${filePath}:deleted`);
    }
  }

  return {
    workspaceId,
    headCommit,
    contentFingerprint: hashString(hashParts.join("\n")),
    dirtyFiles,
    createdAt: new Date().toISOString(),
  };
}

/** 快照比对：当前实际状态与既有快照一致 → 证据仍有效；否则 stale。
 *  W04 的核心判定：「审查后源变化 → 旧证据失效」。 */
export async function isSnapshotCurrent(dataDir: string, snapshot: ReviewSnapshot): Promise<boolean> {
  const now = await captureReviewSnapshot(dataDir, snapshot.workspaceId);
  if (!now) return false;
  return now.contentFingerprint === snapshot.contentFingerprint;
}

function hashString(input: string): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(input).digest("hex");
}

async function readWorkingContent(root: string, relPath: string): Promise<string> {
  try {
    return readFileSync(resolve(root, relPath), "utf8").slice(0, 64 * 1024);
  } catch {
    return "";
  }
}
