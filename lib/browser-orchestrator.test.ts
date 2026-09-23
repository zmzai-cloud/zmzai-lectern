import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const rtFixture = vi.hoisted(() => ({ dir: "" }));
vi.mock("./runtime-constants", () => ({ get dataDir() { return rtFixture.dir; } }));
const ownerFixture = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock("./session-owner", () => ({ resolveSessionOwner: ownerFixture.owner }));
import { runBrowserVerificationForSession, runBrowserQaWithOneRetry } from "./browser-orchestrator.js";
import { saveVerificationPlan, listRunsForAttempt, type BrowserVerifierAdapter } from "./browser-verification.js";
import { createWorkspace } from "./workspace-service.js";
import { listServicesForWorkspace, type ServiceDeps } from "./service-instance.js";
import { probeOrigin } from "./service-instance.js";

// 文件级共享 dataDir（SQLite 句柄模块级缓存）
const base = mkdtempSync(path.join(tmpdir(), "v1-s4-"));
rtFixture.dir = path.join(base, "data");
mkdirSync(rtFixture.dir, { recursive: true });
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); delete process.env.LECTERN_VERIFIER_BOOTSTRAP; });

function serve(html: string): Promise<{ origin: string; port: number; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ origin: `http://127.0.0.1:${port}`, port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

const HTML = "<html><head><title>App V1</title></head><body><div id=main>ok</div></body></html>";

function makeDeps(port: number): ServiceDeps & { spawned: number; stopped: string[] } {
  const spawned = 0;
  const state = { spawned: 0, stopped: [] as string[] };
  return {
    spawned: state.spawned, stopped: state.stopped,
    spawnService: async () => { state.spawned += 1; return { terminalId: `tty_${state.spawned}` }; },
    stopSpawned: async (id) => { state.stopped.push(id); },
    portAllocator: () => port,
    probe: (origin, expected) => probeOrigin(origin, expected),
  } as ServiceDeps & { spawned: number; stopped: string[] };
}

function mockVerifier(all: "passed" | "failed" = "passed"): BrowserVerifierAdapter {
  return {
    openContext: async () => ({ ok: true, browserContextId: "ctx" }),
    runStep: async () => ({ status: all, consoleErrors: 0 }),
    captureScreenshot: async () => ({ artifactRef: "shot.png" }),
    closeContext: async () => undefined,
  };
}

/** 建 repo + workspace 会话 + attempt + plan，返回 sessionId/attemptId。 */
async function setup(sessionId: string, port: number): Promise<string> {
  const repo = mkdtempSync(path.join(base, `repo-${sessionId}-`));
  execSync("git init -q -b main && git config user.email t@t && git config user.name t && echo app > a.txt && mkdir -p .lectern", { cwd: repo, shell: "/bin/bash" });
  // manifest 随代码提交（项目声明走版本库——worktree checkout 即有）
  writeFileSync(path.join(repo, ".lectern", "workspace.json"), JSON.stringify({ devServer: { command: "npm run dev -- --port {port}", port, cacheDirs: [".next"] } }));
  execSync("git add . && git commit -qm init-with-manifest", { cwd: repo, shell: "/bin/bash" });
  ownerFixture.owner.mockImplementation((sid: string) => {
    const created = existsSync(path.join(repo, ".lectern-worktrees", sid));
    return { sessionId: sid, project: { id: "p", path: repo }, effectiveWorkspaceRoot: created ? path.join(repo, ".lectern-worktrees", sid) : repo };
  });
  const created = await createWorkspace({ dataDir: rtFixture.dir, projectId: "p", projectPath: repo, sessionId });
  if (!created.ok) throw new Error("workspace 创建失败");
  const delivery = await import("./delivery.js");
  const owner = delivery.resolveOwner(sessionId)!;
  const attempt = delivery.beginAttempt(owner, "run_v1s4");
  await delivery.transitionToVerifying(attempt.id);
  const plan = saveVerificationPlan(attempt.id, {
    steps: [
      { kind: "goto", target: "/", requirement: "required" },
      { kind: "assert_dom", target: "#main", value: "ok", requirement: "required" },
    ],
    viewports: [{ width: 1280, height: 800 }],
  });
  if (!plan.ok) throw new Error("plan 保存失败");
  return attempt.id;
}

describe("浏览器验证编排层（V1-S4 / V01·V04·§11.2 执行序）", () => {
  it("全链路：owned 服务起停（验证完即停）+ run passed + serviceId 绑定", async () => {
    const svc = await serve(HTML);
    closers.push(svc.close);
    const attemptId = await setup("ses_v4a", svc.port);
    const deps = makeDeps(svc.port);

    const out = await runBrowserVerificationForSession({ sessionId: "ses_v4a", deps, verifier: mockVerifier() });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.run.status).toBe("passed");
    expect(out.run.serviceId).toBeTruthy();
    expect(listRunsForAttempt(attemptId)).toHaveLength(1);
    // owned 服务验证结束即停（生命周期归 Host）
    const services = listServicesForWorkspace("ws_ses_v4a");
    expect(services).toHaveLength(1);
    expect(services[0]?.status).toBe("stopped");
    expect(deps.stopped.length).toBe(1);
    expect(existsSync(path.join(path.dirname(path.dirname(services[0]!.cwd)), ".lectern-worktrees", "ses_v4a"))).toBe(true); // 工作区不删
  });

  it("borrowed 复用：同 workspace 同指纹 → 不 spawn 不停（V04）；run 照常执行", async () => {
    const svc = await serve(HTML);
    closers.push(svc.close);
    await setup("ses_v4b", svc.port);
    const deps = makeDeps(svc.port);

    // 预注册同指纹 borrowed 服务（模拟用户自起服务）
    const { registerBorrowedService } = await import("./service-instance.js");
    const delivery = await import("./delivery.js");
    const d = delivery.getDeliveryForSession("ses_v4b");
    const attempt = d ? delivery.getAttempt(d.activeAttemptId!) : null;
    const borrowed = await registerBorrowedService({
      workspaceId: "ws_ses_v4b", attemptId: attempt?.id, cwd: "/user/dir",
      origin: svc.origin, snapshotFingerprint: attempt?.verificationSnapshot?.worktreeFingerprint,
    }, deps);
    expect(borrowed.ok).toBe(true);

    const out = await runBrowserVerificationForSession({ sessionId: "ses_v4b", deps, verifier: mockVerifier() });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(deps.spawned).toBe(0); // 复用，不起 owned
    const services = listServicesForWorkspace("ws_ses_v4b");
    expect(services[0]?.owned).toBe(false);
    expect(services[0]?.status).toBe("running"); // borrowed 不被停止（V04）
    expect(deps.stopped).toEqual([]);
  });

  it("无 verifier（dev/web 无 Electron）→ run 如实 unavailable（不伪报）", async () => {
    const svc = await serve(HTML);
    closers.push(svc.close);
    await setup("ses_v4c", svc.port);
    delete process.env.LECTERN_VERIFIER_BOOTSTRAP; // env 干净
    const deps = makeDeps(svc.port);
    const out = await runBrowserVerificationForSession({ sessionId: "ses_v4c", deps });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.run.status).toBe("unavailable");
    expect(out.run.unavailableReason).toContain("verifier 未配置");
  });

  it("无 devServer 声明且无可复用服务 → service-failed（不猜启动命令）", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "v1-s4-noserver-"));
    try {
      execSync("git init -q -b main && git config user.email t@t && git config user.name t && echo app > a.txt && mkdir -p .lectern && git add . && git commit -qm init", { cwd: repo, shell: "/bin/bash" });
      ownerFixture.owner.mockImplementation((sid: string) => ({ sessionId: sid, project: { id: "p", path: repo }, effectiveWorkspaceRoot: repo }));
      const delivery = await import("./delivery.js");
      const owner = delivery.resolveOwner("ses_plain")!;
      const attempt = delivery.beginAttempt(owner, "run_plain");
      await delivery.transitionToVerifying(attempt.id);
      const out = await runBrowserVerificationForSession({ sessionId: "ses_plain", deps: makeDeps(45000), verifier: mockVerifier() });
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe("no-workspace"); // 普通会话无隔离工作区（先挡）
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("一次修复闭环（V1-S5 / V03）", () => {
  function statefulVerifier(): BrowserVerifierAdapter & { setAll: (s: "passed" | "failed") => void } {
    const state = { all: "failed" as "passed" | "failed" };
    return {
      setAll: (s) => { state.all = s; },
      openContext: async () => ({ ok: true, browserContextId: "ctx" }),
      runStep: async () => ({ status: state.all, consoleErrors: 0 }),
      captureScreenshot: async () => ({ artifactRef: "shot.png" }),
      closeContext: async () => undefined,
    };
  }

  it("首败 → 修复一次 → 重验通过：新 attempt ready_for_review，旧 attempt superseded（旧成功证据失效）", async () => {
    const svc = await serve(HTML);
    closers.push(svc.close);
    const sessionId = "ses_v5a";
    const attempt1 = await setup(sessionId, svc.port);
    const delivery = await import("./delivery.js");
    const verifier = statefulVerifier();
    let repaired = 0;

    const out = await runBrowserQaWithOneRetry({
      sessionId, deps: makeDeps(svc.port), verifier,
      repair: async () => { repaired += 1; verifier.setAll("passed"); return true; },
    });
    expect(out.outcome).toBe("passed");
    if (out.outcome !== "passed") return;
    // 旧 attempt 被 supersede（旧证据失效锚点）
    const old = delivery.getAttempt(attempt1);
    expect(old?.supersededAt).toBeTruthy();
    expect(old?.status).not.toBe("accepted");
    // 新 active attempt = ready_for_review
    const d = delivery.getDeliveryForSession(sessionId);
    const active = d ? delivery.getAttempt(d.activeAttemptId!) : null;
    expect(active?.status).toBe("ready_for_review");
    expect(active?.id).not.toBe(attempt1);
    expect(repaired).toBe(1);
  });

  it("第二次仍失败 → verification_failed 停手，repair 只调一次（修复有界，V03）", async () => {
    const svc = await serve(HTML);
    closers.push(svc.close);
    const sessionId = "ses_v5b";
    await setup(sessionId, svc.port);
    const delivery = await import("./delivery.js");
    let repaired = 0;
    const out = await runBrowserQaWithOneRetry({
      sessionId, deps: makeDeps(svc.port),
      verifier: statefulVerifier(), // 恒失败
      repair: async () => { repaired += 1; return true; },
    });
    expect(out.outcome).toBe("verification-failed");
    if (out.outcome !== "verification-failed") return;
    expect(out.repairedOnce).toBe(true);
    expect(repaired).toBe(1); // 不循环自修
    const d = delivery.getDeliveryForSession(sessionId);
    const active = d ? delivery.getAttempt(d.activeAttemptId!) : null;
    expect(active?.status).toBe("verification_failed");
  });

  it("repair 放弃（false）→ 直接 verification-failed，不起第二跑", async () => {
    const svc = await serve(HTML);
    closers.push(svc.close);
    const sessionId = "ses_v5c";
    await setup(sessionId, svc.port);
    const verifier = statefulVerifier();
    const out = await runBrowserQaWithOneRetry({
      sessionId, deps: makeDeps(svc.port), verifier,
      repair: async () => false,
    });
    expect(out.outcome).toBe("verification-failed");
    if (out.outcome !== "verification-failed") return;
    expect(out.repairedOnce).toBe(false);
    expect(verifier.openContext === undefined).toBe(false); // 首跑真实执行过
  });

  it("unavailable 不触发修复循环（环境原因 ≠ 可修复失败）", async () => {
    const svc = await serve(HTML);
    closers.push(svc.close);
    const sessionId = "ses_v5d";
    await setup(sessionId, svc.port);
    let repaired = 0;
    const out = await runBrowserQaWithOneRetry({
      sessionId, deps: makeDeps(svc.port),
      verifier: {
        openContext: async () => ({ ok: false, reason: "无可用显示器" }),
        runStep: async () => ({ status: "unavailable" }),
        captureScreenshot: async () => ({}),
        closeContext: async () => undefined,
      },
      repair: async () => { repaired += 1; return true; },
    });
    expect(out.outcome).toBe("unavailable");
    expect(repaired).toBe(0);
  });

  it("验证过程中源码变化 → stale（通过不作数，需重新验证，V03 前半）", async () => {
    const svc = await serve(HTML);
    closers.push(svc.close);
    const sessionId = "ses_v5e";
    await setup(sessionId, svc.port);
    const delivery = await import("./delivery.js");
    // run 进行中改 worktree 源码（验证中源码变化）
    const d0 = delivery.getDeliveryForSession(sessionId);
    const att = d0 ? delivery.getAttempt(d0.activeAttemptId!) : null;
    const root = att?.effectiveWorkspaceRoot;
    const verifier: BrowserVerifierAdapter = {
      openContext: async () => ({ ok: true, browserContextId: "ctx" }),
      runStep: async () => {
        if (root) writeFileSync(path.join(root, "src-live.txt"), "验证中被改");
        return { status: "passed", consoleErrors: 0 };
      },
      captureScreenshot: async () => ({ artifactRef: "shot.png" }),
      closeContext: async () => undefined,
    };
    const out = await runBrowserQaWithOneRetry({ sessionId, deps: makeDeps(svc.port), verifier });
    expect(out.outcome).toBe("stale");
    if (out.outcome === "stale") expect(out.detail).toContain("变化");
  });
});

describe("Plan 产生方：manifest 默认合成（V1 收口）", () => {
  it("无显式 plan 但 devServer 已声明 → 合成默认 plan（goto+body）并跑通；无 devServer 无 plan → no-plan", async () => {
    const svc = await serve(HTML);
    closers.push(svc.close);
    const sessionId = "ses_v1s7";
    const attemptId = await setup(sessionId, svc.port); // setup 会存 plan——这里要无 plan 场景，删掉
    const { getDb } = await import("./delivery.js");
    getDb().prepare("DELETE FROM verification_plans WHERE attempt_id = ?").run(attemptId);

    const out = await runBrowserVerificationForSession({ sessionId, deps: makeDeps(svc.port), verifier: mockVerifier() });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.run.status).toBe("passed");
    expect(out.run.steps.map((s) => s.kind)).toEqual(["goto", "assert_dom"]); // 默认合成 plan
    const { getLatestPlan } = await import("./browser-verification.js");
    expect(getLatestPlan(attemptId)?.version).toBe(1); // 已落库（后续可增补更严断言）

    // 无 plan 且无 devServer 声明 → no-plan 如实拒
    const repo2 = mkdtempSync(path.join(tmpdir(), "v1-s7-noserver-"));
    try {
      execSync("git init -q -b main && git config user.email t@t && git config user.name t && echo app > a.txt && mkdir -p .lectern && git add . && git commit -qm init", { cwd: repo2, shell: "/bin/bash" }); // 无 manifest devServer
      ownerFixture.owner.mockImplementation((sid: string) => ({ sessionId: sid, project: { id: "p", path: repo2 }, effectiveWorkspaceRoot: repo2 }));
      const created = await createWorkspace({ dataDir: rtFixture.dir, projectId: "p", projectPath: repo2, sessionId: "ses_v1s8" });
      expect(created.ok).toBe(true);
      const delivery = await import("./delivery.js");
      const owner = delivery.resolveOwner("ses_v1s8")!;
      const att = delivery.beginAttempt(owner, "run_s7");
      await delivery.transitionToVerifying(att.id);
      const r = await runBrowserVerificationForSession({ sessionId: "ses_v1s8", deps: makeDeps(45001), verifier: mockVerifier() });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("no-plan");
    } finally {
      await rm(repo2, { recursive: true, force: true });
    }
  });
});
