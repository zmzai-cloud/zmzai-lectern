import { hostGateway } from "@/lib/host-gateway";
import { withWorkflowErrors, WorkflowError } from "@/lib/workflow-error";
import { NextResponse, type NextRequest } from "next/server";

import { sessionRuntime } from "@/lib/runtime";
import { toTaskView } from "@/lib/task-presentation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 当前任务（规格 3 §13.2）。
 *
 * GET   → 活跃任务；没有活跃任务时回退到最近一个终态任务（这样刚交付完的
 *         交付卡在刷新后还在，不会因为「任务已进终态」而凭空消失）。
 * POST  → `{ action: "resume" | "stop" }`。
 *
 * 【为什么不复用 prompt 接口表达「继续」】规格 §19 明文禁止用伪用户消息做
 * continuation，§14.2 也禁止在正常 Attempt 后摆出「继续下一步」。`resume`
 * 不是一条消息，它是「用户核对完外部状态后放行」这个动作本身——走 prompt
 * 会落一条用户消息、会被计入 token、会在聊天记录里出现用户没说过的话。
 */
async function handleGET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gateway = await hostGateway(request as unknown as Request);
  if (gateway) return gateway;
  const { id } = await ctx.params;
  const runtime = sessionRuntime(id);
  const task = runtime.store.task;
  if (!task) return NextResponse.json({ task: null, supported: false });
  const record = (await task.getActiveTask(id)) ?? (await task.getLatestTask(id));
  return NextResponse.json({ task: record ? toTaskView(record) : null, supported: true });
}

async function handlePOST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gateway = await hostGateway(request as unknown as Request);
  if (gateway) return gateway;
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as { action?: string } | null;
  const runtime = sessionRuntime(id);
  if (body?.action === "resume") {
    // 返回 false 表示没什么可继续的（没有活跃任务、已终态、或本来就在正常跑）。
    // 这不是错误，而是「按钮不该出现」的信号；前端据任务状态决定要不要显示它。
    const resumed = await runtime.runner.resumeTask(id);
    return NextResponse.json({ ok: true, resumed });
  }
  if (body?.action === "stop") {
    await runtime.runner.abort(id);
    return NextResponse.json({ ok: true });
  }
  throw new WorkflowError("INVALID_INPUT", "action 只支持 resume / stop", 422);
}

export const GET = withWorkflowErrors(handleGET);
export const POST = withWorkflowErrors(handlePOST);
