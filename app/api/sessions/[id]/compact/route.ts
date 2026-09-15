import { withWorkflowErrors, rethrowWorkflowError } from "@/lib/workflow-error";
import { NextResponse } from "next/server";

import { sessionRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 手动压缩当前会话（framework runner.compactSession：无条件跑一次摘要折叠，
 *  摘要落为 compaction part 并发事件，前端事件流自动收到刷新）。 */
async function handlePOST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runtime = sessionRuntime(id);
  try {
    const result = await runtime.runner.compactSession(id);
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    rethrowWorkflowError(error);
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "压缩失败" },
      { status: 500 },
    );
  }
}

export const POST = withWorkflowErrors(handlePOST);
