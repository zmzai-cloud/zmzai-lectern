/** W1 后 V1-S4：浏览器验证编排层——把 S1 状态机 / S2 服务解析 / S3 verifier
 *  通道组合成「attempt 一次浏览器验证」的完整闭环（spec §11.2 执行序）。
 *
 *  序列：attempt 快照指纹 → 服务解析（borrowed/owned 复用优先，同代码版本可
 *  核对）→ verifier（注入优先，缺省 LECTERN_VERIFIER_BOOTSTRAP 惰性接 Electron）
 *  → run 执行 → owned 服务按生命周期关闭（borrowed 仅解除绑定，不停）。
 *
 *  依赖注入：terminal（生产 TerminalManager）/ verifier / probe 全可替换——
 *  vitest 用真 http 服务 + mock verifier 验全链路；Electron 真浏览器归 S5 e2e。 */
import { dataDir } from "./runtime-constants.js";
import { getAttempt, getDeliveryForSession, getActiveAttempt } from "./delivery.js";
import { loadSetupManifest, workspaceRecordForSession } from "./workspace-service.js";
import { findReusableService, startOwnedService, stopServiceInstance, type ServiceDeps, type ServiceInstance } from "./service-instance.js";
import { verifierFromEnv } from "./browser-verifier-adapter.js";
import { getLatestPlan, saveVerificationPlan, startBrowserVerificationRun, type BrowserVerificationRun } from "./browser-verification.js";

export type OrchestrationOutcome =
  | { ok: true; run: BrowserVerificationRun; service: ServiceInstance | null }
  | { ok: false; reason: "no-attempt" | "no-snapshot" | "no-plan" | "no-workspace" | "service-failed" | "no-verifier"; detail?: string; run?: BrowserVerificationRun };

/** 对某个 sessionId 的 active attempt 跑一次浏览器验证。
 *  （换 attempt 重跑 = 调用方先 begin 新 attempt；本函数不猜 attempt。） */
export async function runBrowserVerificationForSession(input: {
  sessionId: string;
  /** 服务解析依赖（生产 hostServiceDeps(terminalManager())）。 */
  deps: ServiceDeps;
  /** 显式注入 verifier（测试）；缺省走 LECTERN_VERIFIER_BOOTSTRAP 惰性通道。 */
  verifier?: import("./browser-verification.js").BrowserVerifierAdapter;
}): Promise<OrchestrationOutcome> {
  const delivery = getDeliveryForSession(input.sessionId);
  const attempt = delivery ? getActiveAttempt(delivery.id) : null;
  if (!attempt) return { ok: false, reason: "no-attempt" };
  const snap = attempt.verificationSnapshot;
  if (!snap?.worktreeFingerprint) return { ok: false, reason: "no-snapshot" };

  // 工作区与命令解析：workspace 记录（隔离会话）→ manifest devServer 声明
  // （先于 plan 检查——无隔离工作区是硬性前置，普通会话不谈浏览器验证）
  const ws = workspaceRecordForSession(dataDir, input.sessionId);
  if (!ws) return { ok: false, reason: "no-workspace", detail: "会话无隔离工作区（浏览器验证当前仅支持 workspace 会话）" };
  const manifest = loadSetupManifest(ws.path);
  const devServer = manifest.devServer;
  // Plan 产生方：显式保存的 plan 优先；无 plan 但 devServer 已声明 → 合成
  // 默认 plan（goto 根路由 + body 渲染存在断言，required）——项目声明即最低
  // 验收，AI/用户可用 plan API 增补更严断言（降级守卫保证只增不减）
  let plan = getLatestPlan(attempt.id);
  if (!plan) {
    if (!devServer) return { ok: false, reason: "no-plan", detail: "无 VerificationPlan 且 manifest 未声明 devServer" };
    const synthesized = saveVerificationPlan(attempt.id, {
      steps: [
        { kind: "goto", target: "/", requirement: "required" },
        { kind: "assert_dom", target: "body", requirement: "required" },
      ],
      viewports: [{ width: 1280, height: 800 }],
    });
    if (!synthesized.ok) return { ok: false, reason: "no-plan", detail: `默认 plan 保存失败：${synthesized.detail ?? synthesized.reason}` };
    plan = synthesized.plan;
  }

  // 服务解析（§11.2.2）：同 workspace+同指纹可核对复用 → owned 启动
  let service = findReusableService({ workspaceId: ws.workspaceId, snapshotFingerprint: snap.worktreeFingerprint });
  if (!service) {
    if (!devServer) return { ok: false, reason: "service-failed", detail: "无可复用服务且 manifest 未声明 devServer" };
    const started = await startOwnedService({
      workspaceId: ws.workspaceId,
      attemptId: attempt.id,
      cwd: ws.path,
      command: devServer.command,
      preferredPort: devServer.port,
      snapshotFingerprint: snap.worktreeFingerprint,
    }, input.deps);
    if (!started.ok) return { ok: false, reason: "service-failed", detail: started.reason };
    service = started.instance;
  }

  // verifier：注入优先 → env 惰性（dev/web 无 Electron → 如实 unavailable）
  const verifier = input.verifier ?? verifierFromEnv() ?? undefined;

  const run = await startBrowserVerificationRun({
    attemptId: attempt.id,
    snapshotFingerprint: snap.worktreeFingerprint,
    serviceId: service.id,
    verifier,
  });

  // 收尾（§11.3）：owned 服务验证结束即停（生命周期归 Host）；borrowed 不停
  if (service.owned) await stopServiceInstance(service.id, input.deps).catch(() => undefined);

  return { ok: true, run, service };
}

// ===== V1-S5：一次修复闭环（spec §11.2.6 / V03）=====

export type BrowserQaOutcome =
  | { outcome: "passed"; run: BrowserVerificationRun }
  | { outcome: "verification-failed"; run: BrowserVerificationRun; repairedOnce: boolean }
  | { outcome: "unavailable"; run: BrowserVerificationRun }
  | { outcome: "stale"; detail: string };

/** 首次 required 浏览器 QA 失败 → 同根预算内修复**一次**（repair 回调，生产=
 *  agent 续跑修代码）→ 新 attempt 重验（supersede 使旧成功证据失效，快照
 *  重拍）；第二次失败 → verification_failed 停手，不循环自修。
 *  修复计数独立于 §9 任务策略。unavailable 不触发修复循环（环境原因，
 *  保持 unverified 语义）；重验/收尾前核快照仍有效（验证中源码变化 → stale）。 */
export async function runBrowserQaWithOneRetry(input: {
  sessionId: string;
  deps: ServiceDeps;
  verifier?: import("./browser-verification.js").BrowserVerifierAdapter;
  /** 修复动作；返回 false = 放弃修复直接终态。 */
  repair?: (failureSummary: string) => Promise<boolean>;
}): Promise<BrowserQaOutcome> {
  const delivery = await import("./delivery.js");

  const activeOf = () => {
    const d = getDeliveryForSession(input.sessionId);
    return d ? getActiveAttempt(d.id) : null;
  };
  const runOnce = async () => {
    const out = await runBrowserVerificationForSession({ sessionId: input.sessionId, deps: input.deps, verifier: input.verifier });
    if (!out.ok) return { kind: "orchestration-failed" as const, detail: `${out.reason}: ${out.detail ?? ""}` };
    return { kind: "run" as const, run: out.run };
  };

  const first = await runOnce();
  if (first.kind === "orchestration-failed") {
    // 无 plan/无 workspace/服务起不来等编排前置失败：不进修复循环，如实返回
    return { outcome: "stale", detail: `编排前置失败：${first.detail}`.slice(0, 240) };
  }
  if (first.run.status === "passed") {
    const attempt = activeOf();
    if (attempt) {
      // 收尾前核对快照仍有效（验证过程中源码被改 → 旧通过不作数）
      if (!(await delivery.isSnapshotStillValid(attempt))) {
        return { outcome: "stale", detail: "验证过程中源码已变化（快照失效），需重新验证" };
      }
      delivery.finishWithBrowserQa(attempt.id, true);
    }
    return { outcome: "passed", run: first.run };
  }
  if (first.run.status === "unavailable") {
    return { outcome: "unavailable", run: first.run }; // 环境原因不触发修复（spec §11.2.7）
  }

  // required 失败 → 修复一次
  const failedSteps = first.run.steps.filter((s) => s.requirement === "required" && s.status === "failed");
  const failureSummary = `浏览器 QA required 失败 ${failedSteps.length} 项：${failedSteps.map((s) => `${s.kind}@${s.viewport?.width ?? "?"}x${s.viewport?.height ?? "?"} ${s.detail ?? ""}`).join("；").slice(0, 400)}`;
  const oldAttempt = activeOf();
  if (!input.repair || !(await input.repair(failureSummary))) {
    if (oldAttempt) delivery.finishWithBrowserQa(oldAttempt.id, false);
    return { outcome: "verification-failed", run: first.run, repairedOnce: false };
  }

  // 新 attempt（supersede 旧 → 旧成功证据失效）+ 新快照 + 同 plan（降级守卫
  // 拒绝任何 required 降级——修复只能改实现，不能改验收标准）
  const owner = delivery.resolveOwner(input.sessionId)!;
  const newAttempt = delivery.beginAttempt(owner, `run_repair_${Date.now().toString(36)}`);
  await delivery.transitionToVerifying(newAttempt.id);
  const priorPlan = getLatestPlan(oldAttempt?.id ?? "");
  if (priorPlan) {
    const saved = saveVerificationPlanPublic(newAttempt.id, { steps: priorPlan.steps, viewports: priorPlan.viewports });
    if (!saved.ok) {
      return { outcome: "stale", detail: `重试 plan 保存被拒（${saved.reason}）：修复不得降低验收标准` };
    }
  }

  const second = await runOnce();
  if (second.kind === "orchestration-failed") {
    delivery.cancelAttempt(newAttempt.id);
    return { outcome: "verification-failed", run: first.run, repairedOnce: true };
  }
  const attempt2 = activeOf();
  if (second.run.status === "passed" && attempt2) {
    if (!(await delivery.isSnapshotStillValid(attempt2))) {
      return { outcome: "stale", detail: "重验过程中源码已变化（快照失效），需重新验证" };
    }
    delivery.finishWithBrowserQa(attempt2.id, true);
    return { outcome: "passed", run: second.run };
  }
  // 第二次失败（或 unavailable——环境原因也停手，修复预算已用完）：终态
  if (attempt2 && second.run.status !== "unavailable") delivery.finishWithBrowserQa(attempt2.id, false);
  if (attempt2 && second.run.status === "unavailable") delivery.cancelAttempt(attempt2.id);
  return { outcome: "verification-failed", run: second.run, repairedOnce: true };
}

// saveVerificationPlan 从 browser-verification 引入（避免循环依赖的重导出噪音）
import { saveVerificationPlan as saveVerificationPlanPublic } from "./browser-verification.js";
