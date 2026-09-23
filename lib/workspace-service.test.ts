import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const rtFixture = vi.hoisted(() => ({ dir: "" }));
vi.mock("./runtime-constants", () => ({ get dataDir() { return rtFixture.dir; } }));
import { createWorkspace, deleteWorkspace, prepareWorkspace, captureReviewSnapshot, isSnapshotCurrent, integrateWorkspace, markReadyForReview, archiveWorkspace, adoptWorkspace, type WorkspaceRecord } from "./workspace-service.js";
import { worktreeForSession } from "./worktree.js";

/** W1-S23：创建序列四宗罪修复——先登记再 Git/核对读/固定 targetRef/删序查返回值。 */
async function makeRepo(): Promise<{ root: string; dataDir: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "w1-s23-"));
  const root = path.join(base, "repo");
  const dataDir = path.join(base, "data");
  mkdirSync(root, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  execSync("git init -q -b main && git config user.email t@t && git config user.name t && echo hello > a.txt && git add . && git commit -qm init", { cwd: root, shell: "/bin/bash" });
  return { root, dataDir };
}

describe("WorkspaceService 创建/删除（W1-S23）", () => {
  it("正常序列：creating 登记→Git→核对读→ready；baseCommit/targetRef 固定（W01 子集）", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const result = await createWorkspace({ dataDir, projectId: "proj1", projectPath: root, sessionId: "ses_w1a", rootTaskId: "task_r", startingState: "current_commit" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.record.state).toBe("ready");
      expect(result.record.baseCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(result.record.targetRef).toBe("main"); // 创建时刻固定，不跟整合时刻
      expect(existsSync(result.record.path)).toBe(true);
      expect(existsSync(path.join(result.record.path, "a.txt"))).toBe(true);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });

  it("非 Git 仓库：failed（不降级继续，不自动落回主工作区）", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "w1-s23b-"));
    try {
      const result = await createWorkspace({ dataDir: base, projectId: "p", projectPath: base, sessionId: "ses_w1b" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("not-a-git-repo");
      expect(result.record?.state).toBe("failed");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("幂等续走：ready 后重入返回同一 record（W02 子集——中断恢复锚点）", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const first = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1c" });
      const again = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1c" });
      expect(again.ok && first.ok && again.record.workspaceId).toBe(first.ok ? first.record.workspaceId : "");
      expect(again.ok && again.record.revision).toBe(first.ok ? first.record.revision : -1);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });

  it("指定 ref 起点（specified_ref）：baseCommit 解析到该 ref（W01 子集）", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      execSync("git checkout -qb feature-x && echo feat > f.txt && git add . && git commit -qm feat && git checkout -q main", { cwd: root, shell: "/bin/bash" });
      const result = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1d", startingState: "specified_ref", baseRef: "feature-x" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(existsSync(path.join(result.record.path, "f.txt"))).toBe(true);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });

  it("删除序列：未整合改动未显式丢弃 → 拒绝；丢弃 → 各步执行且无失败残留（W06 子集）", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1e" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      writeFileSync(path.join(created.record.path, "dirty.txt"), "未整合改动");
      const refused = await deleteWorkspace(dataDir, created.record.workspaceId, { discardUnintegrated: false });
      expect(refused.ok).toBe(false);
      expect(refused.failures[0]).toContain("unintegrated-changes");
      const discarded = await deleteWorkspace(dataDir, created.record.workspaceId, { discardUnintegrated: true });
      expect(discarded.ok).toBe(true);
      expect(existsSync(created.record.path)).toBe(false);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });
});

describe("环境准备（W1-S24）", () => {
  it("manifest 声明的依赖安装走注入执行器；失败 → prepare-failed 状态真实（W03 子集）", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1f" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const commands: { command: string; cwd: string }[] = [];
      const failed = await prepareWorkspace({
        dataDir, workspaceId: created.record.workspaceId, manifest: { install: { command: "pnpm install --frozen-lockfile" } },
        runCommand: async (command, cwd) => { commands.push({ command, cwd }); return { exitCode: 1, output: "ERR_PNPM_OUTDATED_LOCKFILE" }; },
      });
      expect(failed.ok).toBe(false);
      expect(commands[0]?.command).toBe("pnpm install --frozen-lockfile");
      expect(commands[0]?.cwd).toBe(created.record.path);
      expect(failed.steps[0]?.ok).toBe(false);
      expect(failed.steps[0]?.detail).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
      // 状态：preparing + activeOperation=prepare-failed（可重试，不伪装 ready）
      const db = new (await import("node:sqlite")).DatabaseSync(path.join(dataDir, "worktrees.db"));
      const row = db.prepare("SELECT json FROM workspace_records WHERE workspace_id = ?").get(created.record.workspaceId) as { json: string };
      const rec = JSON.parse(row.json) as WorkspaceRecord;
      expect(rec.state).toBe("preparing");
      expect(rec.activeOperation).toBe("prepare-failed");
      expect(rec.failureReason).toContain("install 失败");
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });

  it("成功路径：install+config 映射+端口分配 → active；端口同 workspace 复用", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1g" });
      if (!created.ok) return;
      const secretSrc = path.join(path.dirname(root), "secret.env");
      writeFileSync(secretSrc, "API_KEY=not-logged\n");
      const result = await prepareWorkspace({
        dataDir, workspaceId: created.record.workspaceId,
        manifest: { install: { command: "npm ci" }, configMaps: [{ from: secretSrc, to: ".env.local" }], devServer: { command: "npm run dev", port: 4300 } },
        runCommand: async () => ({ exitCode: 0, output: "added 100 packages" }),
      });
      expect(result.ok).toBe(true);
      expect(result.steps.map((s) => s.name)).toEqual(["install: npm", "config-map", "port-assign"]);
      expect(existsSync(path.join(created.record.path, ".env.local"))).toBe(true);
      // 值不落库：workspace_records 的 json 不含 secret 值
      const db = new (await import("node:sqlite")).DatabaseSync(path.join(dataDir, "worktrees.db"));
      const row = db.prepare("SELECT json FROM workspace_records WHERE workspace_id = ?").get(created.record.workspaceId) as { json: string };
      expect(row.json).not.toContain("API_KEY=not-logged");
      // 端口复用
      const again = await prepareWorkspace({
        dataDir, workspaceId: created.record.workspaceId, manifest: { devServer: { command: "x", port: 4300 } },
        runCommand: async () => ({ exitCode: 0, output: "" }),
      });
      expect(again.assignedPort).toBe(result.assignedPort);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });
});

describe("审查快照（W1-S25 / W04 前置）", () => {
  it("快照覆盖 committed/dirty/untracked；源再改动 → 指纹变化（旧证据失效判定）", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      // worktree 内：改已跟踪文件 + 新增 untracked + 提交一个新 commit
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1h" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const wt = created.record.path;
      writeFileSync(path.join(wt, "a.txt"), "modified\n");
      writeFileSync(path.join(wt, "new-untracked.txt"), "fresh\n");
      execSync("git add b-new.txt 2>/dev/null; echo staged > s.txt && git add s.txt", { cwd: wt, shell: "/bin/bash" });

      const snap = await captureReviewSnapshot(dataDir, created.record.workspaceId);
      expect(snap).not.toBeNull();
      if (!snap) return;
      expect(snap.dirtyFiles.map((d) => d.kind).sort()).toEqual(["staged", "unstaged", "untracked"]);
      expect(snap.headCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(snap.contentFingerprint).toMatch(/^[0-9a-f]{64}$/);

      // 未变 → current
      expect(await isSnapshotCurrent(dataDir, snap)).toBe(true);
      // 源再改动 → stale（审查后源变化，旧证据失效）
      writeFileSync(path.join(wt, "new-untracked.txt"), "changed-after-review\n");
      expect(await isSnapshotCurrent(dataDir, snap)).toBe(false);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });
});

describe("整合前检查（W1-S26 / W04）", () => {
  it("目标分支已推进（expectedTargetCommit 过期）→ CAS 拒绝，不产生任何合并", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1i" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const wt = created.record.path;
      const base = created.record.baseCommit;
      // 源交付提交 + 目标在审查后推进
      execSync("echo change > src.txt && git add . && git commit -qm src", { cwd: wt, shell: "/bin/bash" });
      execSync("echo advance > target.txt && git add . && git commit -qm advance", { cwd: root, shell: "/bin/bash" });
      const before = execSync("git rev-list --count main", { cwd: root }).toString().trim();

      markReadyForReview(dataDir, created.record.workspaceId);
      const r = await integrateWorkspace(dataDir, created.record.workspaceId, { expectedTargetCommit: base });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("target-moved");
      expect(r.record?.state).toBe("ready_for_review");
      expect(r.record?.integrationAttempts?.at(-1)?.outcome).toBe("target-moved");
      expect(r.record?.integrationJournal?.some((s) => s.step === "cas-check" && !s.ok)).toBe(true);
      // 目标未被碰：提交数不变、无残留整合 worktree
      expect(execSync("git rev-list --count main", { cwd: root }).toString().trim()).toBe(before);
      expect(existsSync(path.join(root, ".lectern-worktrees", ".integration-ses_w1i"))).toBe(false);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });

  it("目标工作区 dirty → 拒绝且保留现场（不自动 stash/reset）", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1j" });
      if (!created.ok) return;
      execSync("echo change > src.txt && git add . && git commit -qm src", { cwd: created.record.path, shell: "/bin/bash" });
      writeFileSync(path.join(root, "dirty.txt"), "现场内容\n");
      const mainBefore = execSync("git rev-parse main", { cwd: root }).toString().trim();

      markReadyForReview(dataDir, created.record.workspaceId);
      const r = await integrateWorkspace(dataDir, created.record.workspaceId, { expectedTargetCommit: created.record.baseCommit });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("target-dirty");
      // 现场：文件原样、main 未动、无 stash
      expect(readFileSync(path.join(root, "dirty.txt"), "utf8")).toBe("现场内容\n");
      expect(execSync("git rev-parse main", { cwd: root }).toString().trim()).toBe(mainBefore);
      expect(execSync("git stash list", { cwd: root }).toString().trim()).toBe("");
      expect(r.record?.state).toBe("ready_for_review");
      expect(r.record?.integrationAttempts?.at(-1)?.outcome).toBe("target-dirty");
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });

  it("源快照过期 → 拒绝（旧证据失效）；重拍后同一快照过闸整合成功", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1k" });
      if (!created.ok) return;
      const wid = created.record.workspaceId;
      execSync("echo change > src.txt && git add . && git commit -qm src", { cwd: created.record.path, shell: "/bin/bash" });
      const snap = await captureReviewSnapshot(dataDir, wid);
      expect(snap).not.toBeNull();
      // 审查后源再改动 → 旧快照失效
      writeFileSync(path.join(created.record.path, "post-review.txt"), "review 后改动\n");

      markReadyForReview(dataDir, wid);
      const stale = await integrateWorkspace(dataDir, wid, { expectedTargetCommit: created.record.baseCommit, reviewSnapshot: snap! });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.reason).toBe("source-changed");

      // 重拍快照（覆盖未提交改动）→ 过闸成功
      const fresh = await captureReviewSnapshot(dataDir, wid);
      const ok = await integrateWorkspace(dataDir, wid, { expectedTargetCommit: created.record.baseCommit, reviewSnapshot: fresh! });
      expect(ok.ok).toBe(true);
      expect(execSync(`git cat-file -e main:src.txt && echo yes`, { cwd: root, shell: "/bin/bash" }).toString().trim()).toBe("yes");
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });
});

describe("整合冲突与重试（W1-S26 / W05）", () => {
  it("冲突 → attempt 保留 conflictFiles、源与目标现场保留；修复源后重试成功（新 attempt）", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1l" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const wt = created.record.path;
      // 双边改同一文件 → 冲突
      execSync("echo source-change > a.txt && git add . && git commit -qm src", { cwd: wt, shell: "/bin/bash" });
      execSync("echo target-change > a.txt && git add . && git commit -qm target", { cwd: root, shell: "/bin/bash" });
      const targetNow = execSync("git rev-parse main", { cwd: root }).toString().trim();

      markReadyForReview(dataDir, created.record.workspaceId);
      const r = await integrateWorkspace(dataDir, created.record.workspaceId, { expectedTargetCommit: targetNow });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("conflict");
      expect(r.record?.integrationAttempts?.[0]?.conflictFiles).toContain("a.txt");
      expect(r.record?.state).toBe("ready_for_review");
      // 现场：源与目标内容保留，main 未动，受管临时 worktree 已清
      expect(readFileSync(path.join(wt, "a.txt"), "utf8")).toBe("source-change\n");
      expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("target-change\n");
      expect(execSync("git rev-parse main", { cwd: root }).toString().trim()).toBe(targetNow);
      expect(existsSync(path.join(root, ".lectern-worktrees", ".integration-ses_w1l"))).toBe(false);

      // 修复：源分支对齐目标后改不冲突的文件（冲突修复发生在有写权管控的源，不在受管临时现场）
      execSync("git reset --hard -q main && echo fix > b-fix.txt && git add . && git commit -qm fix", { cwd: wt, shell: "/bin/bash" });
      const retry = await integrateWorkspace(dataDir, created.record.workspaceId, { expectedTargetCommit: targetNow });
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.record.state).toBe("integrated");
      expect(retry.record.times.integratedAt).toBeTruthy();
      expect(retry.record.integrationCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(retry.record.integrationCommit).toBe(execSync("git rev-parse main", { cwd: root }).toString().trim());
      expect(retry.record.integrationAttempts?.length).toBe(2);
      expect(retry.record.integrationAttempts?.at(-1)?.outcome).toBe("succeeded");
      expect(retry.record.integrationAttempts?.at(-1)?.mergedSnapshotFingerprint).toMatch(/^[0-9a-f]{64}$/);
      // 整合产物进了目标；源目录不删（integrated 会话继续指向原工作区，W06）
      expect(existsSync(path.join(root, "b-fix.txt"))).toBe(true);
      expect(existsSync(wt)).toBe(true);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });

  it("目标未 checkout → update-ref CAS 推进；中断后重试复用 merge commit 不重复合并；幂等重入直接成功", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1m" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const wid = created.record.workspaceId;
      const base = created.record.baseCommit;
      execSync("echo change > src.txt && git add . && git commit -qm src", { cwd: created.record.path, shell: "/bin/bash" });
      // 主工作区 detach → main 未被 checkout，走 update-ref 路径
      execSync("git checkout -q --detach", { cwd: root });

      markReadyForReview(dataDir, wid);
      const first = await integrateWorkspace(dataDir, wid, { expectedTargetCommit: base });
      expect(first.ok).toBe(true);
      const merged = execSync("git rev-parse main", { cwd: root }).toString().trim();

      // 模拟中断（进程死在 merge 之后、推进之前）：目标 ref 回滚，record 仍持有 integrationCommit
      execSync(`git update-ref refs/heads/main ${base}`, { cwd: root });
      const retry = await integrateWorkspace(dataDir, wid, { expectedTargetCommit: base });
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.record.integrationAttempts?.at(-1)?.reusedMergeCommit).toBe(true);
      // 同一个 merge commit，未产生新合并
      expect(execSync("git rev-parse main", { cwd: root }).toString().trim()).toBe(merged);
      expect(retry.record.integrationCommit).toBe(merged);
      expect(retry.record.integrationJournal?.filter((s) => s.step === "merge").length).toBe(1);
      expect(retry.record.integrationJournal?.some((s) => s.step === "resume-advance-only" && s.ok)).toBe(true);

      // 幂等重入：目标已含预期整合提交 → 直接成功，不再合并/推进
      const again = await integrateWorkspace(dataDir, wid, { expectedTargetCommit: merged });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.alreadyIntegrated).toBe(true);
      expect(again.record.integrationAttempts?.at(-1)?.outcome).toBe("already-integrated");
      expect(execSync("git rev-parse main", { cwd: root }).toString().trim()).toBe(merged);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });

  it("目标已 checkout 且 merge commit 非快进 → --ff-only 拒绝，不强推不覆盖", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1n" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const base = created.record.baseCommit;
      execSync("echo change > src.txt && git add . && git commit -qm src", { cwd: created.record.path, shell: "/bin/bash" });

      // 首次整合成功（main 已 checkout 在主工作区 → ff 路径）
      markReadyForReview(dataDir, created.record.workspaceId);
      const first = await integrateWorkspace(dataDir, created.record.workspaceId, { expectedTargetCommit: base });
      expect(first.ok).toBe(true);
      const merged = execSync("git rev-parse main", { cwd: root }).toString().trim();

      // 模拟中断后目标走了另一条路：main 回滚再前进（不含原 merge commit）
      execSync(`git reset --hard -q ${base} && echo diverge > d.txt && git add . && git commit -qm diverge`, { cwd: root, shell: "/bin/bash" });
      const diverged = execSync("git rev-parse main", { cwd: root }).toString().trim();
      expect(diverged).not.toBe(merged);

      // record 仍持有旧 merge commit（中断现场）→ 恢复推进被 ff-only 拒绝
      const retry = await integrateWorkspace(dataDir, created.record.workspaceId, { expectedTargetCommit: diverged });
      expect(retry.ok).toBe(false);
      if (retry.ok) return;
      expect(retry.reason).toBe("not-fast-forward");
      // 未强推：main 留在分叉提交，工作树内容未被覆盖
      expect(execSync("git rev-parse main", { cwd: root }).toString().trim()).toBe(diverged);
      expect(existsSync(path.join(root, "d.txt"))).toBe(true);
      expect(retry.record?.state).toBe("ready_for_review");
      expect(retry.record?.integrationJournal?.some((s) => s.step === "ff-merge" && !s.ok)).toBe(true);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });
});

describe("多轮交付与生命周期收尾（W1-S27-A）", () => {
  it("多轮整合：源变化 → 清锚点重新合并；同源重入 → already-integrated", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1o" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const wid = created.record.workspaceId;
      const wt = created.record.path;
      const base = created.record.baseCommit;
      const tip = (dir: string) => execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
      const mainAt = () => execSync("git rev-parse main", { cwd: root }).toString().trim();

      execSync("echo r1 > r1.txt && git add . && git commit -qm r1", { cwd: wt, shell: "/bin/bash" });
      markReadyForReview(dataDir, wid);
      const r1 = await integrateWorkspace(dataDir, wid, { expectedTargetCommit: base });
      expect(r1.ok).toBe(true);
      expect(existsSync(path.join(root, "r1.txt"))).toBe(true);

      // 第二轮：源分支新提交 → 旧锚点源不符，清锚点重新合并（不误报 already-integrated）
      execSync("echo r2 > r2.txt && git add . && git commit -qm r2", { cwd: wt, shell: "/bin/bash" });
      const r2 = await integrateWorkspace(dataDir, wid, { expectedTargetCommit: mainAt() });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(existsSync(path.join(root, "r2.txt"))).toBe(true);
      expect(r2.record.integrationJournal?.some((s) => s.step === "stale-anchor-cleared" && s.ok)).toBe(true);
      expect(r2.record.integrationSource).toBe(tip(wt));

      // 同源重入 → 幂等 already-integrated
      const r3 = await integrateWorkspace(dataDir, wid, { expectedTargetCommit: mainAt() });
      expect(r3.ok && r3.alreadyIntegrated).toBe(true);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });

  it("sourceCommit 覆盖：合并的是指定的交付提交，分支 tip 之后的内容不进目标（delivery 委托基础）", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1p" });
      if (!created.ok) return;
      const wt = created.record.path;
      execSync("echo s1 > s1.txt && git add . && git commit -qm s1", { cwd: wt, shell: "/bin/bash" });
      const deliveryCommit = execSync("git rev-parse HEAD", { cwd: wt }).toString().trim();
      execSync("echo s2 > s2.txt && git add . && git commit -qm s2", { cwd: wt, shell: "/bin/bash" }); // tip 之后的改动不在交付内
      markReadyForReview(dataDir, created.record.workspaceId);

      const r = await integrateWorkspace(dataDir, created.record.workspaceId, {
        expectedTargetCommit: created.record.baseCommit, sourceCommit: deliveryCommit,
      });
      expect(r.ok).toBe(true);
      expect(existsSync(path.join(root, "s1.txt"))).toBe(true);
      expect(existsSync(path.join(root, "s2.txt"))).toBe(false);
      expect(r.ok && r.record.integrationSource).toBe(deliveryCommit);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });

  it("integrated 后 createWorkspace 重入：幂等返回原 record（W06 不悄悄换工作区）", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1q" });
      if (!created.ok) return;
      const wid = created.record.workspaceId;
      execSync("echo x > x.txt && git add . && git commit -qm x", { cwd: created.record.path, shell: "/bin/bash" });
      markReadyForReview(dataDir, wid);
      const done = await integrateWorkspace(dataDir, wid, { expectedTargetCommit: created.record.baseCommit });
      expect(done.ok).toBe(true);
      if (!done.ok) return;

      const again = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1q" });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.record.workspaceId).toBe(wid);
      expect(again.record.state).toBe("integrated");
      expect(again.record.revision).toBe(done.record.revision); // 原样返回，不改状态不新建
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });

  it("archiveWorkspace：integrated → archived 只读归档（目录保留）；未整合拒绝；幂等", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      const created = await createWorkspace({ dataDir, projectId: "p", projectPath: root, sessionId: "ses_w1r" });
      if (!created.ok) return;
      const wid = created.record.workspaceId;
      const wt = created.record.path;
      // 未整合 → 拒绝归档（W06：不误换态）
      expect(archiveWorkspace(dataDir, wid)).toBeNull();

      execSync("echo x > x.txt && git add . && git commit -qm x", { cwd: wt, shell: "/bin/bash" });
      markReadyForReview(dataDir, wid);
      const done = await integrateWorkspace(dataDir, wid, { expectedTargetCommit: created.record.baseCommit });
      expect(done.ok).toBe(true);

      const archived = archiveWorkspace(dataDir, wid);
      expect(archived?.state).toBe("archived");
      expect(existsSync(wt)).toBe(true); // 归档不删目录
      expect(archiveWorkspace(dataDir, wid)?.state).toBe("archived"); // 幂等
      // archived 仍算会话活跃指向（只读归档，会话不悄悄切回主目录）
      rtFixture.dir = dataDir;
      expect(worktreeForSession("ses_w1r")?.path).toBe(wt);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });

  it("adoptWorkspace：旧表记录导入（联合校验）→ 可整合；现场不符返回 null；读面双读", async () => {
    const { root, dataDir } = await makeRepo();
    try {
      // 手工造 M2b 前的 legacy 现场：worktree + 旧表行（分支前缀 lectern/<sid>，无 /wt）
      execSync("git worktree add -q -b lectern/legacyses .lectern-worktrees/legacyses main", { cwd: root, shell: "/bin/bash" });
      const legacyWt = path.join(root, ".lectern-worktrees", "legacyses");
      execSync("echo legacy > legacy.txt && git add . && git commit -qm legacy", { cwd: legacyWt, shell: "/bin/bash" });
      const db = new (await import("node:sqlite")).DatabaseSync(path.join(dataDir, "worktrees.db"));
      db.exec("CREATE TABLE IF NOT EXISTS worktrees (session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, created_at TEXT NOT NULL)");
      db.prepare("INSERT INTO worktrees VALUES (?,?,?,?,?)").run("legacyses", root, legacyWt, "lectern/legacyses", new Date().toISOString());

      // 双读 fallback：无新记录时读面走旧表
      rtFixture.dir = dataDir;
      expect(worktreeForSession("legacyses")?.branch).toBe("lectern/legacyses");

      const adopted = await adoptWorkspace(dataDir, "legacyses");
      expect(adopted?.state).toBe("active");
      expect(adopted?.branch).toBe("lectern/legacyses");
      expect(adopted?.targetRef).toBe("main");
      expect((await adoptWorkspace(dataDir, "legacyses"))?.revision).toBe(adopted?.revision); // 幂等

      // 导入后即可整合（legacy 会话不孤儿）
      markReadyForReview(dataDir, adopted!.workspaceId);
      const t = execSync("git rev-parse main", { cwd: root }).toString().trim();
      const r = await integrateWorkspace(dataDir, adopted!.workspaceId, { expectedTargetCommit: t });
      expect(r.ok).toBe(true);
      expect(existsSync(path.join(root, "legacy.txt"))).toBe(true);
      // 双读新记录优先（同 path/branch，来源换成 workspace_records）
      expect(worktreeForSession("legacyses")?.path).toBe(adopted!.path);

      // 联合校验不符：旧表行指向不存在的目录 → null（不猜）
      db.prepare("INSERT OR REPLACE INTO worktrees VALUES (?,?,?,?,?)").run("ghostses", root, path.join(root, ".lectern-worktrees", "ghost"), "lectern/ghostses", new Date().toISOString());
      expect(await adoptWorkspace(dataDir, "ghostses")).toBeNull();
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  });
});
