import { z } from "zod";
import type { ToolDef } from "@zmzai/agent-framework";

/** browser_verify 模型工具（PC15/PC16，spec §5.1）：Agent 不需要猜内部 HTTP 接口。
 *
 *  - plan：为当前交付提交 **acceptance** 计划（业务交互 + 业务断言）。服务端守卫：
 *    只有可访问性检查的计划不能声称 acceptance；required 步骤只增不减。
 *  - run：在隔离工作区的开发服务上执行一次真实浏览器验证，回传结构化证据
 *    （失败步骤、视口、控制台错误、截图引用）。有界修复：同一任务内首次失败给出
 *    证据、允许修复一次；修复后再失败即落 verification_failed 并停止，不循环自修。
 *    源码变化后自动开新 attempt、重拍快照再验（旧证据随之失效）。
 *  - status：当前计划层级与最近结果。
 *
 *  smoke（默认 goto + body）通过只说明页面可访问，不会把任务标为已验收。
 *  会话取 ToolContext.sessionId；归属、attempt 与计划全部服务端推导。 */

const MAX_FAILED_RUNS_PER_TASK = 2; // 首次失败 + 修复一次后的重验

const stepSchema = z.object({
  kind: z.enum(["goto", "click", "type", "wait", "assert_dom", "assert_visual", "assert_network"]),
  target: z.string().max(400).optional().describe("CSS 选择器；goto 时为路由（如 /settings）"),
  value: z.string().max(2000).optional().describe("type 的输入文本；assert_dom 的期望文本"),
  requirement: z.enum(["required", "advisory"]).default("required"),
});

const parameters = z.object({
  action: z.enum(["status", "plan", "run"]),
  steps: z.array(stepSchema).min(1).max(40).optional().describe("plan 时必填：按用户目标写出的交互与断言步骤"),
  viewports: z.array(z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(320).max(2160) })).min(1).max(4).optional()
    .describe("plan 时可选：验证视口，默认 1280x800；有响应式要求时加移动端视口"),
});

type Args = z.output<typeof parameters>;

function ensureBudgetTable(db: import("node:sqlite").DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS browser_qa_budget (task_key TEXT PRIMARY KEY, failures INTEGER NOT NULL, updated_at TEXT NOT NULL)");
}

async function taskKeyOf(sessionId: string): Promise<string> {
  const { sessionRuntime } = await import("./runtime.js");
  const task = await sessionRuntime(sessionId).store.task?.getActiveTask(sessionId).catch(() => null);
  return `${sessionId}:${task?.id ?? "no-task"}`;
}

/** 当前可用于验证的 attempt：没有就开一个；源码已变（快照失效）就开新的并沿用计划。 */
async function verifyingAttempt(sessionId: string): Promise<{ ok: true; attemptId: string; renewed: boolean } | { ok: false; reason: string }> {
  const delivery = await import("./delivery.js");
  const { getLatestPlan, saveVerificationPlan } = await import("./browser-verification.js");
  const owner = delivery.resolveOwner(sessionId);
  if (!owner) return { ok: false, reason: "会话不存在或无法推导归属" };
  const d = delivery.getDeliveryForSession(sessionId);
  let active = d ? delivery.getActiveAttempt(d.id) : null;
  let renewed = false;
  if (active?.verificationSnapshot && !(await delivery.isSnapshotStillValid(active))) {
    const prior = getLatestPlan(active.id);
    const fresh = delivery.beginAttempt(owner, `run_browser_verify_${Date.now().toString(36)}`);
    await delivery.transitionToVerifying(fresh.id);
    if (prior) {
      const saved = saveVerificationPlan(fresh.id, { steps: prior.steps, viewports: prior.viewports, level: prior.level });
      if (!saved.ok) return { ok: false, reason: `沿用计划失败（${saved.reason}）：修复不得降低验收标准` };
    }
    return { ok: true, attemptId: fresh.id, renewed: true };
  }
  if (!active) {
    active = delivery.beginAttempt(owner, `run_browser_verify_${Date.now().toString(36)}`);
    renewed = true;
  }
  if (!active.verificationSnapshot) await delivery.transitionToVerifying(active.id);
  return { ok: true, attemptId: active.id, renewed };
}

function evidenceText(run: import("./browser-verification.js").BrowserVerificationRun): string {
  const failed = run.steps.filter((s) => s.status !== "passed");
  const lines = failed.slice(0, 12).map((s) => `- [${s.requirement}] ${s.kind}${s.viewport ? ` @${s.viewport.width}x${s.viewport.height}` : ""}：${s.status}${s.detail ? `（${s.detail.slice(0, 200)}）` : ""}${s.consoleErrors ? `；控制台错误 ${s.consoleErrors}` : ""}`);
  if (failed.length > 12) lines.push(`…另有 ${failed.length - 12} 项未展开`);
  if (run.evidenceRefs.length) lines.push(`截图证据：${run.evidenceRefs.slice(0, 4).join("、")}`);
  return lines.join("\n");
}

async function execute(args: Args, sessionId: string): Promise<{ title: string; output: string; metadata: Record<string, unknown> }> {
  const delivery = await import("./delivery.js");
  const { getLatestPlan, saveVerificationPlan, listRunsForAttempt } = await import("./browser-verification.js");

  if (args.action === "status") {
    const d = delivery.getDeliveryForSession(sessionId);
    const active = d ? delivery.getActiveAttempt(d.id) : null;
    const plan = active ? getLatestPlan(active.id) : null;
    const runs = active ? listRunsForAttempt(active.id) : [];
    const last = runs.at(-1);
    return {
      title: "浏览器验证 · 状态",
      output: plan
        ? `计划 v${plan.version}（${plan.level}），${plan.steps.length} 步 × ${plan.viewports.length} 视口；attempt ${active?.status ?? "无"}；最近结果：${last?.status ?? "未运行"}`
        : "当前交付还没有验证计划；用 plan 提交按用户目标写出的 acceptance 计划。",
      metadata: { action: "status", level: plan?.level ?? null, lastRun: last?.status ?? null },
    };
  }

  const attempt = await verifyingAttempt(sessionId);
  if (!attempt.ok) return { title: "浏览器验证 · 不可用", output: attempt.reason, metadata: { action: args.action, ok: false } };

  if (args.action === "plan") {
    if (!args.steps?.length) return { title: "浏览器验证 · 计划未保存", output: "plan 需要 steps", metadata: { action: "plan", ok: false } };
    const saved = saveVerificationPlan(attempt.attemptId, {
      steps: args.steps,
      viewports: args.viewports ?? [{ width: 1280, height: 800 }],
      level: "acceptance",
    });
    if (!saved.ok) return { title: "浏览器验证 · 计划被拒", output: `${saved.reason}：${saved.detail ?? ""}`, metadata: { action: "plan", ok: false, reason: saved.reason } };
    return { title: `浏览器验证 · 计划 v${saved.plan.version}`, output: `已保存 acceptance 计划 v${saved.plan.version}（${saved.plan.steps.length} 步 × ${saved.plan.viewports.length} 视口）。完成实现后用 run 验证。`, metadata: { action: "plan", ok: true, version: saved.plan.version } };
  }

  // run
  const db = delivery.getDb();
  ensureBudgetTable(db);
  const key = await taskKeyOf(sessionId);
  const used = (db.prepare("SELECT failures FROM browser_qa_budget WHERE task_key = ?").get(key) as { failures: number } | undefined)?.failures ?? 0;
  if (used >= MAX_FAILED_RUNS_PER_TASK) {
    return { title: "浏览器验证 · 修复次数已用完", output: "本任务的浏览器验收已失败两次（含一次修复），系统停止自动修复：请向用户如实报告失败项与证据，等待用户决定。", metadata: { action: "run", ok: false, budgetExhausted: true } };
  }

  const { runBrowserVerificationForSession } = await import("./browser-orchestrator.js");
  const { hostServiceDeps } = await import("./service-instance.js");
  const { terminalManager } = await import("./runtime.js");
  const out = await runBrowserVerificationForSession({ sessionId, deps: hostServiceDeps(terminalManager()) });
  if (!out.ok) {
    return { title: "浏览器验证 · 未能执行", output: `${out.reason}${out.detail ? `：${out.detail}` : ""}`, metadata: { action: "run", ok: false, reason: out.reason } };
  }
  const run = out.run;
  const plan = getLatestPlan(attempt.attemptId);
  if (run.status === "unavailable") {
    // 环境原因（如无浏览器驱动）：不算通过、不消耗修复预算
    return { title: "浏览器验证 · 环境不可用", output: `浏览器验证无法执行：${run.unavailableReason ?? "未知原因"}。这不是通过，请如实告知用户。`, metadata: { action: "run", ok: false, status: "unavailable" } };
  }
  if (run.status === "passed") {
    db.prepare("DELETE FROM browser_qa_budget WHERE task_key = ?").run(key);
    if (plan?.level !== "acceptance") {
      return { title: "浏览器验证 · 仅 smoke 通过", output: "页面可访问性检查通过，但这只是 smoke，不代表业务验收：请按用户目标提交 acceptance 计划（交互 + 断言）后再 run。", metadata: { action: "run", ok: false, status: "smoke-only" } };
    }
    delivery.finishWithBrowserQa(attempt.attemptId, true);
    return { title: "浏览器验证 · 验收通过", output: `acceptance 计划 v${plan.version} 全部 required 步骤通过（${run.steps.length} 项）。`, metadata: { action: "run", ok: true, status: "passed", runId: run.id } };
  }

  // failed：消耗一次预算
  const failures = used + 1;
  db.prepare("INSERT INTO browser_qa_budget (task_key, failures, updated_at) VALUES (?, ?, ?) ON CONFLICT(task_key) DO UPDATE SET failures = excluded.failures, updated_at = excluded.updated_at")
    .run(key, failures, new Date().toISOString());
  if (failures >= MAX_FAILED_RUNS_PER_TASK) {
    delivery.finishWithBrowserQa(attempt.attemptId, false);
    return { title: "浏览器验证 · 修复后仍失败", output: `修复后的重验仍未通过，交付已标记验证失败，停止自动修复：\n${evidenceText(run)}\n请向用户如实报告。`, metadata: { action: "run", ok: false, status: "verification_failed", runId: run.id } };
  }
  return {
    title: "浏览器验证 · 未通过（可修复一次）",
    output: `required 步骤未通过：\n${evidenceText(run)}\n请修复源码（不得删除或降级 required 步骤），然后再次 run；修复后若仍失败将停止。`,
    metadata: { action: "run", ok: false, status: "failed", runId: run.id, repairsLeft: MAX_FAILED_RUNS_PER_TASK - failures },
  };
}

export function createBrowserVerifyTool(): ToolDef {
  return {
    id: "browser_verify",
    label: "浏览器验证",
    description:
      "在真实浏览器里验收你做的网页功能（需要隔离工作区且项目声明了 devServer）。" +
      "先 plan：按用户目标写出交互与断言（例如 type 输入 → click 提交 → assert_dom 结果文本；有响应式要求时加移动端视口），" +
      "再 run。只有 goto + body 这类可访问性检查不算验收。失败会返回证据，最多修复一次；不要删除或降级 required 步骤。",
    parameters,
    // run 会启动项目 manifest 声明的开发服务命令：必须走审批（模型可能先改
    // manifest 再调用，不能借本工具绕过终端命令审批）。plan/status 只写交付记录
    permission: (args) => args.action === "run"
      ? { permission: "browser_verify", patterns: ["run"], always: ["run"], metadata: { action: "run" } }
      : null,
    executionMode: "sequential",
    contract: { effect: ["workspace"], retrySafety: "never", concurrency: { mode: "serialized", key: "browser-verify" } },
    async execute(args, ctx) {
      return execute(args, ctx.sessionId);
    },
  };
}
