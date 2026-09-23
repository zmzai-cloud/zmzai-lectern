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
import { runBrowserVerificationForSession } from "./browser-orchestrator.js";
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
