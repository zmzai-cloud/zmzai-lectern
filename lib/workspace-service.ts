import { DatabaseSync } from "node:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execFile } from "node:child_process";

/** WorkspaceService（W1-S23~S26，spec §10.1/§10.2/§10.3）：单任务 worktree 全生命周期。
 *
 *  与旧 lib/worktree.ts 的关系：旧模块保留为兼容读面（worktreeForSession/
 *  worktreeCommits 供 M2b 网关查询路由用）；**创建/整合/删除的写路径由本
 *  服务接管**——四宗罪的修复都在这里（先登记再 Git、核对读、固定 targetRef、
 *  删序查返回值）。旧 createWorktree/mergeWorktree 不再被新代码调用。
 *
 *  S26 整合（integrateWorkspace）：repository 级锁 + expectedTargetCommit CAS +
 *  受管临时整合 worktree 合并 + 目标推进双路径（update-ref CAS / --ff-only）+
 *  integration journal 每步落库 + 重试去重（目标已含 merge commit 不重复合并）。
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
  /** W1-S26：整合产出的 merge commit（advance 之前落库——中断对账锚点）。 */
  integrationCommit?: string;
  /** 上次合并进 integrationCommit 的源提交——多轮交付判定锚点是否属于本轮
   *  （S27：目标已含旧锚点但源已换 → 清锚点重新合并，不误报 already-integrated）。 */
  integrationSource?: string;
  integrationAttempts?: IntegrationAttempt[];
  integrationJournal?: IntegrationJournalStep[];
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

  // 已有记录：creating/failed → 续走；ready/active/integrated/archived → 直接返回
  // （integrated/archived 幂等返回=W06：integrated 会话继续指向原工作区，
  //  重入不得新建/换工作区，也不得把状态改坏）
  const prior = getRecord(db, workspaceId);
  if (prior && (prior.state === "ready" || prior.state === "active" || prior.state === "integrated" || prior.state === "archived") && existsSync(prior.path)) {
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
  ensureContainerExcluded(root);
  const branchCheck = await git(root, ["rev-parse", "--verify", record.branch]);
  const add = branchCheck.ok
    ? await git(root, ["worktree", "add", record.path, record.branch])
    : await git(root, ["worktree", "add", "-b", record.branch, record.path, record.baseCommit]);
  if (!add.ok) return fail(db, workspaceId, record, `git-worktree-add-failed: ${(add.stderr.trim().split("\n")[0] ?? "").slice(0, 160)}`);

  // 映射核对读：worktree list 里必须能看到这个路径（写后读回，spec §10.2 中断对账）
  const listOut = await git(root, ["worktree", "list", "--porcelain"]);
  const seen = listOut.ok && listContainsPath(listOut.stdout, record.path);
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

/** 容器目录进仓库本地 exclude（.git/info/exclude，路径经 git 查询不假设 .git 是目录）：
 *  App 管理的 worktree 容器是 Host 自己的现场，不能算用户目标的未提交改动——
 *  否则整合前的目标 clean 检查永远失败。不写 .gitignore（不进用户提交）。 */
function ensureContainerExcluded(root: string): void {
  try {
    const out = (() => {
      // rev-parse 是异步封装；这里同步场景直接查常见路径，查不到就跳过（整合侧还有 git 调用兜底）
      const gitDir = resolve(root, ".git");
      if (!existsSync(gitDir)) return null;
      return resolve(gitDir, "info", "exclude");
    })();
    if (!out) return;
    const cur = existsSync(out) ? readFileSync(out, "utf8") : "";
    // 兼容旧模块 ensureExcluded 的无斜杠写法（避免重复行）
    const already = cur.split(/\r?\n/).some((l) => {
      const t = l.trim();
      return t === ".lectern-worktrees/" || t === ".lectern-worktrees";
    });
    if (!already) {
      mkdirSync(resolve(out, ".."), { recursive: true });
      appendFileSync(out, `${cur.endsWith("\n") || cur === "" ? "" : "\n"}.lectern-worktrees/\n`);
    }
  } catch {
    /* exclude 失败不阻断创建——最坏情况是目标 clean 检查更严格 */
  }
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
  /** 预览/验证命令（就绪检查用端口探活替代，声明式）。
   *  cacheDirs：开发服务器可写缓存目录（.next/dist 等）——V1 起预先声明并
   *  排除出源代码 fingerprint（spec §11.2 末段），不用「忽略生成物」掩盖源码变化。 */
  devServer?: { command: string; port: number; cacheDirs?: string[] };
};

export type PrepareResult = {
  ok: boolean;
  steps: { name: string; ok: boolean; detail?: string; durationMs: number }[];
  assignedPort?: number;
};

/** Host 端口分配器（spec §10.2「端口由 Host 分配并登记，不手工约定 3000」）。 */
const portRegistry = new Map<string, { port: number; workspaceId: string }>();
export function allocatePort(workspaceId: string, preferred?: number): number {
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
  const core = await snapshotWorktree(record.path);
  if (!core) return null;
  return { workspaceId, createdAt: new Date().toISOString(), ...core };
}

/** 快照核心（对任意 worktree 路径可用）：S26 整合对「实际合并结果」
 *  生成快照时复用同一指纹逻辑——验证绑定合并结果而非源分支。 */
async function snapshotWorktree(wtPath: string): Promise<Pick<ReviewSnapshot, "headCommit" | "contentFingerprint" | "dirtyFiles"> | null> {
  const head = await git(wtPath, ["rev-parse", "HEAD"]);
  if (!head.ok) return null;
  const headCommit = head.stdout.trim();

  const status = await git(wtPath, ["status", "--porcelain=v1"]);
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
      const content = await git(wtPath, ["show", `:${filePath}`]).catch(() => ({ ok: false, stdout: "" }));
      const working = kind === "untracked" ? await readWorkingContent(wtPath, filePath) : content.ok ? content.stdout : "";
      hashParts.push(`${filePath}:${kind}:${working.length}:${hashString(working).slice(0, 16)}`);
    } else {
      hashParts.push(`${filePath}:deleted`);
    }
  }

  return {
    headCommit,
    contentFingerprint: hashString(hashParts.join("\n")),
    dirtyFiles,
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

// ==================== W1-S26：整合序列（spec §10.3）====================

/** 进入审查（spec §10.3）：ready/active/verifying → ready_for_review。
 *  审查流程（快照 + 证据绑定完成）调用；是整合的必要前置——
 *  integrateWorkspace 校验 state ∈ ready_for_review 才放行。幂等。 */
export function markReadyForReview(dataDir: string, workspaceId: string): WorkspaceRecord | null {
  const db = getDb(dataDir);
  const record = getRecord(db, workspaceId);
  if (!record) return null;
  if (record.state !== "ready" && record.state !== "active" && record.state !== "verifying") {
    return record.state === "ready_for_review" ? record : null; // 非审查前态不动（幂等保护）
  }
  const updated: WorkspaceRecord = { ...record, state: "ready_for_review", activeOperation: undefined, revision: record.revision + 1 };
  upsertRecord(db, updated);
  return updated;
}

/** 归档（spec §10.3 生命周期收尾）：integrated → archived。
 *  只读归档：目录保留、会话仍指向原工作区；删除走 deleteWorkspace。幂等。 */
export function archiveWorkspace(dataDir: string, workspaceId: string): WorkspaceRecord | null {
  const db = getDb(dataDir);
  const record = getRecord(db, workspaceId);
  if (!record) return null;
  if (record.state === "archived") return record;
  if (record.state !== "integrated") return null; // 未整合不归档（W06：不误删/不悄悄换态）
  const updated: WorkspaceRecord = { ...record, state: "archived", revision: record.revision + 1 };
  upsertRecord(db, updated);
  return updated;
}

/** 按 sessionId 查活跃 workspace 记录（W1 读面：worktree.ts 双读与 delivery 收敛用）。
 *  活跃 = 会话应继续指向该目录的态（含 integrated/archived 只读期）；
 *  creating/failed/deleting 不算——会话按普通主工作区走。 */
const SESSION_ACTIVE_STATES: readonly WorktreeState[] = [
  "ready", "preparing", "active", "verifying", "ready_for_review", "integrating", "integrated", "archived",
];

export function workspaceRecordForSession(dataDir: string, sessionId: string): WorkspaceRecord | null {
  let db: DatabaseSync;
  try {
    db = getDb(dataDir);
  } catch {
    return null;
  }
  let rows: { json: string }[];
  try {
    rows = db.prepare("SELECT json FROM workspace_records WHERE session_id = ? ORDER BY updated_at DESC").all(sessionId) as { json: string }[];
  } catch {
    return null;
  }
  for (const row of rows) {
    try {
      const record = JSON.parse(row.json) as WorkspaceRecord;
      if (SESSION_ACTIVE_STATES.includes(record.state)) return record;
    } catch {
      /* 坏行跳过（不猜） */
    }
  }
  return null;
}

/** 导入旧表（M2b 前 lib/worktree.ts）的 worktree 记录进 workspace_records
 *  （spec §10.2「兼容导入已有 .lectern-worktrees」）。联合校验不猜：
 *  path 存在 + git worktree list 包含 + branch 可解析；任一不符返回 null。
 *  已有新记录 → 原样返回（幂等）。 */
export async function adoptWorkspace(dataDir: string, sessionId: string): Promise<WorkspaceRecord | null> {
  const db = getDb(dataDir);
  const workspaceId = `ws_${sessionId}`;
  const existing = getRecord(db, workspaceId);
  if (existing && existing.state !== "failed" && existing.state !== "deleting") return existing;

  let legacy: { project_path: string; path: string; branch: string; created_at: string } | undefined;
  try {
    legacy = db.prepare("SELECT project_path, path, branch, created_at FROM worktrees WHERE session_id = ?").get(sessionId) as
      | { project_path: string; path: string; branch: string; created_at: string }
      | undefined;
  } catch {
    return null; // 旧表不存在
  }
  if (!legacy || !existsSync(legacy.path)) return null;

  const repoIdentity = repoIdentityOf(resolve(legacy.project_path));
  if (!repoIdentity) return null;
  // Git 联合校验：worktree list 必须包含该路径 + 分支可解析（真实现场，非仅库记录）
  const list = await git(legacy.project_path, ["worktree", "list", "--porcelain"]);
  if (!list.ok || !listContainsPath(list.stdout, legacy.path)) return null;
  const branchOut = await git(legacy.project_path, ["rev-parse", "--verify", legacy.branch]);
  if (!branchOut.ok) return null;
  const baseCommit = branchOut.stdout.trim();
  const targetRefOut = await git(legacy.project_path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const targetRef = targetRefOut.ok && targetRefOut.stdout.trim() !== "HEAD" ? targetRefOut.stdout.trim() : `commit:${baseCommit}`;

  const record: WorkspaceRecord = {
    workspaceId, projectId: "", repoIdentity,
    sessionId, rootTaskId: "",
    baseRef: legacy.branch, baseCommit, targetRef,
    path: legacy.path, branch: legacy.branch,
    startingState: "current_commit", state: "active", revision: (existing?.revision ?? 0) + 1,
    times: { createdAt: legacy.created_at },
  };
  upsertRecord(db, record);
  return record;
}

/** 目标 ref 当前提交（路由/动作层在整合点击时刻取 CAS 锚点用；
 *  targetRef 为 commit: 形式（detached 创建）或 ref 不存在 → null）。 */
export async function currentTargetCommit(dataDir: string, workspaceId: string): Promise<string | null> {
  const db = getDb(dataDir);
  const record = getRecord(db, workspaceId);
  if (!record || record.targetRef.startsWith("commit:")) return null;
  const repoRoot = repoRootOfRecord(record);
  const full = record.targetRef.startsWith("refs/") ? record.targetRef : `refs/heads/${record.targetRef}`;
  const out = await git(repoRoot, ["rev-parse", "--verify", full]);
  return out.ok ? out.stdout.trim() : null;
}

/** worktree list porcelain 输出是否包含目标路径（realpath 归一，macOS /var 前缀兼容）。 */
function listContainsPath(porcelain: string, target: string): boolean {
  return porcelain.split("\n").some((line) => {
    if (!line.startsWith("worktree ")) return false;
    try {
      const { realpathSync } = require("node:fs") as typeof import("node:fs");
      return realpathSync(line.slice(9)) === realpathSync(target);
    } catch {
      return resolve(line.slice(9)) === resolve(target);
    }
  });
}

export type IntegrationOutcome =
  | "succeeded" | "already-integrated"
  | "conflict" | "merge-failed"
  | "target-moved" | "target-dirty" | "source-changed"
  | "not-fast-forward" | "cas-failed" | "verify-failed"
  | "source-branch-missing" | "bad-target-ref" | "integration-worktree-failed";

/** 一次整合尝试的独立记录：冲突/拒绝都保留在这里（修复后重试产生新条目）。 */
export type IntegrationAttempt = {
  id: string;
  startedAt: string;
  finishedAt: string;
  outcome: IntegrationOutcome;
  targetRef: string;
  /** 调用方核对过的目标提交——CAS 前置，整合全程不放松。 */
  expectedTargetCommit: string;
  /** 合并提交（推进目标之前先落 record，中断重试据此不重复合并）。 */
  mergeCommit?: string;
  /** 本轮合并的源提交（显式覆盖=delivery 的 immutable commit；缺省=分支 tip）。 */
  source?: string;
  conflictFiles?: string[];
  /** 实际合并结果的内容指纹（复用审查快照指纹逻辑，验证绑定用）。 */
  mergedSnapshotFingerprint?: string;
  /** 重试复用了上次 merge commit（只推进目标）。 */
  reusedMergeCommit?: boolean;
  detail?: string;
};

export type IntegrationJournalStep = { step: string; at: string; ok: boolean; detail?: string };

export type IntegrateResult =
  | { ok: true; record: WorkspaceRecord; alreadyIntegrated?: boolean }
  | { ok: false; reason: IntegrationOutcome | "record-not-found" | "bad-state"; record?: WorkspaceRecord };

/** repository 级整合锁（进程内，按 repoIdentity 串行）：同仓库同一时刻只有一次整合。
 *  源工作区停写由调用方保证；本锁防的是 Host 内并发整合互相踩目标 ref。 */
const repoIntegrationLocks = new Map<string, Promise<unknown>>();
async function withRepoIntegrationLock<T>(repoIdentity: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoIntegrationLocks.get(repoIdentity) ?? Promise.resolve();
  const run = prev.then(fn, fn); // 前序无论成败都放行本次（锁只管互斥）
  const settle = run.catch(() => undefined);
  repoIntegrationLocks.set(repoIdentity, settle);
  try {
    return await run;
  } finally {
    if (repoIntegrationLocks.get(repoIdentity) === settle) repoIntegrationLocks.delete(repoIdentity);
  }
}

/** 整合序列（spec §10.3 核心）：
 *  1) 状态门槛（ready_for_review；integrating/integrated 为重试/中断恢复入口）
 *  2) repository 级整合锁
 *  3) 重试去重：目标已含 integrationCommit → 直接成功；未含但 merge commit 在 → 只推进
 *  4) CAS：目标 ref 必须仍在 expectedTargetCommit；源快照（可选）必须仍 current
 *  5) 目标已 checkout → clean 检查（dirty 拒绝并保留现场，不 stash/reset）
 *  6) 受管临时整合 worktree（固定 expectedTargetCommit 起点）merge 源交付提交；
 *     冲突 → attempt 保留 conflictFiles，修复源后重试
 *  7) 推进：未 checkout → 后代校验 + update-ref CAS；已 checkout → 复查后 --ff-only（非 FF 拒绝）
 *  8) verify（ref/HEAD 确已到 merge commit，未知态保持 blocked）→ state=integrated，不删目录
 *
 *  每步落 integration journal（workspace_records json 内 steps 数组）。 */
export async function integrateWorkspace(
  dataDir: string,
  workspaceId: string,
  opts: { expectedTargetCommit: string; targetRef?: string; reviewSnapshot?: ReviewSnapshot; sourceCommit?: string },
): Promise<IntegrateResult> {
  const db = getDb(dataDir);
  const initial = getRecord(db, workspaceId);
  if (!initial) return { ok: false, reason: "record-not-found" };

  const gateOk = initial.state === "ready_for_review" || initial.state === "integrating"
    || (initial.state === "integrated" && initial.integrationCommit);
  if (!gateOk) return { ok: false, reason: "bad-state", record: initial };

  return withRepoIntegrationLock(initial.repoIdentity, async (): Promise<IntegrateResult> => {
    // 锁内重读：同仓库其它整合可能刚推进过目标（record 本身不会被别的 workspace 改）
    let current = getRecord(db, workspaceId) ?? initial;

    const attempt: IntegrationAttempt = {
      id: `ia_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`,
      startedAt: new Date().toISOString(),
      finishedAt: "",
      outcome: "succeeded",
      targetRef: opts.targetRef ?? current.targetRef,
      expectedTargetCommit: opts.expectedTargetCommit,
    };
    // detached 创建（targetRef=commit:<sha>）整合前必须显式给有效目标分支（spec §10.2）
    if (attempt.targetRef.startsWith("commit:")) {
      return failAttempt(db, current, attempt, "bad-target-ref",
        `targetRef=${attempt.targetRef} 为固定 commit 起点，整合需显式传入目标分支（opts.targetRef）`);
    }
    const targetFull = attempt.targetRef.startsWith("refs/") ? attempt.targetRef : `refs/heads/${attempt.targetRef}`;
    const repoRoot = repoRootOfRecord(current);
    // 受管临时整合 worktree 路径（会话级稳定：上次中断残留下次先清）
    const tmpPath = resolve(repoRoot, ".lectern-worktrees", `.integration-${current.sessionId}`);

    let pending: IntegrationJournalStep[] = [];
    const note = (step: string, ok: boolean, detail?: string) => {
      pending.push({ step, at: new Date().toISOString(), ok, ...(detail ? { detail: detail.slice(0, 240) } : {}) });
    };
    const flush = (patch: Partial<WorkspaceRecord> = {}) => {
      const journal = [...(current.integrationJournal ?? []), ...pending].slice(-100);
      pending = [];
      current = { ...current, ...patch, integrationJournal: journal, revision: current.revision + 1 };
      upsertRecord(db, current);
    };
    const appendAttempt = (finished: IntegrationAttempt): Partial<WorkspaceRecord> => ({
      integrationAttempts: [...(current.integrationAttempts ?? []), finished],
    });
    /** 拒绝：明确可理解的失败 → 回 ready_for_review 可重试（integrationCommit 保留供去重）。 */
    const reject = (outcome: IntegrationOutcome, detail: string, extra: Partial<IntegrationAttempt> = {}): IntegrateResult => {
      note(outcome, false, detail);
      flush({
        state: "ready_for_review",
        activeOperation: undefined,
        failureReason: `${outcome}: ${detail}`.slice(0, 300),
        ...appendAttempt({ ...attempt, ...extra, finishedAt: new Date().toISOString(), outcome }),
      });
      return { ok: false, reason: outcome, record: current };
    };
    const cleanupTemp = async (tmpPath: string) => {
      if (!existsSync(tmpPath)) return;
      const rm = await git(repoRoot, ["worktree", "remove", "--force", tmpPath]);
      note("integration-worktree-remove", rm.ok, rm.ok ? undefined : firstLine(rm.stderr));
      flush();
    };

    note("lock", true, `repo=${current.repoIdentity}`);
    if (opts.targetRef && opts.targetRef !== current.targetRef) note("target-override", true, `${current.targetRef} -> ${opts.targetRef}`);
    flush({ state: "integrating", activeOperation: "integrate" });

    // 本次整合的源提交：显式覆盖（delivery 的 immutable delivery commit）或分支 tip
    // （未提交改动不属于整合范围——那是 delivery 物化 commit 的职责）
    const sourceOut = await git(repoRoot, ["rev-parse", "--verify", opts.sourceCommit ?? current.branch]);
    if (!sourceOut.ok) return reject("source-branch-missing", `源提交不存在：${opts.sourceCommit ?? current.branch}`);
    const sourceCommit = sourceOut.stdout.trim();
    attempt.source = sourceCommit;

    // 目标 ref 现值
    const targetNow = await git(repoRoot, ["rev-parse", "--verify", targetFull]);
    if (!targetNow.ok) return reject("bad-target-ref", `目标 ref 不存在：${targetFull}`, { targetRef: attempt.targetRef });
    const targetSha = targetNow.stdout.trim();

    // ---- 重试去重（W05「不重复整合」）：目标是否已含预期整合提交 × 锚点是否属于本轮源 ----
    if (current.integrationCommit) {
      const contained = await git(repoRoot, ["merge-base", "--is-ancestor", current.integrationCommit, targetFull]);
      const sourceSame = current.integrationSource === sourceCommit;
      note("retry-check", true, `integrationCommit=${current.integrationCommit.slice(0, 12)} contained=${contained.ok} sourceMatch=${sourceSame}`);
      if (contained.ok && sourceSame) {
        // 目标已包含本轮源的整合提交：幂等成功，不再合并、不再推进
        note("already-integrated", true, targetSha.slice(0, 12));
        flush({
          state: "integrated", activeOperation: undefined, failureReason: undefined,
          integrationCommit: current.integrationCommit,
          ...appendAttempt({ ...attempt, finishedAt: new Date().toISOString(), outcome: "already-integrated" }),
          times: { ...current.times, integratedAt: current.times.integratedAt ?? new Date().toISOString() },
        });
        return { ok: true, record: current, alreadyIntegrated: true };
      }
      if (!contained.ok && sourceSame) {
        // 锚点属于本轮源但目标未含：上次中断在推进之前 → 只推进，不重复合并
        // 中断恢复也过 CAS：目标必须仍在调用方核对的提交上（与全量路径同一前置）
        const resumeCas = targetSha === attempt.expectedTargetCommit;
        note("cas-check", resumeCas, `target=${targetSha.slice(0, 12)} expected=${attempt.expectedTargetCommit.slice(0, 12)}`);
        if (!resumeCas) return reject("target-moved", "中断恢复时目标已推进，与 expectedTargetCommit 不符；请核对后重试");
        attempt.reusedMergeCommit = true;
        note("resume-advance-only", true, `复用 merge commit ${current.integrationCommit.slice(0, 12)}，跳过合并`);
        flush({ integrationCommit: current.integrationCommit });
        return advanceTarget();
      }
      // 锚点过期：目标已含旧轮合并（多轮交付）或上次中断后源已换 → 清锚点走全量
      note("stale-anchor-cleared", true,
        `旧锚点不属于本轮源（${(current.integrationSource ?? "").slice(0, 12)} != ${sourceCommit.slice(0, 12)}${contained.ok ? "，旧轮已落地" : "，上次中断已过时"}），重新合并`);
      flush({ integrationCommit: undefined, integrationSource: undefined });
    }

    // ---- 全量路径 ----
    // CAS：目标必须仍在调用方核对的提交上（targetRef 未变 + expectedTargetCommit）
    const casOk = targetSha === attempt.expectedTargetCommit;
    note("cas-check", casOk, `target=${targetSha.slice(0, 12)} expected=${attempt.expectedTargetCommit.slice(0, 12)}`);
    if (!casOk) return reject("target-moved", "目标分支已推进，与 expectedTargetCommit 不符；请核对后重试");

    // 源快照核对（旧证据失效判定，spec §10.3「核对源快照」）
    if (opts.reviewSnapshot) {
      const snapCurrent = await isSnapshotCurrent(dataDir, opts.reviewSnapshot);
      note("source-snapshot-check", snapCurrent, snapCurrent ? undefined : "审查后源工作区已变化");
      if (!snapCurrent) return reject("source-changed", "审查后源工作区已变化，旧证据失效；需重新审查");
    }

    // 目标 clean 检查（已 checkout 时）：dirty 拒绝并保留现场，不 stash/reset
    ensureContainerExcluded(repoRoot); // 容器目录不算用户改动（S23 之前建的旧容器兜底）
    const checkedOutPath = await findWorktreeForBranch(repoRoot, targetFull);
    if (checkedOutPath) {
      const dirty = await git(checkedOutPath, ["status", "--porcelain"]);
      const clean = dirty.ok && dirty.stdout.trim().length === 0;
      note("target-clean-check", clean, clean ? checkedOutPath : `${checkedOutPath} 有未提交改动`);
      if (!clean) return reject("target-dirty", `目标工作区有未提交改动（${checkedOutPath}），保留现场，不自动 stash/reset`);
    }

    // 受管临时整合 worktree（固定 expectedTargetCommit 起点；不污染源与目标）
    if (existsSync(tmpPath)) await cleanupTemp(tmpPath); // 上次中断的残留先清
    const add = await git(repoRoot, ["worktree", "add", "--detach", tmpPath, attempt.expectedTargetCommit]);
    note("integration-worktree-add", add.ok, add.ok ? tmpPath : firstLine(add.stderr));
    if (!add.ok) return reject("integration-worktree-failed", `worktree add 失败：${firstLine(add.stderr)}`);

    // 合并源交付提交（--no-ff 保留 merge 节点，与交付 CAS 语义一致）
    const mergeMsg = `lectern: integrate ${current.branch} -> ${attempt.targetRef}`;
    const merge = await git(tmpPath, ["merge", "--no-ff", "-m", mergeMsg, sourceCommit]);
    if (!merge.ok) {
      const unmerged = await git(tmpPath, ["diff", "--name-only", "--diff-filter=U"]);
      const conflictFiles = unmerged.ok ? unmerged.stdout.split("\n").filter(Boolean) : [];
      await git(tmpPath, ["merge", "--abort"]);
      await cleanupTemp(tmpPath);
      if (conflictFiles.length > 0) {
        note("merge", false, `冲突 ${conflictFiles.length} 个文件：${conflictFiles.slice(0, 5).join(", ")}`);
        return reject("conflict", "合并冲突：已保留为 integration attempt（conflictFiles），在源分支修复后重试", { conflictFiles });
      }
      note("merge", false, firstLine(merge.stderr));
      return reject("merge-failed", `合并失败：${firstLine(merge.stderr)}`);
    }
    note("merge", true, mergeMsg);
    const headOut = await git(tmpPath, ["rev-parse", "HEAD"]);
    const mergedSha = headOut.ok ? headOut.stdout.trim() : "";
    note("merge-commit", Boolean(mergedSha), mergedSha.slice(0, 12));
    if (!mergedSha) {
      await cleanupTemp(tmpPath);
      return reject("merge-failed", "合并后 rev-parse HEAD 失败");
    }

    // 实际合并结果快照（复用审查快照指纹逻辑——后续验证绑定合并结果，不是源分支）
    const mergedSnap = await snapshotWorktree(tmpPath);
    attempt.mergeCommit = mergedSha;
    attempt.mergedSnapshotFingerprint = mergedSnap?.contentFingerprint;
    note("merged-snapshot", Boolean(mergedSnap?.contentFingerprint), (mergedSnap?.contentFingerprint ?? "").slice(0, 16));
    // merge commit + 本轮源先落 record（中断对账锚点：重试不再重复合并/不误报已整合）
    flush({ integrationCommit: mergedSha, integrationSource: sourceCommit });

    return advanceTarget();

    /** 推进目标（全量与恢复路径共用）：双路径见 spec §10.3。 */
    async function advanceTarget(): Promise<IntegrateResult> {
      const merged = current.integrationCommit!;
      const targetPath = await findWorktreeForBranch(repoRoot, targetFull);

      if (targetPath) {
        // 已 checkout：clean + HEAD/ref 未变 → fast-forward only；非 FF 拒绝，不强推
        const head = await git(targetPath, ["rev-parse", "HEAD"]);
        const refNow = await git(repoRoot, ["rev-parse", targetFull]);
        const dirty = await git(targetPath, ["status", "--porcelain"]);
        const unchanged = head.ok && head.stdout.trim() === attempt.expectedTargetCommit
          && refNow.ok && refNow.stdout.trim() === attempt.expectedTargetCommit;
        const clean = dirty.ok && dirty.stdout.trim().length === 0;
        note("ff-precheck", unchanged && clean,
          `head=${head.stdout.trim().slice(0, 12)} clean=${clean}`);
        if (!unchanged || !clean) {
          await cleanupTemp(tmpPath);
          return reject(clean ? "target-moved" : "target-dirty", "推进前目标 HEAD/ref/clean 复查不符，保留现场未推进");
        }
        const ff = await git(targetPath, ["merge", "--ff-only", merged]);
        note("ff-merge", ff.ok, ff.ok ? merged.slice(0, 12) : firstLine(ff.stderr));
        if (!ff.ok) {
          await cleanupTemp(tmpPath);
          return reject("not-fast-forward", "目标已 checkout，非快进推进被拒绝（未强制覆盖）");
        }
      } else {
        // 未 checkout：merge commit 必须是 expected 的后代（否则 update-ref 会造成分叉/回退）
        const anc = await git(repoRoot, ["merge-base", "--is-ancestor", attempt.expectedTargetCommit, merged]);
        note("ancestry-check", anc.ok, `${attempt.expectedTargetCommit.slice(0, 12)} -> ${merged.slice(0, 12)}`);
        if (!anc.ok) {
          await cleanupTemp(tmpPath);
          return reject("not-fast-forward", "合并提交不是 expectedTargetCommit 的后代，拒绝 update-ref");
        }
        const upd = await git(repoRoot, ["update-ref", targetFull, merged, attempt.expectedTargetCommit]);
        note("update-ref", upd.ok, `${targetFull} ${attempt.expectedTargetCommit.slice(0, 12)}..${merged.slice(0, 12)}`);
        if (!upd.ok) {
          await cleanupTemp(tmpPath);
          return reject("cas-failed", `update-ref CAS 失败（目标被并发推进？）：${firstLine(upd.stderr)}`);
        }
      }

      // verify：ref（+已 checkout 的 HEAD）确已到 merge commit；未知态保持 blocked，不宣称成功
      const after = await git(repoRoot, ["rev-parse", targetFull]);
      let verifyOk = after.ok && after.stdout.trim() === merged;
      if (verifyOk && targetPath) {
        const headAfter = await git(targetPath, ["rev-parse", "HEAD"]);
        verifyOk = headAfter.ok && headAfter.stdout.trim() === merged;
      }
      note("verify", verifyOk, after.stdout.trim().slice(0, 12));
      if (!verifyOk) {
        note("integration-blocked", true, "verify 失败，保持 integrating（blocked），需人工对账 ref/index/journal");
        flush({
          state: "integrating", activeOperation: "integration-verify-failed",
          ...appendAttempt({ ...attempt, finishedAt: new Date().toISOString(), outcome: "verify-failed" }),
        });
        await cleanupTemp(tmpPath);
        return { ok: false, reason: "verify-failed", record: current };
      }

      await cleanupTemp(tmpPath);

      // 成功：不删目录（integrated 会话继续指向原工作区，spec §10.3/W06）
      flush({
        state: "integrated", activeOperation: undefined, failureReason: undefined,
        integrationCommit: merged,
        ...appendAttempt({ ...attempt, finishedAt: new Date().toISOString(), outcome: "succeeded" }),
        times: { ...current.times, integratedAt: current.times.integratedAt ?? new Date().toISOString() },
      });
      return { ok: true, record: current };
    }
  });
}

/** worktree list --porcelain 里找 checkout 了指定分支的目录（无则 null）。 */
async function findWorktreeForBranch(repoRoot: string, fullBranchRef: string): Promise<string | null> {
  const list = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!list.ok) return null;
  let path: string | null = null;
  for (const line of list.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9).trim();
    else if (line.startsWith("branch ") && path && line.slice(7).trim() === fullBranchRef) return path;
  }
  return null;
}

function firstLine(s: string): string {
  return (s.trim().split("\n")[0] ?? "").slice(0, 160);
}

/** 拒绝终态写入（state 回 ready_for_review，attempt 保留现场记录）。 */
function failAttempt(
  db: DatabaseSync, record: WorkspaceRecord, attempt: IntegrationAttempt,
  outcome: IntegrationOutcome, detail: string,
): IntegrateResult {
  const finished: IntegrationAttempt = { ...attempt, finishedAt: new Date().toISOString(), outcome, detail: detail.slice(0, 240) };
  const updated: WorkspaceRecord = {
    ...record,
    state: "ready_for_review",
    failureReason: `${outcome}: ${detail}`.slice(0, 300),
    integrationAttempts: [...(record.integrationAttempts ?? []), finished],
    integrationJournal: [...(record.integrationJournal ?? []), { step: outcome, at: new Date().toISOString(), ok: false, detail: detail.slice(0, 240) }],
    revision: record.revision + 1,
  };
  upsertRecord(db, updated);
  return { ok: false, reason: outcome, record: updated };
}
