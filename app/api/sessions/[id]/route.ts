import { withWorkflowErrors, WorkflowError } from "@/lib/workflow-error";
import { rm, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Ruleset } from "@zmzai/agent-framework";
import { type NextRequest, NextResponse } from "next/server";

import { dataDirForId } from "@/lib/projects";
import { applyModeRules, PERMISSION_MODES, type PermissionMode } from "@/lib/permission-mode";
import { sessionStoreFor } from "@/lib/runtime";
import { removeWorktree } from "@/lib/worktree";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 会话 id 白名单字符（jsonl 文件名即 id，防路径逃逸）。 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** PATCH /api/sessions/[id] — 重命名 / 置顶 / 归档 / 权限模式（store.updateSession 落库）。
 *  title / pinned / archived / permissionMode 四者可独立或组合更新。 */
async function handlePATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!SAFE_ID.test(id)) return NextResponse.json({ error: "非法会话 id" }, { status: 400 });
  const body = (await request.json().catch(() => null)) as
    | { title?: string; pinned?: boolean; archived?: boolean; permissionMode?: string }
    | null;
  const title = body?.title?.trim();
  const patch: { title?: string; pinned?: boolean; archived?: boolean; permission?: Ruleset } = {};
  if (title) patch.title = title.slice(0, 80);
  if (typeof body?.pinned === "boolean") patch.pinned = body.pinned;
  if (typeof body?.archived === "boolean") patch.archived = body.archived;
  // 权限模式（Codex 基准 ④）：读会话 → 剥旧模式规则 → 追加新模式 → 落库。
  // 当前 run 不受影响（引擎在 run 开始时装配），下一次 prompt 生效。
  if (typeof body?.permissionMode === "string") {
    const mode = body.permissionMode as PermissionMode;
    if (!PERMISSION_MODES.includes(mode)) return NextResponse.json({ error: "非法权限模式" }, { status: 400 });
    patch.permission = [];
  }

  const found = await sessionStoreFor(id);
  if (!found) throw new WorkflowError("NOT_FOUND", "会话不存在", 404);
  if (patch.permission) {
    const session = await found.store.getSession(id);
    if (!session) throw new WorkflowError("NOT_FOUND", "会话不存在", 404);
    patch.permission = applyModeRules(session.permission, body!.permissionMode as PermissionMode);
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "没有可更新的字段" }, { status: 400 });
  await found.store.updateSession(id, patch);
  return NextResponse.json({ ok: true });
}

/** DELETE /api/sessions/[id] — 删除会话及其消息/片段。
 *  存储现在是 SQLite（zmzai.db）：必须走 store.deleteSession 级联删三表；
 *  旧 JSONL 文件仍一并清扫（不删的话，空库重新导入时会把已删会话复活）。 */
async function handleDELETE(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!SAFE_ID.test(id)) return NextResponse.json({ error: "非法会话 id" }, { status: 400 });

  const found = await sessionStoreFor(id);
  if (!found) throw new WorkflowError("NOT_FOUND", "会话不存在", 404);
  await found.store.deleteSession?.(id);

  // 隔离副本会话：worktree 目录与分支一并清理（未合并的提交随分支丢弃）
  await removeWorktree(id).catch(() => undefined);

  // 遗留 JSONL 清扫（store 未实现 deleteSession 的后端也能清到文件层）
  const dir = dataDirForId(found.projectId);
  await rm(path.join(dir, "sessions", `${id}.json`), { force: true });
  for (const kind of ["messages", "parts"] as const) {
    const kindDir = path.join(dir, kind);
    let entries: string[] = [];
    try {
      entries = await readdir(kindDir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".json")) continue;
      const full = path.join(kindDir, file);
      try {
        const raw = JSON.parse(await readFile(full, "utf8")) as { sessionId?: string };
        if (raw.sessionId === id) await rm(full, { force: true });
      } catch {
        /* 损坏文件跳过 */
      }
    }
  }
  return NextResponse.json({ ok: true });
}

export const PATCH = withWorkflowErrors(handlePATCH);
export const DELETE = withWorkflowErrors(handleDELETE);
