// 发版门禁：目标 commit 上渲染层 E2E（`ui-e2e` workflow）未通过时拒绝发布。
//
// 【为什么是「本地查 API」而不是 required status checks】
// 本仓 public、main 无分支保护，`required_status_checks` 需要先在仓库设置里开分支
// 保护才能生效；而方案 A 用最小改动就拿到了 fail-closed。代价是引入对 GitHub API
// 的依赖——所以查询失败必须当作「未通过」，见下。
//
// 【为什么不去改 ui-e2e.yml 的触发条件让它更好过】
// 本仓 public、CI 分钟免费，加 `paths-ignore` 省不了钱；而将来一旦开分支保护，
// docs-only PR 的 required check 会因为没有 run 而永远 pending，把合并卡死。
//
// 【fail closed 的三条】
// 1. `gh` 不可用 / 无权限 / 网络失败        → 拒绝（reason: query_failed）
// 2. 该 commit 上查不到 ui-e2e 的 run       → 拒绝（reason: no_run）
// 3. 最近一次完成的 run 不是 success        → 拒绝（reason: failed / pending）
// 错误信息必须区分「查不到」与「查到了但没通过」，否则运维时无法快速定位。
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEFAULT_WORKFLOW = "ui-e2e.yml";

/** 唯一算「通过」的结论。`neutral` / `skipped` / `cancelled` 一律不算——
 *  一个被 `cancel-in-progress` 取消的 run 恰恰是**没有跑完**的那种，
 *  把它当成通过就等于门禁在最需要它的时候失效。 */
const PASSING_CONCLUSION = "success";

/** run 的排序时间。`run_started_at` 在 queued 阶段为空，退回 `created_at`。 */
function startedAt(run) {
  const raw = run?.run_started_at ?? run?.created_at ?? run?.updated_at;
  const parsed = Date.parse(raw ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * 判定矩阵（纯函数，不碰网络）。输入是 GitHub `/actions/workflows/{f}/runs` 返回的
 * `workflow_runs` 数组。
 *
 * 【为什么按「最近一次完成的 run」判定，而不是「存在任一 success」】
 * 同一个 commit 上可以有多个 run（手动 workflow_dispatch 重跑、或 dispatch 与 push
 * 撞在一起）。此时用户想知道的是「现在这个 commit 算不算过了」，答案是最后一次
 * 判定的结果——一个先绿后红（flaky）的 commit 不该凭那个绿拿到发布资格。
 */
export function judgeRuns(runs, options = {}) {
  const sha = typeof options.sha === "string" && options.sha ? options.sha : "(未指定)";
  const workflow = options.workflow ?? DEFAULT_WORKFLOW;
  const list = Array.isArray(runs) ? runs.filter(Boolean) : [];

  if (list.length === 0) {
    return {
      ok: false,
      reason: "no_run",
      detail: `${sha} 上查不到 ${workflow} 的运行记录——渲染层 E2E 从未在该 commit 上跑过，按未通过处理。`,
    };
  }

  const finished = list
    .filter((run) => typeof run.conclusion === "string" && run.conclusion.length > 0)
    .sort((a, b) => startedAt(b) - startedAt(a));

  if (finished.length === 0) {
    const statuses = [...new Set(list.map((run) => run.status ?? "unknown"))].join(", ");
    return {
      ok: false,
      reason: "pending",
      detail: `${sha} 上 ${workflow} 的所有运行都还没结束（${statuses}）——发布前必须等到结论，按未通过处理。`,
    };
  }

  const latest = finished[0];
  if (latest.conclusion === PASSING_CONCLUSION) {
    return {
      ok: true,
      reason: "success",
      detail: `${sha} 上 ${workflow} 最近一次完成的运行通过（run ${latest.id}）。`,
      latest,
    };
  }

  return {
    ok: false,
    reason: "failed",
    detail: `${sha} 上 ${workflow} 最近一次完成的运行结论是 "${latest.conclusion}"（run ${latest.id}${latest.html_url ? ` · ${latest.html_url}` : ""}）。`,
    latest,
  };
}

/** 从 git remote URL 解析 `owner/repo`。支持 ssh 与 https 两种写法。 */
export function parseRepoFromRemote(url) {
  if (typeof url !== "string") return null;
  const match = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function tryExec(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      timeout: options.timeout ?? 20000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/** 当前 HEAD 的完整 sha。短 sha 会被 GitHub 的 `head_sha` 过滤漏掉，所以一律归一化。 */
export function currentSha(cwd) {
  return tryExec("git", ["rev-parse", "HEAD"], { cwd });
}

export function normalizeSha(sha, cwd) {
  if (typeof sha !== "string" || !sha) return currentSha(cwd);
  // 已经是完整 40/64 位十六进制就直接用，否则交给 git 解析（同时验证它确实存在）。
  if (/^[0-9a-f]{40}$/i.test(sha) || /^[0-9a-f]{64}$/i.test(sha)) return sha;
  return tryExec("git", ["rev-parse", sha], { cwd }) ?? sha;
}

/** 解析目标仓库。先读本地 git remote（快、无网络），失败再问 gh。 */
export function resolveRepo({ cwd } = {}) {
  const remote = tryExec("git", ["config", "--get", "remote.origin.url"], { cwd });
  const parsed = parseRepoFromRemote(remote ?? "");
  if (parsed) return parsed;
  const fromGh = tryExec("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd, timeout: 30000 });
  return fromGh || null;
}

/** 查目标 commit 的 workflow 运行记录。失败时抛出（调用方转成 fail-closed 结论）。
 *
 *  `exec` 是**测试接缝**：默认就是 `execFileSync`，单测用替身模拟「gh 不存在 /
 *  网络失败 / 返回非 JSON」，从而验证这三种情况都 fail closed。产品路径不传它。 */
export function fetchRuns({ repo, sha, workflow = DEFAULT_WORKFLOW, cwd, exec = execFileSync } = {}) {
  const path = `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`;
  let raw;
  try {
    raw = exec("gh", ["api", "--method", "GET", path], {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const reason = stderr || error?.message || "未知错误";
    throw new Error(`gh api 调用失败：${reason.split("\n").slice(0, 3).join(" / ")}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("gh api 返回的不是 JSON");
  }
  return Array.isArray(parsed.workflow_runs) ? parsed.workflow_runs : [];
}

/**
 * 完整门禁：解析 sha / 仓库 → 查询 → 判定。**永不抛出**，一律返回结论对象，
 * 好让调用方把「查不到」与「没通过」分开报给用户。
 */
export function checkUiE2eGate(input = {}) {
  const workflow = input.workflow ?? DEFAULT_WORKFLOW;
  const sha = normalizeSha(input.sha, input.cwd);
  if (!sha) {
    return { ok: false, reason: "unresolved_sha", detail: "无法确定要检查的 commit（不在 git 仓库里，或 git 不可用）。" };
  }
  const repo = input.repo || resolveRepo({ cwd: input.cwd });
  if (!repo) {
    return { ok: false, reason: "unresolved_repo", sha, detail: "无法确定 GitHub 仓库（git remote 与 gh 都读不到）。" };
  }
  let runs;
  try {
    runs = fetchRuns({ repo, sha, workflow, cwd: input.cwd, exec: input.exec });
  } catch (error) {
    return {
      ok: false,
      reason: "query_failed",
      sha,
      repo,
      workflow,
      detail: `${error.message}——查不到结论时按未通过处理（fail closed）。`,
    };
  }
  return { ...judgeRuns(runs, { sha, workflow }), sha, repo, workflow };
}

/** 人类可读的一行结论。 */
export function formatGateResult(result) {
  const head = result.ok ? "✓ 渲染层 E2E 门禁通过" : "✗ 渲染层 E2E 门禁未通过";
  return `${head} · ${result.detail}`;
}

/** 是否作为 CLI 直接运行。
 *
 *  不能用 `new URL("file://" + argv[1])`：Windows 的 `C:\…` 会拼成无效 URL 并
 *  在模块加载期抛异常——而本模块是被 `upload-oss.mjs` import 的，那等于把发布
 *  脚本一起带崩。`pathToFileURL` 才是能处理两个平台路径的写法。 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const result = checkUiE2eGate({
    sha: valueOf("--sha"),
    repo: valueOf("--repo"),
    workflow: valueOf("--workflow"),
    cwd: process.cwd(),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatGateResult(result));
    if (!result.ok && result.latest?.html_url) console.log(`  运行详情：${result.latest.html_url}`);
  }
  process.exit(result.ok ? 0 : 1);
}
