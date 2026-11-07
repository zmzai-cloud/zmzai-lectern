import { withWorkflowErrors, WorkflowError } from './workflow-error.js';
import { rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Ruleset } from '@zmzai/agent-framework';

import { dataDirForId } from './projects.js';
import { applyModeRules, PERMISSION_MODES, type PermissionMode } from './permission-mode.js';
import { sessionStoreFor } from './runtime.js';
import { discardSessionWorkspace } from './workspace-actions.js';

/** 会话改删服务（P0 2026-11-07 Host 迁移，route-ownership-matrix）：
 *  PATCH /api/sessions/:id（重命名/置顶/归档/权限模式）与 DELETE（级联删除 +
 *  隔离副本清理 + 遗留 JSONL 清扫）。逻辑与原进程内 handler 同源；归属按
 *  sessionStoreFor 的持久归属解析，不依赖当前活动项目。
 *
 *  兼容两种挂载路径：进程内（/api/sessions/:id，legacy 模式由 Next 壳直调）
 *  与 Host（/v1/sessions/:id，网关透传后由 Host 调用）。 */

/** 会话 id 白名单字符（jsonl 文件名即 id，防路径逃逸）。 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function sessionFromPath(pathname: string): string | null {
  const m = /^\/(?:api|v1)\/sessions\/([^/]+)$/.exec(pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** PATCH — title / pinned / archived / permissionMode 可独立或组合更新
 *  （store.updateSession 落库；权限模式下一次 prompt 生效）。 */
async function handlePATCH(request: Request, id: string): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { title?: string; pinned?: boolean; archived?: boolean; permissionMode?: string }
    | null;
  const title = body?.title?.trim();
  const patch: { title?: string; pinned?: boolean; archived?: boolean; permission?: Ruleset } = {};
  if (title) patch.title = title.slice(0, 80);
  if (typeof body?.pinned === 'boolean') patch.pinned = body.pinned;
  if (typeof body?.archived === 'boolean') patch.archived = body.archived;
  // 权限模式（Codex 基准 ④）：读会话 → 剥旧模式规则 → 追加新模式 → 落库。
  if (typeof body?.permissionMode === 'string') {
    const mode = body.permissionMode as PermissionMode;
    if (!PERMISSION_MODES.includes(mode)) return Response.json({ error: '非法权限模式' }, { status: 400 });
    patch.permission = [];
  }

  const found = await sessionStoreFor(id);
  if (!found) throw new WorkflowError('NOT_FOUND', '会话不存在', 404);
  if (patch.permission) {
    const session = await found.store.getSession(id);
    if (!session) throw new WorkflowError('NOT_FOUND', '会话不存在', 404);
    patch.permission = applyModeRules(session.permission, body!.permissionMode as PermissionMode);
  }
  if (Object.keys(patch).length === 0) return Response.json({ error: '没有可更新的字段' }, { status: 400 });
  await found.store.updateSession(id, patch);
  return Response.json({ ok: true });
}

/** DELETE — 删除会话及其消息/片段。
 *  存储是 SQLite（zmzai.db）：走 store.deleteSession 级联删三表；
 *  旧 JSONL 文件仍一并清扫（不删的话，空库重新导入时会把已删会话复活）。 */
async function handleDELETE(id: string): Promise<Response> {
  const found = await sessionStoreFor(id);
  if (!found) throw new WorkflowError('NOT_FOUND', '会话不存在', 404);
  await found.store.deleteSession?.(id);

  // 隔离副本会话：工作区目录与分支一并清理（W1-S27 走 WorkspaceService 删序，
  // 失败保留可修复记录；会话本体已删，清理失败不阻断删除响应）
  await discardSessionWorkspace(id).catch(() => undefined);

  // 遗留 JSONL 清扫（store 未实现 deleteSession 的后端也能清到文件层）
  const dir = dataDirForId(found.projectId);
  await rm(path.join(dir, 'sessions', `${id}.json`), { force: true });
  for (const kind of ['messages', 'parts'] as const) {
    const kindDir = path.join(dir, kind);
    let entries: string[] = [];
    try {
      entries = await readdir(kindDir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(kindDir, file);
      try {
        const raw = JSON.parse(await readFile(full, 'utf8')) as { sessionId?: string };
        if (raw.sessionId === id) await rm(full, { force: true });
      } catch {
        /* 损坏文件跳过 */
      }
    }
  }
  return Response.json({ ok: true });
}

async function handle(request: Request): Promise<Response> {
  const id = sessionFromPath(new URL(request.url).pathname);
  if (!id || !SAFE_ID.test(id)) return Response.json({ error: '非法会话 id' }, { status: 400 });
  if (request.method === 'PATCH') return handlePATCH(request, id);
  if (request.method === 'DELETE') return handleDELETE(id);
  return Response.json({ error: '不支持的 method' }, { status: 405 });
}

export const handleSessionMutation = withWorkflowErrors(handle);
