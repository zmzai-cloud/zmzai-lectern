import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  casUpdateRef,
  currentBranch,
  headSha,
  isGitRepo,
  materializeDeliveryCommit,
  worktreeFingerprint,
} from "./delivery-git.js";

let dir: string;
const dirs: string[] = [];

function setupRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "lectern-delivery-git-"));
  dirs.push(d);
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: d });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: d });
  writeFileSync(join(d, "base.txt"), "base\n");
  execFileSync("git", ["add", "-A"], { cwd: d });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: d });
  return d;
}

beforeEach(() => {
  dir = setupRepo();
});

afterEach(() => {
  for (const d of dirs) {
    try {
      execFileSync("rm", ["-rf", d]);
    } catch {
      /* ignore */
    }
  }
  dirs.length = 0;
});

describe("delivery-git 验证快照物化", () => {
  it("识别 git 仓库", () => {
    expect(isGitRepo(dir)).toBe(true);
  });

  it("headSha 返回当前 HEAD", async () => {
    const sha = await headSha(dir);
    expect(sha).toBeTruthy();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("currentBranch 返回分支名", async () => {
    const branch = await currentBranch(dir);
    expect(branch).toBeTruthy();
  });

  it("物化 immutable delivery commit 不修改用户 worktree HEAD", async () => {
    const beforeHead = await headSha(dir);
    const beforeBranch = await currentBranch(dir);
    const tmpIndex = join(dir, ".git", "delivery-test-index");

    // 修改工作区（未提交）
    writeFileSync(join(dir, "new.txt"), "new content\n");
    writeFileSync(join(dir, "base.txt"), "base modified\n");

    const materialized = await materializeDeliveryCommit(dir, tmpIndex);

    expect(materialized.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(materialized.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(materialized.parentSha).toBe(beforeHead);

    // 关键：用户 worktree 的 HEAD 与分支未被改写
    expect(await headSha(dir)).toBe(beforeHead);
    expect(await currentBranch(dir)).toBe(beforeBranch);
  });

  it("worktreeFingerprint 覆盖 tracked + untracked 变更", async () => {
    const before = await worktreeFingerprint(dir);
    writeFileSync(join(dir, "new.txt"), "untracked\n");
    const afterUntracked = await worktreeFingerprint(dir);
    expect(afterUntracked).not.toBe(before);

    writeFileSync(join(dir, "base.txt"), "tracked modified\n");
    const afterTracked = await worktreeFingerprint(dir);
    expect(afterTracked).not.toBe(afterUntracked);
    expect(afterTracked).not.toBe(before);
  });
});

describe("Git CAS（compare-and-swap）", () => {
  it("base ref 未变时 update-ref 成功", async () => {
    const base = await headSha(dir);
    const branch = await currentBranch(dir);
    // 建一个新 commit（模拟 merge commit）
    writeFileSync(join(dir, "m.txt"), "merged\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "merge candidate"], { cwd: dir });
    const newSha = (await headSha(dir))!;
    // 把 branch 回退到 base，再用 CAS 从 base -> newSha
    execFileSync("git", ["reset", "--hard", base!], { cwd: dir });
    const r = await casUpdateRef(dir, branch!, newSha, base);
    expect(r.ok).toBe(true);
    expect(await headSha(dir)).toBe(newSha);
  });

  it("base ref 并发推进时 update-ref 拒绝（precondition 失败）", async () => {
    const base = await headSha(dir);
    const branch = await currentBranch(dir);
    // 新建一个 commit 并推进 branch（模拟并发 base 推进）
    writeFileSync(join(dir, "concurrent.txt"), "someone else\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "concurrent"], { cwd: dir });
    const moved = (await headSha(dir))!;
    expect(moved).not.toBe(base);

    // 试图用过期的 expectedOld=base 做 CAS，必须失败且不覆盖 moved
    const r = await casUpdateRef(dir, branch!, base!, base);
    expect(r.ok).toBe(false);
    // branch 仍停在 moved（并发提交未被覆盖）
    expect(await headSha(dir)).toBe(moved);
  });
});
