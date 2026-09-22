import { hostGateway } from "@/lib/host-gateway";
import { withWorkflowErrors } from "@/lib/workflow-error";
import { NextResponse, type NextRequest } from "next/server";

import { sessionRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 中止当前运行。 */
async function handlePOST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gateway = await hostGateway(request as unknown as Request);
  if (gateway) return gateway;
  const { id } = await ctx.params;
  const runtime = sessionRuntime(id);
  await runtime.runner.abort(id);
  return NextResponse.json({ ok: true });
}

export const POST = withWorkflowErrors(handlePOST);
