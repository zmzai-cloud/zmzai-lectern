import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const rtFixture = vi.hoisted(() => ({ dir: "" }));
vi.mock("./runtime-constants", () => ({ get dataDir() { return rtFixture.dir; } }));
const ownerFixture = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock("./session-owner", () => ({ resolveSessionOwner: ownerFixture.owner }));
import { mergeSessionWorkspace, discardSessionWorkspace } from "./workspace-actions.js";
import { createWorkspace, type WorkspaceRecord } from "./workspace-service.js";
import { worktreeForSession } from "./worktree.js";

// 文件级共享 dataDir：delivery/worktrees 的 SQLite 句柄是模块级缓存，
// 逐用例换目录会让句柄指向已删除文件（delivery-owner.test.ts 同款约定）
const sharedBase = mkdtempSync(path.join(tmpdir(), "w1-s27-"));
afterAll(async () => { await rm(sharedBase, { recursive: true, force: true }); });

async function makeRepo(): Promise<{ root: string; dataDir: string }> {
  const root = mkdtempSync(path.join(sharedBase, "repo-"));
  const dataDir = path.join(sharedBase, "data");
  mkdirSync(dataDir, { recursive: true });
  execSync("git init -q -b main && git config user.email t@t && git config user.name t && echo hello > a.txt && git add . && git commit -qm init", { cwd: root, shell: "/bin/bash" });
  rtFixture.dir = dataDir;
  // 动态 owner：模拟真实 resolveSessionOwner——隔离会话的 effectiveWorkspaceRoot
  // 经 worktreeForSession 双读解析到 worktree 路径（创建前/普通会话回落主仓库）
  ownerFixture.owner.mockImplementation((sessionId: string) => {
    const wt = worktreeForSession(sessionId);
    return { sessionId, project: { id: "p", path: root }, effectiveWorkspaceRoot: wt ? wt.path : root };
  });
  return { root, dataDir };
}

describe("会话合并/丢弃动作（W1-S27-B）", () => {
  it("merge：走整合序列（目标=CAS 锚点/工作区保留）；无隔离副本 409", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const none = await mergeSessionWorkspace("ses_none");
      expect(none.ok).toBe(false);
      expect(none.status).toBe(409);

      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_b1" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      execSync("echo act > act.txt && git add . && git commit -qm act", { cwd: created.record.path, shell: "/bin/bash" });

      const merged = await mergeSessionWorkspace("ses_b1");
      expect(merged.ok).toBe(true);
      // 整合产物进了目标分支
      expect(existsSync(path.join(root, "act.txt"))).toBe(true);
      // W06：工作区保留（旧 mergeWorktree 成功即删目录的行为废止）
      expect(existsSync(created.record.path)).toBe(true);
      // 记录面：integrated
      const db = new (await import("node:sqlite")).DatabaseSync(path.join(dataDir, "worktrees.db"));
      const rec = JSON.parse((db.prepare("SELECT json FROM workspace_records WHERE workspace_id = ?").get("ws_ses_b1") as { json: string }).json) as WorkspaceRecord;
      expect(rec.state).toBe("integrated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("merge 交付门：有进行中的 delivery attempt → 409 拒绝（不得绕过交付检查）", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_b2" });
      if (!created.ok) return;
      execSync("echo act > act.txt && git add . && git commit -qm act", { cwd: created.record.path, shell: "/bin/bash" });
      // 造一个进行中的 attempt（begin 后未终结）
      const { beginAttempt } = await import("./delivery.js");
      beginAttempt({ sessionId: "ses_b2", projectId: "p", effectiveWorkspaceRoot: created.record.path }, "run_gate");

      const refused = await mergeSessionWorkspace("ses_b2");
      expect(refused.ok).toBe(false);
      expect(refused.status).toBe(409);
      expect(refused.output).toContain("交付");
      // 目标未被碰
      expect(existsSync(path.join(root, "act.txt"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discard：目录/分支/映射清理（W06 不误删可修复）；merge 后 discard 幂等成功", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_b3" });
      if (!created.ok) return;
      execSync("echo act > act.txt && git add . && git commit -qm act", { cwd: created.record.path, shell: "/bin/bash" });

      const discarded = await discardSessionWorkspace("ses_b3");
      expect(discarded.ok).toBe(true);
      expect(existsSync(created.record.path)).toBe(false);
      expect(execSync("git rev-parse --verify lectern/wt/ses_b3 2>/dev/null || echo gone", { cwd: root, shell: "/bin/bash" }).toString().trim()).toBe("gone");
      expect(worktreeForSession("ses_b3")).toBeNull();

      // integrated 后 discard（清整走人）也走通；再 discard 无记录幂等成功
      const c2 = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_b4" });
      expect(c2.ok).toBe(true);
      if (!c2.ok) return;
      execSync("echo act2 > act2.txt && git add . && git commit -qm act2", { cwd: c2.record.path, shell: "/bin/bash" });
      const merged = await mergeSessionWorkspace("ses_b4");
      expect(merged.ok).toBe(true);
      const discarded2 = await discardSessionWorkspace("ses_b4");
      expect(discarded2.ok).toBe(true);
      expect(existsSync(c2.record.path)).toBe(false);
      expect((await discardSessionWorkspace("ses_b4")).ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("delivery mergeAttemptCas 委托：workspace 会话接受 → 整合序列执行（journal 在案/工作区保留）", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_b5" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const wt = created.record.path;
      execSync("echo s1 > s1.txt && git add . && git commit -qm s1", { cwd: wt, shell: "/bin/bash" });

      const delivery = await import("./delivery.js");
      const owner = delivery.resolveOwner("ses_b5")!;
      const attempt = delivery.beginAttempt(owner, "run_w1");
      const verifying = await delivery.transitionToVerifying(attempt.id);
      expect(verifying.verificationSnapshot?.deliveryCommitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(verifying.verificationSnapshot?.targetHeadSha).toBe(created.record.baseCommit); // 目标锚点在 verify 时捕获
      const finished = delivery.finishVerification(attempt.id); // 无 required runs → unverified(no_required_checks)

      // no_required_checks 二次确认后接受 → 委托整合
      const merged = await delivery.mergeAttemptCas(finished.id, true);
      expect(merged.ok).toBe(true);
      if (!merged.ok) return;
      expect(merged.baseRef).toBe("main");
      expect(existsSync(path.join(root, "s1.txt"))).toBe(true);
      // 工作区保留 + journal 在案（整合序列真跑了，不是旧 commit-tree 直合）
      expect(existsSync(wt)).toBe(true);
      const db = new (await import("node:sqlite")).DatabaseSync(path.join(dataDir, "worktrees.db"));
      const rec = JSON.parse((db.prepare("SELECT json FROM workspace_records WHERE workspace_id = ?").get("ws_ses_b5") as { json: string }).json) as WorkspaceRecord;
      expect(rec.state).toBe("integrated");
      expect(rec.integrationJournal?.some((s) => s.step === "merge" && s.ok)).toBe(true);
      expect(rec.integrationSource).toBe(verifying.verificationSnapshot?.deliveryCommitSha); // 合并源=delivery commit
      // main 的 tip = 整合 merge commit
      expect(execSync("git rev-parse main", { cwd: root }).toString().trim()).toBe(rec.integrationCommit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("delivery 委托：验证后目标推进 → 拒绝（targetHeadSha 锚点，需重新验证）", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_b6" });
      if (!created.ok) return;
      execSync("echo s1 > s1.txt && git add . && git commit -qm s1", { cwd: created.record.path, shell: "/bin/bash" });

      const delivery = await import("./delivery.js");
      const owner = delivery.resolveOwner("ses_b6")!;
      const attempt = delivery.beginAttempt(owner, "run_w1");
      const verifying = await delivery.transitionToVerifying(attempt.id);
      const finished = delivery.finishVerification(attempt.id);

      // 验证后目标被推进（别人合了东西进 main）
      execSync("echo other > other.txt && git add . && git commit -qm other", { cwd: root, shell: "/bin/bash" });

      const merged = await delivery.mergeAttemptCas(finished.id, true);
      expect(merged.ok).toBe(false);
      if (merged.ok) return;
      expect(merged.reason).toBe("base_ref_moved");
      expect(merged.detail).toContain("目标");
      // 目标未被 CAS 强推：other.txt 在、s1.txt 不在
      expect(existsSync(path.join(root, "other.txt"))).toBe(true);
      expect(existsSync(path.join(root, "s1.txt"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
