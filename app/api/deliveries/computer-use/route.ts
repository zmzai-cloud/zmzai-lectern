import { withWorkflowErrors, rethrowWorkflowError } from "@/lib/workflow-error";
import { NextResponse, type NextRequest } from "next/server";

import { ComputerUseBroker, listActionsForLease, type CuaAdapter } from "@/lib/computer-use";
import { createMacOsCuaAdapter, setAdapterTarget } from "@/lib/computer-use-macos";
import { getActiveAttempt, getDeliveryForSession, recordCommandRun, resolveOwner } from "@/lib/delivery";
import { sanitizeOutput } from "@/lib/sanitize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** 进程内单 broker（全桌面单 lease 语义，spec §12.2）。 */
const broker = new ComputerUseBroker();
const adapter = createMacOsCuaAdapter();

/** 动作日志 → DeliveryAttempt 证据（脱敏 CommandRun；值永不落库——日志里只有 valueMasked）。 */
function attachEvidence(sessionId: string, leaseId: string): { attached: number } {
  const delivery = getDeliveryForSession(sessionId);
  const active = delivery ? getActiveAttempt(delivery.id) : null;
  if (!active) return { attached: 0 };
  const actions = listActionsForLease(leaseId);
  for (const a of actions) {
    const sanitized = sanitizeOutput(a.detail ?? "");
    recordCommandRun({
      id: a.id,
      deliveryAttemptId: active.id,
      kind: "computer_use",
      requirement: "advisory",
      label: `cua:${a.kind}${a.target ? ` ${a.target}` : ""}`.slice(0, 120),
      command: `computer-use ${a.kind} (obs=${a.observationId.slice(0, 12)})`,
      cwd: "(desktop)",
      status: a.status === "succeeded" ? "passed" : a.status === "unknown" ? "failed" : a.status === "executing" || a.status === "accepted" ? "running" : "failed",
      startedAt: a.at,
      output: sanitized.output,
      outputTruncated: sanitized.truncated,
      outputBytes: sanitized.outputBytes,
    });
  }
  return { attached: actions.length };
}

/**
 * POST /api/deliveries/computer-use — 桌面控制面（C1-S3，spec §12）。
 * body: { sessionId?, action }：
 *  - capability：权限探测（C01：缺失给具体设置引导；Windows unavailable）
 *  - acquire { rootTaskId, targetApp, capabilities? }：单 lease/排队
 *  - observe：观察（返回 observationId；TTL 5s）
 *  - act { observationId, kind, target?, value? }：单动作（值经内存，日志脱敏）
 *  - stop：紧急停止（清队列，C03）；takeover / resume：用户接管与恢复
 *  - status / log { leaseId? }：租约态与动作日志
 *  - attach { leaseId }：动作日志脱敏后挂进 active attempt 证据
 */
async function handlePOST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "无效请求体" }, { status: 400 });
  }
  const action = String(body.action ?? "");

  try {
    // capability 无需会话（系统级探测）
    if (action === "capability") {
      const cap = adapter.probeCapability ? await adapter.probeCapability() : adapter.capability();
      return NextResponse.json({ ok: true, capability: cap });
    }

    const sessionId = String(body.sessionId ?? "");
    if (!SAFE_ID.test(sessionId)) return NextResponse.json({ error: "缺少或非法 sessionId" }, { status: 400 });
    resolveOwner(sessionId); // 会话归属校验（不信任客户端 rootTask/app 之外的归属推导）

    switch (action) {
      case "acquire": {
        const rootTaskId = String(body.rootTaskId ?? sessionId);
        const targetApp = String(body.targetApp ?? "");
        if (!targetApp) return NextResponse.json({ error: "targetApp 必填" }, { status: 400 });
        const capabilities = Array.isArray(body.capabilities) ? (body.capabilities as string[]) : undefined;
        const r = broker.acquireLease({ rootTaskId, hostInstanceId: "next", targetApp, capabilities });
        if (r.ok) setAdapterTarget(targetApp);
        return NextResponse.json(r, { status: r.ok ? 200 : 409 });
      }
      case "observe": {
        const r = await broker.observe(String(body.leaseId ?? ""), adapter as CuaAdapter);
        return NextResponse.json(r, { status: r.ok ? 200 : 409 });
      }
      case "act": {
        const r = await broker.act(String(body.leaseId ?? ""), {
          observationId: String(body.observationId ?? ""),
          kind: String(body.kind ?? "") as never,
          ...(body.target !== undefined ? { target: String(body.target) } : {}),
          ...(body.value !== undefined ? { value: String(body.value), valueMasked: `***(${String(body.value).length})` } : {}),
        }, adapter as CuaAdapter);
        return NextResponse.json(r, { status: r.ok ? 200 : 409 });
      }
      case "stop":
        return NextResponse.json({ ok: true, ...broker.emergencyStop() });
      case "takeover":
        return NextResponse.json({ ok: broker.takeover() });
      case "resume":
        return NextResponse.json({ ok: broker.resume(String(body.leaseId ?? "")) });
      case "release":
        return NextResponse.json({ ok: true, ...broker.release(String(body.leaseId ?? "")) });
      case "status":
        return NextResponse.json({ ok: true, lease: broker.leaseStatus() });
      case "log":
        return NextResponse.json({ ok: true, actions: listActionsForLease(String(body.leaseId ?? "")) });
      case "attach":
        return NextResponse.json({ ok: true, ...attachEvidence(sessionId, String(body.leaseId ?? "")) });
      default:
        return NextResponse.json({ error: "未知 action" }, { status: 400 });
    }
  } catch (err) {
    rethrowWorkflowError(err);
    const message = err instanceof Error ? err.message : "操作失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = withWorkflowErrors(handlePOST);
