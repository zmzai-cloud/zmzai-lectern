import { withWorkflowErrors } from "@/lib/workflow-error";
import { NextResponse, type NextRequest } from "next/server";
import { sessionCookieName } from "@/lib/request-cookie";
import { sessionRuntime } from "@/lib/runtime";
import { executeRewind } from "@/lib/rewind-flow";
import { hostGateway } from "@/lib/host-gateway";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 回溯重发：薄壳——网关优先，否则执行 lib/rewind-flow（M2b-B3 抽出，
 *  Host 与本路由共用同一套守卫与重发语义）。 */
async function handlePOST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gateway = await hostGateway(request as unknown as Request);
  if (gateway) return gateway;
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as { messageId?: string; text?: string } | null;
  if (!body?.messageId) return NextResponse.json({ error: "缺少 messageId" }, { status: 400 });
  const cookie = request.cookies.get(sessionCookieName)?.value;
  const outcome = await executeRewind({
    sessionId: id,
    messageId: body.messageId,
    ...(body.text ? { text: body.text } : {}),
    cookieHeader: cookie ? `${sessionCookieName}=${cookie}` : null,
    runtime: sessionRuntime(id) as never,
  });
  if (outcome.ok) return NextResponse.json({ ok: true });
  return NextResponse.json({ error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}) }, { status: outcome.status });
}

export const POST = withWorkflowErrors(handlePOST);
