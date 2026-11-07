import { withWorkflowErrors, rethrowWorkflowError } from "./workflow-error";

import { ComputerUseBroker, listActionsForLease, reconcileInterruptedActions, type CuaAdapter } from "./computer-use";
import { createMacOsCuaAdapter, setAdapterTarget } from "./computer-use-macos";
import { getActiveAttempt, getDeliveryForSession, recordCommandRun, resolveOwner } from "./delivery";
import { sanitizeOutput } from "./sanitize";
import { sessionRuntime } from "./runtime";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** 进程内单 broker（全桌面单 lease 语义，spec §12.2）。broker 跟随 runtime 所在
 *  进程：armed 下 Host 持有（HTTP 经网关、模型工具在 Host 的 runtime 内调用），
 *  legacy 下 Next 持有——两条入口共用本模块的同一实例。 */
const broker = new ComputerUseBroker();
const adapter = createMacOsCuaAdapter();
const leaseOwners = new Map<string, string>();
/** 平台调用串行队列（PC18）：observe 会激活目标应用，与 act 交错会让输入落到
 *  错误窗口——同一时刻只允许一个平台调用，跨请求/跨工具调用一致。 */
let adapterTail: Promise<unknown> = Promise.resolve();
let reconciled = false;

function serialized<T>(run: () => Promise<T>): Promise<T> {
  const pending = adapterTail.then(run, run);
  adapterTail = pending.catch(() => undefined);
  return pending;
}

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

export type ComputerUseResult = { status: number; body: Record<string, unknown> };

/** 桌面控制命令核心（HTTP 控制面与 computer_use 模型工具共用）。
 *
 *  sessionId 由调用方从服务端身份取得（HTTP 为请求体经归属校验；模型工具为
 *  ToolContext.sessionId，模型参数不能指定会话）。根 Task 一律服务端推导。
 *  unattended=true（模型工具）：用户接管不可识别时拒绝取得租约（spec §5.2）。
 *  takeover/resume 只经 HTTP（用户操作），不暴露给模型。 */
export async function computerUseCommand(
  sessionId: string,
  body: Record<string, unknown>,
  opts: { unattended?: boolean; allowUserControls?: boolean } = {},
): Promise<ComputerUseResult> {
  const action = String(body.action ?? "");
  if (!reconciled) {
    // 首次使用时对账（只在实际持有 broker 的进程发生；armed 下 Next 不会走到这里）
    reconciled = true;
    try { reconcileInterruptedActions(); } catch { /* 动作库不可读：后续写入会如实报错 */ }
  }

  // capability 无需会话（系统级探测）
  if (action === "capability") {
    const cap = adapter.probeCapability ? await adapter.probeCapability() : adapter.capability();
    return { status: 200, body: { ok: true, capability: cap } };
  }

  if (!SAFE_ID.test(sessionId)) return { status: 400, body: { error: "缺少或非法 sessionId" } };
  resolveOwner(sessionId); // 会话归属校验（不信任客户端 rootTask/app 之外的归属推导）
  if (action !== "acquire") {
    const lease = broker.leaseStatus();
    if (!lease || leaseOwners.get(lease.leaseId) !== sessionId) {
      return { status: 403, body: { error: "当前会话不拥有桌面控制租约" } };
    }
    if (body.leaseId !== undefined && body.leaseId !== lease.leaseId) {
      return { status: 403, body: { error: "租约不匹配" } };
    }
  }
  const leaseId = String(body.leaseId ?? broker.leaseStatus()?.leaseId ?? "");

  switch (action) {
    case "acquire": {
      if (opts.unattended && adapter.probeCapability) {
        const cap = await adapter.probeCapability();
        if (!cap.available) return { status: 409, body: { ok: false, reason: "capability-unavailable", detail: cap.guidance } };
        if (cap.userTakeover === false) {
          return { status: 409, body: { ok: false, reason: "takeover-unavailable", detail: "无法识别真实用户输入，已禁止无人值守桌面控制" } };
        }
      }
      const task = await sessionRuntime(sessionId).store.task?.getActiveTask(sessionId);
      const rootTaskId = task?.id ?? sessionId;
      const targetApp = String(body.targetApp ?? "");
      if (!targetApp) return { status: 400, body: { error: "targetApp 必填" } };
      const capabilities = Array.isArray(body.capabilities) ? (body.capabilities as string[]) : undefined;
      const r = broker.acquireLease({ rootTaskId, hostInstanceId: "control-service", targetApp, capabilities });
      if (r.ok) {
        leaseOwners.clear();
        leaseOwners.set(r.lease.leaseId, sessionId);
        setAdapterTarget(targetApp);
      }
      return { status: r.ok ? 200 : 409, body: r as unknown as Record<string, unknown> };
    }
    case "observe": {
      const r = await serialized(() => broker.observe(leaseId, adapter as CuaAdapter));
      return { status: r.ok ? 200 : 409, body: r as unknown as Record<string, unknown> };
    }
    case "act": {
      const r = await serialized(() => broker.act(leaseId, {
        observationId: String(body.observationId ?? ""),
        kind: String(body.kind ?? "") as never,
        ...(body.target !== undefined ? { target: String(body.target) } : {}),
        ...(body.value !== undefined ? { value: String(body.value), valueMasked: `***(${String(body.value).length})` } : {}),
      }, adapter as CuaAdapter));
      return { status: r.ok ? 200 : 409, body: r as unknown as Record<string, unknown> };
    }
    case "stop":
      // 紧急停止不排队：立即撤租约并中止进行中的平台调用
      return { status: 200, body: { ok: true, ...broker.emergencyStop() } };
    case "takeover":
      if (!opts.allowUserControls) return { status: 403, body: { error: "接管只能由用户操作" } };
      return { status: 200, body: { ok: broker.takeover() } };
    case "resume":
      if (!opts.allowUserControls) return { status: 403, body: { error: "恢复控制只能由用户操作" } };
      return { status: 200, body: { ok: broker.resume(leaseId) } };
    case "release":
      return { status: 200, body: { ok: true, ...broker.release(leaseId) } };
    case "status":
      return { status: 200, body: { ok: true, lease: broker.leaseStatus() } };
    case "log":
      return { status: 200, body: { ok: true, actions: listActionsForLease(leaseId) } };
    case "attach":
      return { status: 200, body: { ok: true, ...attachEvidence(sessionId, leaseId) } };
    default:
      return { status: 400, body: { error: "未知 action" } };
  }
}

/**
 * POST /api/deliveries/computer-use — 桌面控制面（C1-S3，spec §12）。
 * body: { sessionId?, action }：
 *  - capability：权限探测（C01：缺失给具体设置引导；Windows unavailable）
 *  - acquire { targetApp, capabilities? }：单 lease/排队（根 Task 服务端推导）
 *  - observe：观察（返回 observationId；TTL 5s）
 *  - act { observationId, kind, target?, value? }：单动作（值经内存，日志脱敏）
 *  - stop：紧急停止（清队列、中止进行中动作，C03）；takeover / resume：用户接管与恢复
 *  - status / log { leaseId? }：租约态与动作日志
 *  - attach { leaseId }：动作日志脱敏后挂进 active attempt 证据
 */
async function handlePOST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "无效请求体" }, { status: 400 });
  }
  try {
    const result = await computerUseCommand(String(body.sessionId ?? ""), body, { allowUserControls: true });
    return Response.json(result.body, { status: result.status });
  } catch (err) {
    rethrowWorkflowError(err);
    const message = err instanceof Error ? err.message : "操作失败";
    return Response.json({ error: message }, { status: 500 });
  }
}

export const handleComputerUse = withWorkflowErrors(handlePOST);
