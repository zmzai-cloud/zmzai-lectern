import { hostGateway } from "@/lib/host-gateway";
import { WorkflowError, withWorkflowErrors } from "@/lib/workflow-error";
import { sessionRuntime } from "@/lib/runtime";
import { withRequestCookie } from "@/lib/request-cookie";
import { sessionCookieName } from "@/lib/relay";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 命令回执查询（T07 / PC10）：「Host 已接受命令但响应丢失」的结果未知窗口里，
 *  客户端显式核对一条 requestId 是否已被接受过一次——found=true 即已登记
 *  （同键重试只会拿回同一回执，绝不重复执行）；found=false 才是真正从未提交。
 *  网关 armed 时直接代理 Host 的 /v1/commands/receipt；进程内模式读本库
 *  workflow.findPrompt 并按同键幂等重放拿回执（与 prompt 路由的 prior 分支
 *  同构——runner.prompt 对既有 requestId 返回原回执，不再起 run）。 */
async function handleGET(request: NextRequest, ctx: { params: Promise<{ id: string; requestId: string }> }) {
  const gateway = await hostGateway(request as unknown as Request);
  if (gateway) return gateway;
  const { id, requestId } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) {
    throw new WorkflowError("INVALID_INPUT", "非法 requestId", 422);
  }
  const runtime = sessionRuntime(id);
  const prior = await runtime.store.workflow?.findPrompt(id, requestId).catch(() => null);
  if (!prior) {
    return Response.json({ found: false, error: "NOT_FOUND", message: "该 requestId 尚未登记" }, { status: 404 });
  }
  const cookie = request.cookies.get(sessionCookieName)?.value;
  const cookieHeader = cookie ? `${sessionCookieName}=${cookie}` : null;
  // 同键重放（幂等）：拿回登记时的原始回执——不产生新消息、不起新 run
  const receipt = await withRequestCookie(cookieHeader, () => runtime.runner.prompt(id, prior.input));
  return Response.json({ found: true, receipt: { ...receipt, requestId }, input: prior.input });
}

export const GET = withWorkflowErrors(handleGET);
