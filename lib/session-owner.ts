import { DatabaseSync } from "node:sqlite";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { dataDirFor, registeredProjects, type Project } from "./projects.js";
import { worktreeForSession } from "./worktree.js";
import { WorkflowError } from "./workflow-error.js";

export type SessionOwner = {
  project: Project;
  sessionId: string;
  effectiveWorkspaceRoot: string;
};

/** Resolve without booting runtimes/MCP, importing legacy data, or creating DBs.
 * Never cache ownership: deletion, duplicate IDs and lost mounts must be observed.
 * Missing project folders remain in the inventory so their sessions cannot migrate
 * silently to the active project. The SQLite sessions PK makes each probe bounded.
 */
export function resolveSessionOwner(sessionId: string): SessionOwner {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(sessionId)) {
    throw new WorkflowError("INVALID_INPUT", "非法会话 id", 422);
  }
  let owner: Project | undefined;
  for (const project of registeredProjects()) {
    const file = join(dataDirFor(project), "zmzai.db");
    if (!existsSync(file)) continue;
    let db: DatabaseSync | undefined;
    let found: boolean;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      found = !!db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
    } catch {
      // An unreadable DB could contain a duplicate ID. Do not guess ownership.
      throw new WorkflowError("RESOURCE_UNAVAILABLE", "无法核对会话归属：项目数据库不可读取，请恢复项目数据后重试", 503, true);
    } finally {
      db?.close();
    }
    if (found) {
      if (owner) throw new WorkflowError("CONFLICT", "多个项目存在相同会话 id，已阻止操作，请先修复重复数据", 409);
      owner = project;
    }
  }
  if (!owner) throw new WorkflowError("NOT_FOUND", "会话不存在", 404);
  assertWorkspaceAvailable(owner.path);
  const worktree = worktreeForSession(sessionId);
  if (worktree) {
    if (resolve(worktree.projectPath) !== resolve(owner.path)) {
      throw new WorkflowError("CONFLICT", "会话与隔离副本的项目归属不一致，已阻止操作", 409);
    }
    assertWorkspaceAvailable(worktree.path);
    // A replaced symlink must not redirect an isolated task into another root.
    if (realpathSync(worktree.path) !== join(realpathSync(owner.path), ".lectern-worktrees", sessionId)) {
      throw new WorkflowError("RECOVERY_REQUIRED", "隔离副本路径已变化，请核对工作区后恢复任务", 409);
    }
  }
  return { project: owner, sessionId, effectiveWorkspaceRoot: worktree?.path ?? owner.path };
}

export function assertWorkspaceAvailable(root: string): void {
  try {
    if (statSync(root).isDirectory()) return;
  } catch { /* Removed directory, unavailable mount, or permissions. */ }
  throw new WorkflowError("RECOVERY_REQUIRED", "会话工作区不存在或不可访问，请恢复原目录后重试；未切换到其他项目", 409);
}
