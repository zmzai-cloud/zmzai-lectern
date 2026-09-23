import { withWorkflowErrors, rethrowWorkflowError } from "@/lib/workflow-error";
import { NextResponse, type NextRequest } from "next/server";

import { terminalManager } from "@/lib/runtime";
import { resolveOwner } from "@/lib/delivery";
import { hostServiceDeps } from "@/lib/service-instance";
import { verifierFromEnv } from "@/lib/browser-verifier-adapter";
import { runBrowserQaWithOneRetry } from "@/lib/browser-orchestrator";
import { saveVerificationPlan, listRunsForAttempt, getLatestPlan } from "@/lib/browser-verification";
import { getActiveAttempt, getDeliveryForSession } from "@/lib/delivery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * POST /api/deliveries/browser-qa — 浏览器验证面（V1-S6，spec §11）。
 * body: { sessionId, action }，单一入口（与 deliveries/attempt 同模式）：
 *  - plan   { steps, viewports }：保存 VerificationPlan（版本化+降级守卫服务端拒绝）
 *  - runs   ：列出 active attempt 的 browser runs（分项证据）
 *  - run    { repair?: false }：执行一次浏览器 QA（含一次修复闭环；无 repair
 *           注入时修复=放弃——agent 接线后带真实修复回调）
 *
 * 为什么在 Next 进程内执行而不走 Host：deliveries 库在 Next 侧
 * （<data>/deliveries），Host 进程 dataDir 是 <data>/host——跨进程会双库
 * 裂脑。deliveries 族整体网关化时（B4 遗留批次）随迁。verifier 经
 * LECTERN_VERIFIER_BOOTSTRAP 惰性连 Electron 主进程 endpoint。
 */
async function handlePOST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "无效请求体" }, { status: 400 });
  }
  const sessionId = String(body.sessionId ?? "");
  const action = String(body.action ?? "");
  if (!SAFE_ID.test(sessionId)) return NextResponse.json({ error: "缺少或非法 sessionId" }, { status: 400 });

  try {
    const owner = resolveOwner(sessionId);
    if (!owner) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    const delivery = getDeliveryForSession(sessionId);
    const active = delivery ? getActiveAttempt(delivery.id) : null;

    if (action === "plan") {
      const steps = Array.isArray(body.steps) ? body.steps : null;
      const viewports = Array.isArray(body.viewports) ? body.viewports : null;
      if (!active) return NextResponse.json({ error: "无 active attempt" }, { status: 409 });
      if (!steps || !viewports) return NextResponse.json({ error: "steps/viewports 必填" }, { status: 400 });
      const saved = saveVerificationPlan(active.id, { steps: steps as never, viewports: viewports as never });
      if (!saved.ok) return NextResponse.json({ ok: false, error: saved.reason, detail: saved.detail }, { status: 409 });
      return NextResponse.json({ ok: true, plan: saved.plan });
    }

    if (action === "runs") {
      return NextResponse.json({
        ok: true,
        plan: active ? getLatestPlan(active.id) : null,
        runs: active ? listRunsForAttempt(active.id) : [],
      });
    }

    if (action === "run") {
      if (!active) return NextResponse.json({ error: "无 active attempt" }, { status: 409 });
      if (!active.verificationSnapshot) {
        return NextResponse.json({ error: "attempt 未进入验证（无快照）" }, { status: 409 });
      }
      const result = await runBrowserQaWithOneRetry({
        sessionId,
        deps: hostServiceDeps(terminalManager()),
        verifier: verifierFromEnv() ?? undefined,
        repair: undefined, // agent 修复接线前的显式不修（第二次跑=用户新指令）
      });
      return NextResponse.json({ ok: true, result });
    }

    return NextResponse.json({ error: "未知 action" }, { status: 400 });
  } catch (err) {
    rethrowWorkflowError(err);
    const message = err instanceof Error ? err.message : "操作失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = withWorkflowErrors(handlePOST);
