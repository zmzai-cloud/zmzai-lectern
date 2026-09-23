import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
import { createWorkspace, deleteWorkspace, prepareWorkspace, type WorkspaceRecord } from "./workspace-service.js";
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
