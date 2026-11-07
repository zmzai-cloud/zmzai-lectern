import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const fx = vi.hoisted(() => ({
  dir: "",
  owner: (() => null) as (sid: string) => unknown,
  verifier: null as unknown,
  deps: null as unknown,
}));
vi.mock("./runtime-constants", () => ({ get dataDir() { return fx.dir; } }));
vi.mock("./session-owner", () => ({ resolveSessionOwner: (sid: string) => fx.owner(sid) }));
vi.mock("./runtime", () => ({
  sessionRuntime: (sid: string) => ({ store: { task: { getActiveTask: async () => ({ id: `task_${sid}` }) } } }),
  terminalManager: () => ({}),
}));
vi.mock("./browser-verifier-adapter", () => ({ verifierFromEnv: () => fx.verifier }));
vi.mock("./service-instance", async (importOriginal) => ({ ...(await importOriginal<object>()), hostServiceDeps: () => fx.deps }));
import { runBrowserQaWithOneRetry } from "./browser-orchestrator.js";
import { planLevelOf, saveVerificationPlan, getLatestPlan, type BrowserVerifierAdapter, type VerificationStep } from "./browser-verification.js";
import { createWorkspace } from "./workspace-service.js";
import { probeOrigin, type ServiceDeps } from "./service-instance.js";
import { createBrowserVerifyTool } from "./browser-verify-tool.js";

/** PC15/PC16（spec §5.1，P0 2026-11-07）：smoke 与 acceptance 分级、业务验收门禁、
 *  browser_verify 模型工具的有界修复。编排/计划/交付状态/SQLite 为真实实现；
 *  浏览器驱动为可编程假件（真实 Chromium 闭环见 scripts/browser-acceptance-native.mjs）。 */

const base = mkdtempSync(path.join(tmpdir(), "browser-p0-"));
fx.dir = path.join(base, "data");
mkdirSync(fx.dir, { recursive: true });
afterAll(async () => { await rm(base, { recursive: true, force: true }); });
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

function serve(): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body><form id=f></form><div id=result></div></body></html>"); });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

function deps(port: number): ServiceDeps {
  return {
    spawnService: async () => ({ terminalId: "tty_fixture" }),
    stopSpawned: async () => undefined,
    portAllocator: () => port,
    probe: (origin, expected) => probeOrigin(origin, expected),
  } as ServiceDeps;
}

/** 可编程驱动：#result 断言在 broken 时失败（模拟表单提交后结果不对）。 */
function formVerifier(state: { broken: boolean }): BrowserVerifierAdapter {
  return {
    openContext: async () => ({ ok: true, browserContextId: "ctx" }),
    runStep: async ({ step }) => (step.kind === "assert_dom" && step.target === "#result" && state.broken
      ? { status: "failed", detail: "期望文本「已提交：Ada」，实际为空", consoleErrors: 1 }
      : { status: "passed", consoleErrors: 0 }),
    captureScreenshot: async () => ({ artifactRef: "browser-screenshots/fail.png" }),
    closeContext: async () => undefined,
  };
}

/** 隔离工作区会话（项目 manifest 声明 devServer）。返回 worktree 路径。 */
async function workspaceSession(sessionId: string, port: number): Promise<string> {
  const repo = mkdtempSync(path.join(base, `repo-${sessionId}-`));
  execSync("git init -q -b main && git config user.email t@t && git config user.name t && echo app > a.txt && mkdir -p .lectern", { cwd: repo, shell: "/bin/bash" });
  writeFileSync(path.join(repo, ".lectern", "workspace.json"), JSON.stringify({ devServer: { command: "npm run dev -- --port {port}", port } }));
  execSync("git add . && git commit -qm init", { cwd: repo, shell: "/bin/bash" });
  const wt = path.join(repo, ".lectern-worktrees", sessionId);
  fx.owner = (sid: string) => ({ sessionId: sid, project: { id: "p", path: repo }, effectiveWorkspaceRoot: existsSync(path.join(repo, ".lectern-worktrees", sid)) ? path.join(repo, ".lectern-worktrees", sid) : repo });
  const created = await createWorkspace({ dataDir: fx.dir, projectId: "p", projectPath: repo, sessionId });
  if (!created.ok) throw new Error("workspace 创建失败");
  return wt;
}

const FORM_PLAN: VerificationStep[] = [
  { kind: "goto", target: "/", requirement: "required" },
  { kind: "assert_dom", target: "body", requirement: "required" },
  { kind: "type", target: "#name", value: "Ada", requirement: "required" },
  { kind: "click", target: "#submit", requirement: "required" },
  { kind: "assert_dom", target: "#result", value: "已提交：Ada", requirement: "required" },
];

describe("PC15：smoke 与 acceptance 分级", () => {
  it("层级推导：只有 goto/wait/body 存在 = smoke；含 required 交互或业务断言 = acceptance", () => {
    expect(planLevelOf([{ kind: "goto", target: "/", requirement: "required" }, { kind: "assert_dom", target: "body", requirement: "required" }])).toBe("smoke");
    expect(planLevelOf([{ kind: "goto", target: "/", requirement: "required" }, { kind: "click", target: "#x", requirement: "advisory" }])).toBe("smoke");
    expect(planLevelOf(FORM_PLAN)).toBe("acceptance");
  });

  it("smoke 冒充 acceptance 被拒；已有 acceptance 不得降回 smoke；required 只增不减", async () => {
    const delivery = await import("./delivery.js");
    const svc = await serve(); closers.push(svc.close);
    await workspaceSession("ses_guard", svc.port);
    const attempt = delivery.beginAttempt(delivery.resolveOwner("ses_guard")!, "run_guard");
    await delivery.transitionToVerifying(attempt.id);
    expect(saveVerificationPlan(attempt.id, { steps: FORM_PLAN.slice(0, 2), viewports: [{ width: 1280, height: 800 }], level: "acceptance" })).toMatchObject({ ok: false, reason: "acceptance-too-weak" });
    expect(saveVerificationPlan(attempt.id, { steps: FORM_PLAN, viewports: [{ width: 1280, height: 800 }] })).toMatchObject({ ok: true, plan: { level: "acceptance" } });
    expect(saveVerificationPlan(attempt.id, { steps: FORM_PLAN.slice(0, 2), viewports: [{ width: 1280, height: 800 }], level: "smoke" })).toMatchObject({ ok: false, reason: "downgrade-rejected" });
    expect(saveVerificationPlan(attempt.id, { steps: FORM_PLAN.slice(0, 4), viewports: [{ width: 1280, height: 800 }] })).toMatchObject({ ok: false, reason: "downgrade-rejected" });
  });

  it("默认合成计划只算 smoke：全部通过也不落 ready_for_review（返回 smoke-only）", async () => {
    const delivery = await import("./delivery.js");
    const svc = await serve(); closers.push(svc.close);
    await workspaceSession("ses_smoke", svc.port);
    const attempt = delivery.beginAttempt(delivery.resolveOwner("ses_smoke")!, "run_smoke");
    await delivery.transitionToVerifying(attempt.id);
    const out = await runBrowserQaWithOneRetry({ sessionId: "ses_smoke", deps: deps(svc.port), verifier: formVerifier({ broken: false }) });
    expect(out.outcome).toBe("smoke-only");
    expect(getLatestPlan(attempt.id)?.level).toBe("smoke");
    expect(delivery.getAttempt(attempt.id)?.status).not.toBe("ready_for_review");
  });

  it("smoke 步骤通过但表单结果断言失败 → 业务验收不通过（verification-failed）", async () => {
    const delivery = await import("./delivery.js");
    const svc = await serve(); closers.push(svc.close);
    await workspaceSession("ses_form_fail", svc.port);
    const attempt = delivery.beginAttempt(delivery.resolveOwner("ses_form_fail")!, "run_form");
    await delivery.transitionToVerifying(attempt.id);
    expect(saveVerificationPlan(attempt.id, { steps: FORM_PLAN, viewports: [{ width: 1280, height: 800 }] }).ok).toBe(true);
    const out = await runBrowserQaWithOneRetry({ sessionId: "ses_form_fail", deps: deps(svc.port), verifier: formVerifier({ broken: true }) });
    expect(out.outcome).toBe("verification-failed");
    if (out.outcome !== "verification-failed") return;
    const smokeSteps = out.run.steps.filter((s) => s.kind === "goto" || (s.kind === "assert_dom" && s.detail === undefined && s.status === "passed"));
    expect(smokeSteps.length).toBeGreaterThan(0); // 可访问性步骤确实通过了
    expect(delivery.getAttempt(attempt.id)?.status).toBe("verification_failed");
  });
});

describe("PC16：真实驱动语义回归", () => {
  it("编排把受管服务 origin 交给驱动：相对路由 goto 能打开被测页面（此前漏传，真实驱动恒 unavailable）", async () => {
    const delivery = await import("./delivery.js");
    const svc = await serve(); closers.push(svc.close);
    await workspaceSession("ses_origin", svc.port);
    const attempt = delivery.beginAttempt(delivery.resolveOwner("ses_origin")!, "run_origin");
    await delivery.transitionToVerifying(attempt.id);
    saveVerificationPlan(attempt.id, { steps: FORM_PLAN, viewports: [{ width: 1280, height: 800 }] });
    const origins: (string | undefined)[] = [];
    // 与 electron/verifier.cjs 同语义：相对 goto 没有 serviceOrigin 即 unavailable
    const strict: BrowserVerifierAdapter = {
      ...formVerifier({ broken: false }),
      runStep: async ({ step, serviceOrigin }) => {
        origins.push(serviceOrigin);
        if (step.kind === "goto" && !serviceOrigin) return { status: "unavailable", detail: "无 serviceOrigin 且 target 非绝对 URL" };
        return { status: "passed", consoleErrors: 0 };
      },
    };
    const out = await runBrowserQaWithOneRetry({ sessionId: "ses_origin", deps: deps(svc.port), verifier: strict });
    expect(out.outcome).toBe("passed");
    expect(origins.every((o) => o === `http://127.0.0.1:${svc.port}`)).toBe(true);
  });

  it("required 步骤不可用后本视口剩余步骤不再执行（不级联挂到通道超时），如实记为未执行", async () => {
    const delivery = await import("./delivery.js");
    const svc = await serve(); closers.push(svc.close);
    await workspaceSession("ses_blocked", svc.port);
    const attempt = delivery.beginAttempt(delivery.resolveOwner("ses_blocked")!, "run_blocked");
    await delivery.transitionToVerifying(attempt.id);
    saveVerificationPlan(attempt.id, { steps: FORM_PLAN, viewports: [{ width: 1280, height: 800 }, { width: 390, height: 844 }] });
    let calls = 0;
    const dead: BrowserVerifierAdapter = { ...formVerifier({ broken: false }), runStep: async () => { calls += 1; return { status: "unavailable", detail: "通道超时" }; } };
    const out = await runBrowserQaWithOneRetry({ sessionId: "ses_blocked", deps: deps(svc.port), verifier: dead });
    expect(out.outcome).toBe("unavailable");
    expect(calls).toBe(2); // 每视口只执行首个步骤
    if (out.outcome !== "unavailable") return;
    expect(out.run.steps).toHaveLength(FORM_PLAN.length * 2);
    expect(out.run.steps.filter((s) => s.detail?.includes("未执行"))).toHaveLength((FORM_PLAN.length - 1) * 2);
  });
});

describe("PC16：browser_verify 模型工具（有界修复）", () => {
  const tool = createBrowserVerifyTool();
  const call = (sessionId: string, args: Record<string, unknown>) => tool.execute(tool.parameters.parse(args), { sessionId, abort: new AbortController().signal } as never);

  it("权限：run 启动开发服务须审批；plan/status 不需要", () => {
    expect(tool.permission({ action: "run" } as never)).toMatchObject({ permission: "browser_verify" });
    expect(tool.permission({ action: "plan" } as never)).toBeNull();
  });

  it("acceptance 计划 → 失败给证据 → 修复（源码变化）→ 自动新 attempt 重验通过 → ready_for_review", async () => {
    const delivery = await import("./delivery.js");
    const svc = await serve(); closers.push(svc.close);
    const wt = await workspaceSession("ses_tool_fix", svc.port);
    const state = { broken: true };
    fx.verifier = formVerifier(state);
    fx.deps = deps(svc.port);

    const weak = await call("ses_tool_fix", { action: "plan", steps: FORM_PLAN.slice(0, 2) });
    expect(weak.metadata).toMatchObject({ ok: false, reason: "acceptance-too-weak" });
    expect((await call("ses_tool_fix", { action: "plan", steps: FORM_PLAN })).metadata).toMatchObject({ ok: true });

    const first = await call("ses_tool_fix", { action: "run" });
    expect(first.metadata).toMatchObject({ status: "failed", repairsLeft: 1 });
    expect(first.output).toContain("assert_dom");
    expect(first.output).toContain("期望文本「已提交：Ada」");
    expect(first.output).toContain("browser-screenshots/fail.png");
    const failedAttempt = delivery.getActiveAttempt(delivery.getDeliveryForSession("ses_tool_fix")!.id)!.id;

    // 模型修复源码（工作区内容变化 → 旧快照失效）
    writeFileSync(path.join(wt, "fix.txt"), "fixed\n");
    state.broken = false;
    const second = await call("ses_tool_fix", { action: "run" });
    expect(second.metadata).toMatchObject({ ok: true, status: "passed" });
    const active = delivery.getActiveAttempt(delivery.getDeliveryForSession("ses_tool_fix")!.id)!;
    expect(active.id).not.toBe(failedAttempt); // 新 attempt 重拍快照
    expect(active.status).toBe("ready_for_review");
    expect(getLatestPlan(active.id)?.level).toBe("acceptance"); // 计划随 attempt 沿用、未降级
  });

  it("修复后仍失败 → verification_failed 并停止；第三次 run 被拒（修复有界）", async () => {
    const delivery = await import("./delivery.js");
    const svc = await serve(); closers.push(svc.close);
    const wt = await workspaceSession("ses_tool_twice", svc.port);
    fx.verifier = formVerifier({ broken: true });
    fx.deps = deps(svc.port);
    await call("ses_tool_twice", { action: "plan", steps: FORM_PLAN });
    expect((await call("ses_tool_twice", { action: "run" })).metadata).toMatchObject({ status: "failed" });
    writeFileSync(path.join(wt, "attempt2.txt"), "still broken\n");
    const second = await call("ses_tool_twice", { action: "run" });
    expect(second.metadata).toMatchObject({ status: "verification_failed" });
    const active = delivery.getActiveAttempt(delivery.getDeliveryForSession("ses_tool_twice")!.id)!;
    expect(active.status).toBe("verification_failed");
    const third = await call("ses_tool_twice", { action: "run" });
    expect(third.metadata).toMatchObject({ budgetExhausted: true });
  });

  it("无浏览器驱动 → 如实 unavailable，不算通过、不消耗修复预算", async () => {
    const svc = await serve(); closers.push(svc.close);
    await workspaceSession("ses_tool_nodriver", svc.port);
    fx.verifier = null;
    fx.deps = deps(svc.port);
    await call("ses_tool_nodriver", { action: "plan", steps: FORM_PLAN });
    const r = await call("ses_tool_nodriver", { action: "run" });
    expect(r.metadata).toMatchObject({ ok: false, status: "unavailable" });
    expect(r.output).toContain("不是通过");
    fx.verifier = formVerifier({ broken: false });
    expect((await call("ses_tool_nodriver", { action: "run" })).metadata).toMatchObject({ ok: true, status: "passed" });
  });
});
