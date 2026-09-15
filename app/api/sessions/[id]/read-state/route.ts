import { type NextRequest } from "next/server";
import { sessionRuntime } from "@/lib/runtime";
import { WorkflowError, withWorkflowErrors } from "@/lib/workflow-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export const GET = withWorkflowErrors(async (_request: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const store = sessionRuntime(id).store;
  if (!store.getReadState) throw new WorkflowError("RESOURCE_UNAVAILABLE", "当前会话库不支持已读状态", 503);
  return Response.json(await store.getReadState(id));
});

export const PUT = withWorkflowErrors(async (request: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const store = sessionRuntime(id).store;
  const body = await request.json().catch(() => null);
  if (!Number.isSafeInteger(body?.lastReadMessageSeq) || body.lastReadMessageSeq < 0 || !Number.isSafeInteger(body?.historyRevision) || body.historyRevision < 1) throw new WorkflowError("INVALID_INPUT", "已读序号和历史版本无效", 422);
  if (!store.markRead) throw new WorkflowError("RESOURCE_UNAVAILABLE", "当前会话库不支持已读状态", 503);
  try { return Response.json(await store.markRead(id, body.lastReadMessageSeq, body.historyRevision)); }
  catch (error) {
    if (error instanceof Error && error.message === "HISTORY_REVISION_CONFLICT") throw new WorkflowError("CONFLICT", "历史已回溯，请重新加载", 409, true);
    if (error instanceof Error && error.message === "INVALID_READ_SEQUENCE") throw new WorkflowError("INVALID_INPUT", "已读序号超过最新消息", 422);
    throw error;
  }
});
