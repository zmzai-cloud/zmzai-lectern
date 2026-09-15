import { withWorkflowErrors } from "@/lib/workflow-error";
import { NextResponse, type NextRequest } from "next/server";

import { sessionRuntime } from "@/lib/runtime";
import { resolveSessionOwner } from "@/lib/session-owner";
import { WorkflowError } from "@/lib/workflow-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 跨会话恢复：读取某会话已持久化的转录（消息+片段）。
 *
 * view=window 使用绑定会话与 historyRevision 的稳定游标，返回同水位运行快照。
 * tail/skip 仅保留给旧客户端兼容。
 */
async function handleGET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runtime = sessionRuntime(id);
  const url = new URL(request.url);
  if (url.searchParams.get("view") === "window" && runtime.store.getMessageSnapshot) {
    const limitRaw = Number(url.searchParams.get("limit") ?? "50");
    if (!Number.isSafeInteger(limitRaw) || limitRaw < 1 || limitRaw > 200) throw new WorkflowError("INVALID_INPUT","limit 必须是 1..200 的整数",422);
    let before: number | undefined;
    let revision: number | undefined;
    const beforeCursorParam = url.searchParams.get("before");
    const afterCursorParam = url.searchParams.get("after");
    const around = url.searchParams.get("around") ?? undefined;
    if ([beforeCursorParam,afterCursorParam,around].filter(Boolean).length > 1) throw new WorkflowError("INVALID_INPUT", "before、after 和 around 不能同时使用",422);
    const cursor = beforeCursorParam ?? afterCursorParam;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor,"base64url").toString("utf8")) as { sessionId?: unknown; messageSeq?: unknown; historyRevision?: unknown };
        if (decoded.sessionId !== id || !Number.isSafeInteger(decoded.messageSeq) || !Number.isSafeInteger(decoded.historyRevision)) throw new Error("invalid");
        before = decoded.messageSeq as number;
        revision = decoded.historyRevision as number;
      } catch {
        throw new WorkflowError("INVALID_INPUT","历史游标无效",422);
      }
    }
    try {
      const snapshot = await runtime.store.getMessageSnapshot(id,{ limit: limitRaw,before: afterCursorParam ? undefined : before,after: afterCursorParam ? before : undefined,around,revision });
      const beforeCursor = snapshot.nextBefore === null ? null : Buffer.from(JSON.stringify({ sessionId: id,messageSeq: snapshot.nextBefore,historyRevision: snapshot.revision })).toString("base64url");
      const afterCursor = snapshot.nextAfter === null ? null : Buffer.from(JSON.stringify({ sessionId: id,messageSeq: snapshot.nextAfter,historyRevision: snapshot.revision })).toString("base64url");
      return NextResponse.json({
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
      });
    } catch (error) {
      if (error instanceof Error && error.message === "HISTORY_REVISION_CONFLICT") throw new WorkflowError("CONFLICT","历史已发生回溯，请重新加载",409,true);
      if (error instanceof Error && error.message === "MESSAGE_NOT_FOUND") throw new WorkflowError("NOT_FOUND","该消息已不存在，请重新搜索",404);
      throw error;
    }
  }

  const messages = await runtime.store.getMessages(id);
  const tailRaw = Number(url.searchParams.get("tail") ?? "0");
  if (!Number.isFinite(tailRaw) || tailRaw <= 0) {
    // 兼容：无参数 = 全量（旧语义）
    return NextResponse.json(messages);
  }
  const limit = Math.min(200, Math.floor(tailRaw));
  const skipRaw = Number(url.searchParams.get("skip") ?? "0");
  const skip = Number.isFinite(skipRaw) && skipRaw > 0 ? Math.floor(skipRaw) : 0;

  const end = Math.max(0, messages.length - skip);
  const start = Math.max(0, end - limit);
  const page = messages.slice(start, end);
  return NextResponse.json({
    messages: page,
    total: messages.length,
    hasMore: start > 0,
  });
}

export const GET = withWorkflowErrors(handleGET);
