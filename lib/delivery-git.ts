/**
 * 交付专用的 Git 原语（execFile 封装，供验证快照与合并 CAS 复用）。
 * 全部操作都在给定 cwd 内执行，且不修改用户 worktree（快照走临时 index，
 * 合并走 update-ref + merge commit，绝不做 checkout/reset 到用户工作区）。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const p_execFile = promisify(execFile);

export type GitResult = { ok: boolean; stdout: string; stderr: string };

/** 执行 git 命令（单条，不落 shell 拼接，杜绝命令注入）。 */
export async function git(cwd: string, args: string[], opts?: { env?: Record<string, string> }): Promise<GitResult> {
  try {
    const { stdout } = await p_execFile("git", args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
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

/** 目录是否是 git 仓库。 */
export function isGitRepo(dir: string): boolean {
  return existsSync(`${dir}/.git`) || existsSync(`${dir}/.git/HEAD`);
}

/** 当前 HEAD 的完整 sha（非 git 仓库返回 undefined）。 */
export async function headSha(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ["rev-parse", "HEAD"]);
  return r.ok ? r.stdout.trim() || undefined : undefined;
}

/** 当前分支名（detached HEAD 时返回 undefined）。 */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!r.ok) return undefined;
  const name = r.stdout.trim();
  return name && name !== "HEAD" ? name : undefined;
}

/** 把分支短名/完整 ref 归一化为可 update-ref 的完整 ref（refs/heads/<name>）。 */
export function toBranchRef(name: string): string {
  if (name.startsWith("refs/")) return name;
  return `refs/heads/${name}`;
}

/** 生成目录树（不含 .git 与 worktree 容器）的稳定指纹。
 *  exclude：开发服务器可写缓存目录（spec §11.2 末段「预先声明并排除」）——
 *  这些路径的 untracked/变更不进指纹（服务跑起来写 .next 不能让快照恒 stale）；
 *  **tracked 源码变更永不排除**（排除不能掩盖应用源码变化）。
 *  未传 exclude 时逐字节保持旧算法（存量快照不因此失效）。 */
export async function worktreeFingerprint(cwd: string, exclude?: string[]): Promise<string> {
  // --porcelain=v1 输出「状态 + 路径」；-z 用 NUL 分隔避免路径带空格/换行。
  // 覆盖 tracked 变更 + untracked 文件（含未暂存与已暂存），是快照的核心组成。
  const status = await git(cwd, ["status", "--porcelain=v1", "-z"]);
  if (!status.ok) return `error:${status.stderr.slice(0, 120)}`;
  let raw = status.stdout;
  if (exclude && exclude.length > 0) {
    const isExcluded = (p: string) => exclude.some((d) => p === d || p === `${d}/` || p.startsWith(`${d}/`));
    // -z 每条记录以 \0 结尾「XY path\0」；只滤 untracked（??）——tracked 变更不排除
    raw = raw.split("\0").filter((entry) => {
      if (!entry.startsWith("?? ")) return true;
      return !isExcluded(entry.slice(3));
    }).map((e) => `${e}\0`).join("");
  }
  const hash = createHash("sha256");
  hash.update(raw);
  return hash.digest("hex");
}

/**
 * 用临时 Git index 把「已验证内容」物化为 immutable delivery commit/tree，
 * 不触碰用户 worktree（不动 HEAD、不 checkout、不修改 index 文件）。
 *
 * 原理：
 * 1. 读取当前 HEAD 的 tree 作为 base tree。
 * 2. 新建临时 index（GIT_INDEX_FILE 指向临时文件），先 read-tree 载入 base。
 * 3. add 工作区的全部变更（tracked 修改 + untracked 新增）到临时 index。
 * 4. write-tree 得到 delivery tree；commit-tree 得到 delivery commit。
 *
 * 这样即使之后用户/Agent/其它进程改了 worktree，delivery commit 仍保持不变。
 */
export async function materializeDeliveryCommit(
  cwd: string,
  tempIndexPath: string,
): Promise<{ treeSha: string; commitSha: string; parentSha?: string }> {
  const env = { GIT_INDEX_FILE: tempIndexPath };
  const parent = await headSha(cwd);

  // 用 HEAD 的 tree 作为临时 index 的起点；无 HEAD（空仓库）则用空 index。
  if (parent) {
    const readTree = await git(cwd, ["read-tree", parent], { env });
    if (!readTree.ok) throw new Error(`read-tree 失败：${readTree.stderr.slice(0, 200)}`);
  }

  // 把工作区全部变更载入临时 index（含 untracked，-A 等价 add -A）。
  const add = await git(cwd, ["add", "-A"], { env });
  if (!add.ok) throw new Error(`临时 index add 失败：${add.stderr.slice(0, 200)}`);

  const writeTree = await git(cwd, ["write-tree"], { env });
  if (!writeTree.ok) throw new Error(`write-tree 失败：${writeTree.stderr.slice(0, 200)}`);
  const treeSha = writeTree.stdout.trim();

  const commitArgs = ["commit-tree", treeSha];
  if (parent) commitArgs.push("-p", parent);
  commitArgs.push("-m", "lectern: delivery snapshot");
  const commit = await git(cwd, commitArgs, { env });
  if (!commit.ok) throw new Error(`commit-tree 失败：${commit.stderr.slice(0, 200)}`);
  const commitSha = commit.stdout.trim();

  return { treeSha, commitSha, parentSha: parent };
}

/**
 * Git compare-and-swap：原子地把 baseRef 从 expectedOld 更新为 newSha。
 * 对应 `git update-ref <baseRef> <newSha> <expectedOld>`。
 * 若 baseRef 当前值不等于 expectedOld（并发推进），则更新失败，返回 ok:false。
 * 这是「接受并合并」的原子性保障：base 并发变化时不会覆盖他人提交。
 */
export async function casUpdateRef(
  cwd: string,
  baseRef: string,
  newSha: string,
  expectedOld: string | undefined,
): Promise<GitResult> {
  // update-ref 需要完整 ref（refs/heads/<name>），短名会报 "unable to resolve reference"
  const ref = toBranchRef(baseRef);
  const args = expectedOld ? ["update-ref", ref, newSha, expectedOld] : ["update-ref", ref, newSha];
  return git(cwd, args);
}

/**
 * 服务端推导工作区变更文件清单（相对 HEAD，含 untracked 与 tracked 变更）。
 * 不信任客户端提交的 changedPaths——变更文件是证据的一部分，必须由服务端从 git 计算。
 */
export async function listChangedPaths(cwd: string): Promise<string[]> {
  const r = await git(cwd, ["status", "--porcelain=v1", "-z"]);
  if (!r.ok) return [];
  const raw = r.stdout;
  const parts = raw.split("\0").filter(Boolean);
  const paths: string[] = [];
  // porcelain -z 输出格式：每项为 "XY path"，rename 有 "R  old -> new"（含 \0 分隔）。
  // 简单起见按每项的前 3 字符取状态、余下取路径；rename 形态取 "->" 后的新路径。
  for (const part of parts) {
    const status = part.slice(0, 2);
    let path = part.slice(3);
    // rename/copy：格式 "R  old\0new"（git 用 NUL 分隔，这里已按 NUL split，
    // 所以 old 与 new 会变成两个 part；new 那个 part 无状态前缀）。
    // 处理 rename：当 path 含 " -> " 时取箭头后。
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    // 跳过状态为空格开头的续行（rename 的 new 路径）
    if (status.trim() === "" && path.trim() === "") continue;
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}
