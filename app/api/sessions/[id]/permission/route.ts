import { hostGateway } from "@/lib/host-gateway";
import { withWorkflowErrors } from "@/lib/workflow-error";
import { NextResponse, type NextRequest } from "next/server";

import { sessionRuntime } from "@/lib/runtime";
import { auditPermission } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 权限回复：批准（一次/总是）或拒绝，可选反馈。
 *  每次决定落审计（来源三分：manual 手动 / auto 自动档 / fine-grained 细粒度配置）。 */
async function handlePOST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gateway = await hostGateway(request as unknown as Request);
  if (gateway) return gateway;
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as {
    requestId?: string;
    reply?: "once" | "always" | "reject";
    feedback?: string;
    source?: "manual" | "auto" | "fine-grained";
    permission?: string;
    summary?: string;
  } | null;
  if (!body?.requestId || !body?.reply) {
    return NextResponse.json({ error: "参数不完整" }, { status: 400 });
  }

  const runtime = sessionRuntime(id);
  await runtime.runner.replyPermission(id, body.requestId, body.reply, body.feedback);

  auditPermission({
    at: new Date().toISOString(),
    sessionId: id,
    permission: body.permission ?? "unknown",
    summary: body.summary ?? "",
    decision: body.reply,
    source: body.source ?? "manual",
  });

  return NextResponse.json({ ok: true });
}

export const POST = withWorkflowErrors(handlePOST);
