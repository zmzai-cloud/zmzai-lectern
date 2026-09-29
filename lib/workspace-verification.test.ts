import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
// Vite 内置枚举不含 node:sqlite（仓库既有约定）：workspace-service 顶层
// import node:sqlite，不 mock 会在收集阶段 "Failed to load url sqlite"。
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
import { createWorkspace, integrateWorkspace, markReadyForReview, type WorkspaceRecord } from "./workspace-service.js";

/** T10 / PC13（production-chain-closure，spec 2026-09-28 §4.4 / F06）：
 *  整合必须对**实际合并结果**执行 VerificationPlan——两边各自的检查都通过、
 *  组合后失败时，目标 ref 一律不推进；验证证据（mergeCommit/指纹/计划版本）
 *  落库进 attempt；修复源后重试走重新合并+重新验证。
 *
 *  组合失败 fixture（文本无冲突、语义破坏）：check = version <= limit。
 *  base: version=1 limit=10；源改 version=6（单侧绿）；目标改 limit=3（单侧绿）；
 *  合并后 6>3 → required 检查红。 */

const PLAN = {
  version: "v1",
  // 组合语义检查：version <= limit，或源分支显式豁免（allow-high-version.txt
  // 只会由源侧添加——修复路径触碰它，与目标侧改动的 limit.txt 不同文件，重试
  // 合并保持无文本冲突）。
  checks: [{ id: "consistency", label: "版本不超上限", command: "test $(cat version.txt) -le $(cat limit.txt) || test -f allow-high-version.txt", required: true }],
};

function git(root: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: root, shell: "/bin/bash" }).toString().trim();
}

async function makeRepo(): Promise<{ root: string; dataDir: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "t10-pc13-"));
  const root = path.join(base, "repo");
  const dataDir = path.join(base, "data");
  mkdirSync(root, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.join(root, ".lectern"), { recursive: true });
  writeFileSync(path.join(root, "version.txt"), "1\n");
  writeFileSync(path.join(root, "limit.txt"), "10\n");
  writeFileSync(path.join(root, ".lectern", "verification.json"), JSON.stringify(PLAN, null, 2));
  execSync(
    "git init -q -b main && git config user.email t@t && git config user.name t && git add . && git commit -qm init",
    { cwd: root, shell: "/bin/bash" },
  );
  return { root, dataDir };
}

const nodeRequire = createRequire(import.meta.url);

function readRecord(dataDir: string, workspaceId: string): WorkspaceRecord {
  const DatabaseSync = nodeRequire("node:sqlite").DatabaseSync;
  const db = new DatabaseSync(path.join(dataDir, "worktrees.db"));
  try {
    const row = db.prepare("SELECT json FROM workspace_records WHERE workspace_id = ?").get(workspaceId) as { json: string };
    return JSON.parse(row.json) as WorkspaceRecord;
  } finally {
    db.close();
  }
}

describe("T10/PC13：合并结果实检——组合失败目标不推进", () => {
  it("两侧各自绿、组合红：verification-failed，目标 ref 不动；修复源后重试重新合并验证并推进", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_pc13" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const wt = created.record.path;

      // 源侧：version 1→6（单侧检查绿：6<=10）
      writeFileSync(path.join(wt, "version.txt"), "6\n");
      execSync("git add . && git commit -qm bump-version", { cwd: wt, shell: "/bin/bash" });
      execSync("test $(cat version.txt) -le $(cat limit.txt) || test -f allow-high-version.txt", { cwd: wt, shell: "/bin/bash" });
      // 目标侧（审查后推进）：limit 10→3（单侧检查绿：1<=3）
      writeFileSync(path.join(root, "limit.txt"), "3\n");
      execSync("git add . && git commit -qm tighten-limit", { cwd: root, shell: "/bin/bash" });
      execSync("test $(cat version.txt) -le $(cat limit.txt) || test -f allow-high-version.txt", { cwd: root, shell: "/bin/bash" });
      const expectedTarget = git(root, "rev-parse main");

      markReadyForReview(dataDir, created.record.workspaceId);
      const failed = await integrateWorkspace(dataDir, created.record.workspaceId, {
        expectedTargetCommit: expectedTarget,
      });
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      expect(failed.reason).toBe("verification-failed");
      const record = failed.record!;
      // 状态回可重试；锚点保留（merge commit 已存在仓库，重试去重用）
      expect(record.state).toBe("ready_for_review");
      expect(record.failureReason).toContain("verification-failed");
      expect(record.integrationCommit).toMatch(/^[0-9a-f]{40}$/);
      const lastAttempt = record.integrationAttempts!.at(-1)!;
      expect(lastAttempt.outcome).toBe("verification-failed");
      expect(lastAttempt.mergeCommit).toBe(record.integrationCommit);
      expect(lastAttempt.verification?.outcome).toBe("failed");
      expect(lastAttempt.verification?.checks[0]).toMatchObject({ id: "consistency", required: true, ok: false });
      expect(lastAttempt.verification?.planVersion).toBe("v1");
      // journal：进入验证阶段并失败；不存在 ready-to-advance（放行次序）
      const steps = (record.integrationJournal ?? []).map((s) => s.step);
      expect(steps).toContain("merged");
      expect(steps).toContain("verifying");
      expect(steps).toContain("verification-failed");
      expect(steps).not.toContain("ready-to-advance");
      // 目标未被推进：main 仍在 expected，合并提交不在 main 的历史里
      expect(git(root, "rev-parse main")).toBe(expectedTarget);
      expect(git(root, `merge-base --is-ancestor ${record.integrationCommit} main || echo NOT-IN-MAIN`)).toBe("NOT-IN-MAIN");
      // 临时整合树已清（证据在 record：commit + 指纹）
      expect(existsSync(path.join(root, ".lectern-worktrees", ".integration-ses_pc13"))).toBe(false);

      // 修复源（显式豁免：源侧新增 allow-high-version.txt，新源提交——只动源
      // 侧文件，重试合并与目标侧 limit.txt 改动无文本冲突）
      writeFileSync(path.join(wt, "allow-high-version.txt"), "approved by feature owner\n");
      execSync("git add . && git commit -qm allow-high-version", { cwd: wt, shell: "/bin/bash" });
      const fixed = await integrateWorkspace(dataDir, created.record.workspaceId, {
        expectedTargetCommit: expectedTarget,
      });
      expect(fixed.ok).toBe(true);
      if (!fixed.ok) return;
      expect(fixed.record.state).toBe("integrated");
      const okAttempt = fixed.record.integrationAttempts!.at(-1)!;
      expect(okAttempt.verification?.outcome).toBe("passed");
      expect(okAttempt.verification?.checks[0]?.ok).toBe(true);
      const okSteps = (fixed.record.integrationJournal ?? []).map((s) => s.step);
      expect(okSteps).toContain("verification-passed");
      expect(okSteps).toContain("ready-to-advance");
      // 目标确已推进到本轮 merge commit，且工作树内容是合并结果（version=6, limit=20）
      expect(git(root, "rev-parse main")).toBe(fixed.record.integrationCommit);
      expect(readFileSync(path.join(root, "version.txt"), "utf8")).toBe("6\n");
      expect(readFileSync(path.join(root, "limit.txt"), "utf8")).toBe("3\n");
      expect(existsSync(path.join(root, "allow-high-version.txt"))).toBe(true);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  }, 60_000);

  it("无 required 检查：未显式接受 → unverified 拒绝；acceptUnverified → 放行且证据标注 unverified", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "t10-unv-"));
    const root = path.join(base, "repo");
    const dataDir = path.join(base, "data");
    mkdirSync(root, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    execSync("git init -q -b main && git config user.email t@t && git config user.name t && echo hi > a.txt && git add . && git commit -qm init", { cwd: root, shell: "/bin/bash" });
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_unv" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      execSync("echo src > s.txt && git add . && git commit -qm src", { cwd: created.record.path, shell: "/bin/bash" });
      const expected = git(root, "rev-parse main");
      markReadyForReview(dataDir, created.record.workspaceId);

      // 无计划（fixture 仓库没有 .lectern/verification.json）且未显式接受 → 拒绝，目标不动
      const refused = await integrateWorkspace(dataDir, created.record.workspaceId, { expectedTargetCommit: expected });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.reason).toBe("unverified");
      expect(refused.record!.state).toBe("ready_for_review");
      expect(refused.record!.integrationAttempts!.at(-1)!.verification?.outcome).toBe("unverified");
      expect(git(root, "rev-parse main")).toBe(expected);

      // 显式接受（既有产品流程）→ 放行，attempt 证据如实标注 unverified
      const accepted = await integrateWorkspace(dataDir, created.record.workspaceId, { expectedTargetCommit: expected, acceptUnverified: true });
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) return;
      const attempt = accepted.record.integrationAttempts!.at(-1)!;
      expect(attempt.verification?.outcome).toBe("unverified");
      const steps = (accepted.record.integrationJournal ?? []).map((s) => s.step);
      expect(steps).toContain("verification-accepted-unverified");
      expect(steps).toContain("ready-to-advance");
      expect(git(root, "rev-parse main")).toBe(accepted.record.integrationCommit);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("T11/PC14：整合恢复与竞态（验证期间目标推进/中断恢复）", () => {
  it("验证期间目标推进：验证通过但推进时 CAS 复查拒绝，目标不被覆盖，锚点保留", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_race" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      execSync("echo src > s.txt && git add . && git commit -qm src", { cwd: created.record.path, shell: "/bin/bash" });
      const expected = git(root, "rev-parse main");
      markReadyForReview(dataDir, created.record.workspaceId);

      // 注入的 runner 模拟「验证执行期间并发推进目标」：返回 passed 的同时
      // 目标分支已前进（外部推送/另一整合）。
      let runnerCalls = 0;
      const result = await integrateWorkspace(dataDir, created.record.workspaceId, {
        expectedTargetCommit: expected,
        verification: {
          plan: PLAN,
          runner: async () => {
            runnerCalls += 1;
            writeFileSync(path.join(root, "race.txt"), "concurrent\n");
            execSync("git add . && git commit -qm concurrent-advance", { cwd: root, shell: "/bin/bash" });
            return { outcome: "passed", planVersion: "v1", checks: [{ id: "consistency", required: true, ok: true, exitCode: 0, timedOut: false, outputTail: "" }], ranAt: new Date().toISOString() };
          },
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(["target-moved", "cas-failed", "not-fast-forward"]).toContain(result.reason);
      // 验证确实跑过（证据已落 attempt）
      expect(runnerCalls).toBe(1);
      const attempt = result.record!.integrationAttempts!.at(-1)!;
      expect(attempt.verification?.outcome).toBe("passed");
      expect(attempt.mergeCommit).toBe(result.record!.integrationCommit);
      // 目标保持并发推进后的提交（不被合并结果覆盖），合并提交不在 main
      expect(git(root, "rev-parse main")).not.toBe(result.record!.integrationCommit);
      expect(git(root, `merge-base --is-ancestor ${result.record!.integrationCommit} main || echo NOT-IN-MAIN`)).toBe("NOT-IN-MAIN");
      // 可重试状态 + 锚点保留
      expect(result.record!.state).toBe("ready_for_review");
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  }, 60_000);

  it("ready_to_advance 中断恢复：重试验证后复用 merge commit（不重复合并）再推进", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_resume" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const wt = created.record.path;
      writeFileSync(path.join(wt, "version.txt"), "6\n");
      writeFileSync(path.join(wt, "limit.txt"), "20\n");
      execSync("git add . && git commit -qm src", { cwd: wt, shell: "/bin/bash" });
      const sourceTip = git(root, `rev-parse ${created.record.branch}`);
      const expected = git(root, "rev-parse main");
      markReadyForReview(dataDir, created.record.workspaceId);

      // 第一轮：注入的 runner 报失败（环境抖动/检查脚本自身问题）——留下
      // merge commit 锚点 + ready_for_review。源不变，重试走恢复路径。
      const failing = { outcome: "failed" as const, planVersion: "v1", checks: [{ id: "consistency", required: true, ok: false, exitCode: 1, timedOut: false, outputTail: "flaky env" }], ranAt: new Date().toISOString() };
      const first = await integrateWorkspace(dataDir, created.record.workspaceId, {
        expectedTargetCommit: expected,
        verification: { plan: PLAN, runner: async () => failing },
      });
      expect(first.ok).toBe(false);
      if (first.ok) return;
      expect(first.reason).toBe("verification-failed");
      const anchor = first.record!.integrationCommit!;

      // 模拟中断点后移：状态拨到 ready_to_advance（= 已过验证、推进前被杀）
      const DatabaseSync = nodeRequire("node:sqlite").DatabaseSync;
      const db = new DatabaseSync(path.join(dataDir, "worktrees.db"));
      try {
        const row = db.prepare("SELECT json FROM workspace_records WHERE workspace_id = ?").get(created.record.workspaceId) as { json: string };
        const rec = JSON.parse(row.json) as WorkspaceRecord;
        rec.state = "ready_to_advance";
        db.prepare("UPDATE workspace_records SET json = ? WHERE workspace_id = ?").run(JSON.stringify(rec), created.record.workspaceId);
      } finally {
        db.close();
      }

      // 恢复：同一 merge commit 重新验证（注入 runner 本轮通过——验证证据
      // 必须重建，恢复不允许凭旧证据免检）→ 复用锚点推进，不重复合并
      const resumed = await integrateWorkspace(dataDir, created.record.workspaceId, {
        expectedTargetCommit: expected,
        verification: { plan: PLAN, runner: async () => ({ outcome: "passed", planVersion: "v1", checks: [{ id: "consistency", required: true, ok: true, exitCode: 0, timedOut: false, outputTail: "" }], ranAt: new Date().toISOString() }) },
      });
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.record.state).toBe("integrated");
      const attempt = resumed.record.integrationAttempts!.at(-1)!;
      expect(attempt.reusedMergeCommit).toBe(true);
      expect(attempt.mergeCommit).toBe(anchor);
      expect(attempt.verification?.outcome).toBe("passed");
      expect(attempt.source).toBe(sourceTip);
      expect(git(root, "rev-parse main")).toBe(anchor);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  }, 60_000);
});
