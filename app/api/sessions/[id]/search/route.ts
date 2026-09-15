import { NextResponse, type NextRequest } from "next/server";
import { sessionRuntime } from "@/lib/runtime";
import { resolveSessionOwner } from "@/lib/session-owner";
import { WorkflowError, withWorkflowErrors } from "@/lib/workflow-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withWorkflowErrors(async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const owner = resolveSessionOwner(id);
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "").trim();
  const limit = Number(params.get("limit") ?? 30);
  if (query.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new WorkflowError("INVALID_INPUT", "搜索词最多 200 字符，limit 必须是 1..100 的整数", 422);
  if (!query) return NextResponse.json({ results: [], nextCursor: null });
  let after: { messageSeq: number; partId: string } | undefined;
  let revision: number | undefined;
  const cursor = params.get("cursor");
  if (cursor) {
    try {
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (value.sessionId !== id || value.query !== query || !Number.isSafeInteger(value.messageSeq) || value.messageSeq < 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.partId !== "string") throw new Error("invalid");
      after = { messageSeq: value.messageSeq, partId: value.partId };
      revision = value.revision;
    } catch { throw new WorkflowError("INVALID_INPUT", "搜索游标无效", 422); }
  }
  const store = sessionRuntime(id).store;
  if (!store.searchMessages) throw new WorkflowError("RESOURCE_UNAVAILABLE", "当前会话库不支持搜索", 503);
  try {
    const page = await store.searchMessages(id, { query, limit, after, revision });
    const last = page.results.at(-1);
    return NextResponse.json({
      results: page.results.map(hit => ({ ...hit, projectId: owner.project.id })),
      nextCursor: page.hasMore && last ? Buffer.from(JSON.stringify({ sessionId: id, query, revision: page.revision, messageSeq: last.messageSeq, partId: last.partId })).toString("base64url") : null,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "HISTORY_REVISION_CONFLICT") throw new WorkflowError("CONFLICT", "历史已回溯，请重新搜索", 409, true);
    throw error;
  }
});
