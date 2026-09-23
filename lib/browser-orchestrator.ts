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
import { getLatestPlan, startBrowserVerificationRun, type BrowserVerificationRun } from "./browser-verification.js";

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
  const plan = getLatestPlan(attempt.id);
  if (!plan) return { ok: false, reason: "no-plan", detail: "先为该 attempt 保存 VerificationPlan" };
  const manifest = loadSetupManifest(ws.path);
  const devServer = manifest.devServer;

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
