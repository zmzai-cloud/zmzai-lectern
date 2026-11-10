import { withWorkflowErrors, WorkflowError } from './workflow-error.js';

import { capsFor } from './model-caps.js';
import { sessionRuntime } from './runtime.js';
import { resolveSessionOwner } from './session-owner.js';
import { toTaskView } from './task-presentation.js';

/** 会话读面服务（P0 2026-11-07 Host 迁移，route-ownership-matrix）：
 *  messages（窗口快照/尾页/全量）、search（会话内搜索 + 游标）、usage（上下文
 *  占用）、read-state（GET 读 / PUT 写）。逻辑与原进程内 handler 同源。
 *
 *  背景：Host 旧版 /v1/sessions/:id/(messages|search|usage) 按早期冒烟形状实现
 *  （messages 忽略 view=window、search 缺游标与 projectId、usage 字段不同），
 *  与 UI 契约不一致，Next 壳因此一直未接网关——armed 下这些读仍在 Next 进程执行。
 *  收敛为同一服务后，两条挂载路径（进程内 /api/sessions/:id/*，Host
 *  /v1/sessions/:id/*）返回同一契约。归属按会话持久归属解析。 */

type ReadKind = 'messages' | 'search' | 'usage' | 'read-state';

function parsePath(pathname: string): { id: string; kind: ReadKind } | null {
  const m = /^\/(?:api|v1)\/sessions\/([^/]+)\/(messages|search|usage|read-state)$/.exec(pathname);
  return m ? { id: decodeURIComponent(m[1]!), kind: m[2] as ReadKind } : null;
}

/** messages：view=window 使用绑定会话与 historyRevision 的稳定游标，返回同水位
 *  运行快照；tail/skip 仅保留给旧客户端兼容；无参数 = 全量（旧语义）。 */
async function handleMessages(url: URL, id: string): Promise<Response> {
  const runtime = sessionRuntime(id);
  if (url.searchParams.get('view') === 'window' && runtime.store.getMessageSnapshot) {
    const limitRaw = Number(url.searchParams.get('limit') ?? '50');
    if (!Number.isSafeInteger(limitRaw) || limitRaw < 1 || limitRaw > 200) throw new WorkflowError('INVALID_INPUT', 'limit 必须是 1..200 的整数', 422);
    let before: number | undefined;
    let revision: number | undefined;
    const beforeCursorParam = url.searchParams.get('before');
    const afterCursorParam = url.searchParams.get('after');
    const around = url.searchParams.get('around') ?? undefined;
    if ([beforeCursorParam, afterCursorParam, around].filter(Boolean).length > 1) throw new WorkflowError('INVALID_INPUT', 'before、after 和 around 不能同时使用', 422);
    const cursor = beforeCursorParam ?? afterCursorParam;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { sessionId?: unknown; messageSeq?: unknown; historyRevision?: unknown };
        if (decoded.sessionId !== id || !Number.isSafeInteger(decoded.messageSeq) || !Number.isSafeInteger(decoded.historyRevision)) throw new Error('invalid');
        before = decoded.messageSeq as number;
        revision = decoded.historyRevision as number;
      } catch {
        throw new WorkflowError('INVALID_INPUT', '历史游标无效', 422);
      }
    }
    try {
      const snapshot = await runtime.store.getMessageSnapshot(id, { limit: limitRaw, before: afterCursorParam ? undefined : before, after: afterCursorParam ? before : undefined, around, revision });
      const beforeCursor = snapshot.nextBefore === null ? null : Buffer.from(JSON.stringify({ sessionId: id, messageSeq: snapshot.nextBefore, historyRevision: snapshot.revision })).toString('base64url');
      const afterCursor = snapshot.nextAfter === null ? null : Buffer.from(JSON.stringify({ sessionId: id, messageSeq: snapshot.nextAfter, historyRevision: snapshot.revision })).toString('base64url');
      return Response.json({
        projectId: resolveSessionOwner(id).project.id,
        sessionId: id,
        messages: snapshot.messages,
        beforeCursor,
        afterCursor,
        hasMoreBefore: snapshot.hasMore,
        hasMoreAfter: snapshot.hasMoreAfter,
        historyRevision: snapshot.revision,
        snapshotSeq: snapshot.snapshotSeq,
        readState: snapshot.readState,
        stateEvents: snapshot.stateEvents,
        runs: snapshot.runs,
        // 当前任务契约（规格 3 §13.3）：无任务时显式给 null（而不是省略字段）
        task: snapshot.task ? toTaskView(snapshot.task) : null,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'HISTORY_REVISION_CONFLICT') throw new WorkflowError('CONFLICT', '历史已发生回溯，请重新加载', 409, true);
      if (error instanceof Error && error.message === 'MESSAGE_NOT_FOUND') throw new WorkflowError('NOT_FOUND', '该消息已不存在，请重新搜索', 404);
      throw error;
    }
  }

  const messages = await runtime.store.getMessages(id);
  const tailRaw = Number(url.searchParams.get('tail') ?? '0');
  if (!Number.isFinite(tailRaw) || tailRaw <= 0) {
    return Response.json(messages);
  }
  const limit = Math.min(200, Math.floor(tailRaw));
  const skipRaw = Number(url.searchParams.get('skip') ?? '0');
  const skip = Number.isFinite(skipRaw) && skipRaw > 0 ? Math.floor(skipRaw) : 0;

  const end = Math.max(0, messages.length - skip);
  const start = Math.max(0, end - limit);
  return Response.json({
    messages: messages.slice(start, end),
    total: messages.length,
    hasMore: start > 0,
  });
}

/** search：会话内全文搜索（1..100 条，游标绑定 sessionId/query/revision）。 */
async function handleSearch(url: URL, id: string): Promise<Response> {
  const owner = resolveSessionOwner(id);
  const params = url.searchParams;
  const query = (params.get('q') ?? '').trim();
  const limit = Number(params.get('limit') ?? 30);
  if (query.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new WorkflowError('INVALID_INPUT', '搜索词最多 200 字符，limit 必须是 1..100 的整数', 422);
  if (!query) return Response.json({ results: [], nextCursor: null });
  let after: { messageSeq: number; partId: string } | undefined;
  let revision: number | undefined;
  const cursor = params.get('cursor');
  if (cursor) {
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (value.sessionId !== id || value.query !== query || !Number.isSafeInteger(value.messageSeq) || value.messageSeq < 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.partId !== 'string') throw new Error('invalid');
      after = { messageSeq: value.messageSeq, partId: value.partId };
      revision = value.revision;
    } catch { throw new WorkflowError('INVALID_INPUT', '搜索游标无效', 422); }
  }
  const store = sessionRuntime(id).store;
  if (!store.searchMessages) throw new WorkflowError('RESOURCE_UNAVAILABLE', '当前会话库不支持搜索', 503);
  try {
    const page = await store.searchMessages(id, { query, limit, after, revision });
    const last = page.results.at(-1);
    return Response.json({
      results: page.results.map(hit => ({ ...hit, projectId: owner.project.id })),
      nextCursor: page.hasMore && last ? Buffer.from(JSON.stringify({ sessionId: id, query, revision: page.revision, messageSeq: last.messageSeq, partId: last.partId })).toString('base64url') : null,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'HISTORY_REVISION_CONFLICT') throw new WorkflowError('CONFLICT', '历史已回溯，请重新搜索', 409, true);
    throw error;
  }
}

export type UsageInfo = {
  used: number;
  contextWindow: number;
  input: number;
  output: number;
  cacheRead: number;
  steps: number;
  /** 会话累计费用（pi 1.5+ 消息级 cost 求和）；providerReported=全部为计费真值 */
  cost?: { total: number; providerReported: boolean };
};

type TokenShape = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

/** 兼容两种事件形状（tokens 在事件本体或 data 里）。 */
function tokensOf(event: { type?: string; tokens?: TokenShape; data?: unknown }): TokenShape | null {
  if (event.type !== 'step-finish') return null;
  if (event.tokens) return event.tokens;
  const data = event.data as { tokens?: TokenShape } | undefined;
  return data?.tokens ?? null;
}

/** 上下文窗口：env 显式覆盖 → 模型目录真实值 → 128k 默认。 */
async function contextWindowFor(sessionId: string, runtime: ReturnType<typeof sessionRuntime>): Promise<number> {
  const override = Number(process.env.LECTERN_CONTEXT_WINDOW ?? process.env.HARNESS_CONTEXT_WINDOW);
  if (Number.isFinite(override) && override > 0) return override;
  try {
    const session = await runtime.store.getSession(sessionId);
    const real = capsFor(session?.model?.modelId)?.contextWindow;
    if (typeof real === 'number' && real > 0) return real;
  } catch {
    // 会话不存在 / store 不可读：回落默认，不影响占用条返回
  }
  return 128_000;
}

/** usage：以最近一次 step-finish 为准（input + cacheRead + output ≈ 当前窗口占用）。 */
async function handleUsage(id: string): Promise<Response> {
  const runtime = sessionRuntime(id);
  const contextWindow = await contextWindowFor(id, runtime);
  const empty: UsageInfo = { used: 0, contextWindow, input: 0, output: 0, cacheRead: 0, steps: 0 };
  try {
    const events = await runtime.eventLog.read(id, 0, 5000);
    let last: TokenShape | null = null;
    let steps = 0;
    for (const event of events as Array<{ type?: string; tokens?: TokenShape; data?: unknown }>) {
      const tokens = tokensOf(event);
      if (tokens) {
        last = tokens;
        steps += 1;
      }
    }
    // 会话累计费用：pi 1.5+ 在 assistant 消息 info.cost 上给出每请求费用
    const messages = await runtime.store.getMessages(id).catch(() => []);
    const costs = messages.flatMap((m) => (m.info as { cost?: { total: number; totalFromProvider?: boolean } }).cost ? [(m.info as { cost: { total: number; totalFromProvider?: boolean } }).cost] : []);
    const cost = costs.length
      ? { total: costs.reduce((sum, c) => sum + (Number.isFinite(c.total) ? c.total : 0), 0), providerReported: costs.every((c) => c.totalFromProvider === true) }
      : undefined;
    if (!last) return Response.json({ ...empty, ...(cost ? { cost } : {}) });
    const input = last.input ?? 0;
    const output = last.output ?? 0;
    const cacheRead = last.cacheRead ?? 0;
    return Response.json({ used: input + output + cacheRead, contextWindow, input, output, cacheRead, steps, ...(cost ? { cost } : {}) } satisfies UsageInfo);
  } catch {
    return Response.json(empty);
  }
}

/** read-state：GET 读；PUT 写（lastReadMessageSeq + historyRevision，CAS 冲突 409）。 */
async function handleReadState(request: Request, id: string): Promise<Response> {
  const store = sessionRuntime(id).store;
  if (request.method === 'GET') {
    if (!store.getReadState) throw new WorkflowError('RESOURCE_UNAVAILABLE', '当前会话库不支持已读状态', 503);
    return Response.json(await store.getReadState(id));
  }
  const body = await request.json().catch(() => null) as { lastReadMessageSeq?: unknown; historyRevision?: unknown } | null;
  if (!Number.isSafeInteger(body?.lastReadMessageSeq) || (body!.lastReadMessageSeq as number) < 0 || !Number.isSafeInteger(body?.historyRevision) || (body!.historyRevision as number) < 1) throw new WorkflowError('INVALID_INPUT', '已读序号和历史版本无效', 422);
  if (!store.markRead) throw new WorkflowError('RESOURCE_UNAVAILABLE', '当前会话库不支持已读状态', 503);
  try { return Response.json(await store.markRead(id, body!.lastReadMessageSeq as number, body!.historyRevision as number)); }
  catch (error) {
    if (error instanceof Error && error.message === 'HISTORY_REVISION_CONFLICT') throw new WorkflowError('CONFLICT', '历史已回溯，请重新加载', 409, true);
    if (error instanceof Error && error.message === 'INVALID_READ_SEQUENCE') throw new WorkflowError('INVALID_INPUT', '已读序号超过最新消息', 422);
    throw error;
  }
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parsePath(url.pathname);
  if (!parsed) return Response.json({ error: '未知的会话读端点' }, { status: 404 });
  const { id, kind } = parsed;
  if (kind === 'read-state') {
    if (request.method !== 'GET' && request.method !== 'PUT') return Response.json({ error: '不支持的 method' }, { status: 405 });
    return handleReadState(request, id);
  }
  if (request.method !== 'GET') return Response.json({ error: '不支持的 method' }, { status: 405 });
  if (kind === 'messages') return handleMessages(url, id);
  if (kind === 'search') return handleSearch(url, id);
  return handleUsage(id);
}

export const handleSessionRead = withWorkflowErrors(handle);
