import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { dataDir } from "./runtime-constants.js";

/**
 * 权限审计日志（独立 SQLite，与 framework 的会话库零耦合）：
 * 每次授权决定（手动 / 自动档 / 细粒度自动）落一行——自动档给 agent 松绑，
 * 审计是松绑后的安全带：事后可回答「谁在什么时候允许了什么」。
 */

export type PermissionAuditRow = {
  at: string;
  sessionId: string;
  permission: string;
  summary: string;
  decision: string;
  source: "manual" | "auto" | "fine-grained";
};

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(join(resolve(dataDir), "audit.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS permission_audit (
      at TEXT NOT NULL,
      session_id TEXT NOT NULL,
      permission TEXT NOT NULL,
      summary TEXT NOT NULL,
      decision TEXT NOT NULL,
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_permission_audit_at ON permission_audit(at DESC);
  `);
  return db;
}

export function auditPermission(row: PermissionAuditRow): void {
  try {
    getDb()
      .prepare("INSERT INTO permission_audit (at, session_id, permission, summary, decision, source) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.at, row.sessionId, row.permission, row.summary, row.decision, row.source);
  } catch {
    // 审计失败绝不阻塞授权主流程
  }
}

export function listPermissionAudit(limit = 200, permission?: string): PermissionAuditRow[] {
  try {
    const d = getDb();
    const rows = permission
      ? d.prepare("SELECT at, session_id, permission, summary, decision, source FROM permission_audit WHERE permission = ? ORDER BY at DESC LIMIT ?").all(permission, limit)
      : d.prepare("SELECT at, session_id, permission, summary, decision, source FROM permission_audit ORDER BY at DESC LIMIT ?").all(limit);
    return rows as unknown as PermissionAuditRow[];
  } catch {
    return [];
  }
}
