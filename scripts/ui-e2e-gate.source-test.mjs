import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUiE2eGate, judgeRuns, parseRepoFromRemote, resolveRepo } from "./ui-e2e-gate.mjs";

const SHA = "a".repeat(40);

function run(overrides = {}) {
  return {
    id: 1,
    status: "completed",
    conclusion: "success",
    created_at: "2026-09-18T00:00:00Z",
    run_started_at: "2026-09-18T00:00:00Z",
    html_url: "https://github.com/example/project/actions/runs/1",
    ...overrides,
  };
}

// ── 判定矩阵 ────────────────────────────────────────────────────────────────
// 「通过」只有一种：最近一次**完成**的 run 结论是 success。下面每一条都对应
// 一个真实会发生的场景，尤其是 cancelled——它正是 `cancel-in-progress` 留下的
// 那种「没跑完」，把它当通过等于门禁在该生效时失效。
for (const [name, runs, expected] of [
  ["空列表（从未跑过）", [], { ok: false, reason: "no_run" }],
  ["只有排队中/进行中", [run({ status: "queued", conclusion: "" }), run({ status: "in_progress", conclusion: "" })], { ok: false, reason: "pending" }],
  ["成功", [run()], { ok: true, reason: "success" }],
  ["失败", [run({ conclusion: "failure" })], { ok: false, reason: "failed" }],
  ["被取消", [run({ conclusion: "cancelled" })], { ok: false, reason: "failed" }],
  ["被跳过", [run({ conclusion: "skipped" })], { ok: false, reason: "failed" }],
  ["中性", [run({ conclusion: "neutral" })], { ok: false, reason: "failed" }],
  ["超时", [run({ conclusion: "timed_out" })], { ok: false, reason: "failed" }],
]) {
  test(`judgeRuns: ${name}`, () => {
    const verdict = judgeRuns(runs, { sha: SHA });
    assert.equal(verdict.ok, expected.ok, verdict.detail);
    assert.equal(verdict.reason, expected.reason, verdict.detail);
  });
}

test("judgeRuns: 同一 commit 上先失败后成功（重跑）取最新 → 通过", () => {
  const verdict = judgeRuns(
    [run({ id: 1, conclusion: "failure", run_started_at: "2026-09-18T00:00:00Z" }), run({ id: 2, conclusion: "success", run_started_at: "2026-09-18T01:00:00Z" })],
    { sha: SHA },
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.latest.id, 2);
});

test("judgeRuns: 先成功后失败（flaky 复现）取最新 → 拒绝", () => {
  const verdict = judgeRuns(
    [run({ id: 1, conclusion: "success", run_started_at: "2026-09-18T00:00:00Z" }), run({ id: 2, conclusion: "failure", run_started_at: "2026-09-18T01:00:00Z" })],
    { sha: SHA },
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "failed");
  assert.equal(verdict.latest.id, 2);
});

test("judgeRuns: 被取消后重跑成功 → 通过", () => {
  const verdict = judgeRuns(
    [run({ id: 1, conclusion: "cancelled", run_started_at: "2026-09-18T00:00:00Z" }), run({ id: 2, conclusion: "success", run_started_at: "2026-09-18T02:00:00Z" })],
    { sha: SHA },
  );
  assert.equal(verdict.ok, true);
});

test("judgeRuns: 已有成功结论、另有 run 仍在排队 → 通过（在跑的那次不能否定既有结论）", () => {
  const verdict = judgeRuns(
    [run({ id: 1, conclusion: "success", run_started_at: "2026-09-18T00:00:00Z" }), run({ id: 2, status: "queued", conclusion: "", created_at: "2026-09-18T03:00:00Z" })],
    { sha: SHA },
  );
  assert.equal(verdict.ok, true);
});

test("judgeRuns: 用 run_started_at 缺省时退回 created_at 排序", () => {
  const verdict = judgeRuns(
    [run({ id: 1, conclusion: "success", run_started_at: undefined, created_at: "2026-09-18T00:00:00Z" }), run({ id: 2, conclusion: "failure", run_started_at: undefined, created_at: "2026-09-18T09:00:00Z" })],
    { sha: SHA },
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.latest.id, 2);
});

// ── fail closed ─────────────────────────────────────────────────────────────
// 三种「查不到结论」的情形都必须拒绝，并且错误信息要能区分病因——否则发版时
// 看到一句「门禁未通过」根本不知道该去修 CI 还是修网络。
const failCases = [
  ["gh 不存在", () => { throw Object.assign(new Error("spawn gh ENOENT"), { stderr: "gh: command not found" }); }],
  ["网络失败", () => { throw Object.assign(new Error("exit 1"), { stderr: "error connecting to api.github.com" }); }],
  ["无权限", () => { throw Object.assign(new Error("exit 1"), { stderr: "HTTP 403: Resource not accessible by integration" }); }],
];

for (const [name, exec] of failCases) {
  test(`checkUiE2eGate: ${name} → 拒绝（query_failed）`, () => {
    const result = checkUiE2eGate({ sha: SHA, repo: "example/project", exec });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "query_failed");
    assert.match(result.detail, /fail closed/);
  });
}

test("checkUiE2eGate: gh 返回非 JSON → 拒绝", () => {
  const result = checkUiE2eGate({ sha: SHA, repo: "example/project", exec: () => "<html>502</html>" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "query_failed");
  assert.match(result.detail, /不是 JSON/);
});

test("checkUiE2eGate: 不在 git 仓库且未给 sha → 拒绝（unresolved_sha）", () => {
  const dir = mkdtempSync(join(tmpdir(), "lectern-gate-nogit-"));
  try {
    const result = checkUiE2eGate({ cwd: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unresolved_sha");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 正常路径（注入的 exec 返回真实结构）────────────────────────────────────
test("checkUiE2eGate: 绿 → 通过，并回填 sha/repo/workflow", () => {
  const result = checkUiE2eGate({
    sha: SHA,
    repo: "example/project",
    exec: (command, args) => {
      assert.equal(command, "gh");
      assert.match(args.join(" "), /repos\/example\/project\/actions\/workflows\/ui-e2e\.yml\/runs/);
      assert.match(args.join(" "), new RegExp(`head_sha=${SHA}`));
      return JSON.stringify({ total_count: 1, workflow_runs: [run()] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.sha, SHA);
  assert.equal(result.repo, "example/project");
  assert.equal(result.workflow, "ui-e2e.yml");
});

test("checkUiE2eGate: 查到了但失败 → 拒绝，且信息带运行链接", () => {
  const result = checkUiE2eGate({
    sha: SHA,
    repo: "example/project",
    exec: () => JSON.stringify({ workflow_runs: [run({ id: 7, conclusion: "failure", html_url: "https://github.com/example/project/actions/runs/7" })] }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.match(result.detail, /runs\/7/);
});

test("checkUiE2eGate: 查不到任何 run → 拒绝（no_run，与「查到了但失败」区分开）", () => {
  const result = checkUiE2eGate({
    sha: SHA,
    repo: "example/project",
    exec: () => JSON.stringify({ total_count: 0, workflow_runs: [] }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_run");
  assert.match(result.detail, /从未在该 commit 上跑过/);
});

// ── 仓库解析 ────────────────────────────────────────────────────────────────
for (const [name, url, expected] of [
  ["ssh 带 .git", "git@github.com:zmzai-cloud/zmzai-lectern.git", "zmzai-cloud/zmzai-lectern"],
  ["ssh 不带 .git", "git@github.com:zmzai-cloud/zmzai-lectern", "zmzai-cloud/zmzai-lectern"],
  ["https 带 .git", "https://github.com/zmzai-cloud/zmzai-lectern.git", "zmzai-cloud/zmzai-lectern"],
  ["https 不带 .git", "https://github.com/zmzai-cloud/zmzai-lectern", "zmzai-cloud/zmzai-lectern"],
  ["https 带凭证", "https://user:token@github.com/zmzai-cloud/zmzai-lectern.git", "zmzai-cloud/zmzai-lectern"],
  ["非 github 主机", "https://gitlab.com/o/r.git", null],
  ["空串", "", null],
  ["非字符串", null, null],
]) {
  test(`parseRepoFromRemote: ${name}`, () => {
    assert.equal(parseRepoFromRemote(url), expected);
  });
}

test("resolveRepo: 从本地 git remote 解析（离线，不问 gh）", () => {
  const dir = mkdtempSync(join(tmpdir(), "lectern-gate-remote-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:example/project.git"], { cwd: dir, stdio: "ignore" });
    assert.equal(resolveRepo({ cwd: dir }), "example/project");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
