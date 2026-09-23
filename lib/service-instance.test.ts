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
import {
  probeOrigin, startOwnedService, registerBorrowedService, stopServiceInstance,
  findReusableService, listServicesForWorkspace, type ServiceDeps,
} from "./service-instance.js";
import { worktreeFingerprint } from "./delivery-git.js";

// 文件级共享 dataDir（SQLite 句柄模块级缓存——delivery-owner.test 同款约定）
const base = mkdtempSync(path.join(tmpdir(), "v1-s2-"));
fixtureData(base);
function fixtureData(b: string): void {
  rtFixture.dir = path.join(b, "data");
  mkdirSync(rtFixture.dir, { recursive: true });
  ownerFixture.owner.mockImplementation((sessionId: string) => ({
    sessionId, project: { id: "p", path: path.join(b, "repo") }, effectiveWorkspaceRoot: path.join(b, "repo"),
  }));
}
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

/** 真实 http fixture：返回 { server, origin, close }；html 带 title/meta 标识。 */
function serve(html: string): Promise<{ origin: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ origin: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

const APP_A = "<html><head><title>App A</title><meta name=\"lectern-app\" content=\"proj-a\"></head><body>ok</body></html>";

function deps(over: Partial<ServiceDeps> = {}): ServiceDeps & { spawned: { command: string; cwd: string; env?: Record<string, string> }[]; stopped: string[] } {
  const spawned: { command: string; cwd: string; env?: Record<string, string> }[] = [];
  const stopped: string[] = [];
  return {
    spawned, stopped,
    spawnService: async (input) => { spawned.push({ command: input.command, cwd: input.cwd, env: input.env }); return { terminalId: `tty_${spawned.length}`, pid: 4242 }; },
    stopSpawned: async (id) => { stopped.push(id); },
    portAllocator: (ws, preferred) => preferred ?? 45000 + Math.floor(Math.random() * 100),
    probe: (origin, expected) => probeOrigin(origin, expected),
    ...over,
  };
}

describe("受管服务实例（V1-S2 / V01·V04）", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("就绪检查核对应用标识：端口可连但标识不符 → 拒绝（≠ 正确项目已启动）", async () => {
    const other = await serve("<html><head><title>别的应用</title></head><body>x</body></html>");
    closers.push(other.close);
    const wrong = await probeOrigin(other.origin, "App A|proj-a");
    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toContain("identity-mismatch");
    const right = await probeOrigin(other.origin, "别的应用");
    expect(right.ok).toBe(true); // 同服务、期望正确 → 过
  });

  it("borrowed 登记（探测过才落库）；V01：两 workspace 各自服务不串台；fingerprint 不同不复用", async () => {
    const htmlA = await serve(APP_A);
    const htmlB = await serve("<html><head><title>App B</title></head><body>b</body></html>");
    closers.push(htmlA.close, htmlB.close);
    const d = deps();

    const a = await registerBorrowedService({ workspaceId: "ws_a", cwd: "/w/a", origin: htmlA.origin, expectedAppIdentity: "App A|proj-a", snapshotFingerprint: "fp-1" }, d);
    expect(a.ok).toBe(true);
    const b = await registerBorrowedService({ workspaceId: "ws_b", cwd: "/w/b", origin: htmlB.origin, snapshotFingerprint: "fp-2" }, d);
    expect(b.ok).toBe(true);

    // V01：按 workspace 查——A 的复用探测不会命中 B 的服务
    expect(listServicesForWorkspace("ws_a").map((s) => s.actualOrigin)).toEqual([htmlA.origin]);
    expect(findReusableService({ workspaceId: "ws_a", snapshotFingerprint: "fp-1" })?.actualOrigin).toBe(htmlA.origin);
    // 同 workspace 但代码版本不同（fingerprint 不符）→ 不复用（防旧版本服务冒充）
    expect(findReusableService({ workspaceId: "ws_a", snapshotFingerprint: "fp-999" })).toBeNull();

    // borrowed 服务不可停止（V04：用户服务只解除绑定，不被 Host 停掉）
    if (!a.ok) return;
    const stop = await stopServiceInstance(a.instance.id, d);
    expect(stop.ok).toBe(false);
    expect(stop.reason).toContain("borrowed");
    expect(d.stopped).toEqual([]); // 没碰任何进程
  });

  it("owned 启动：复用优先；端口注入 spawn；就绪后落库 running+origin+pid；再启动同 fingerprint 直接复用", async () => {
    const svc = await serve(APP_A);
    closers.push(svc.close);
    const port = Number(svc.origin.split(":").at(-1));
    const d = deps({ portAllocator: () => port });

    const first = await startOwnedService(
      { workspaceId: "ws_o1", attemptId: "att_1", cwd: "/w/o1", command: "npm run dev -- --port {port}", snapshotFingerprint: "fp-o1", expectedAppIdentity: "App A|proj-a" },
      d,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.instance.owned).toBe(true);
    expect(first.instance.status).toBe("running");
    expect(first.instance.actualOrigin).toBe(svc.origin);
    expect(first.instance.processIdentity?.pid).toBe(4242);
    expect(d.spawned[0]?.env?.PORT).toBe(String(port)); // Host 分配端口注入（不手工约定 3000）
    expect(d.spawned[0]?.command).toContain(String(port));

    // 同 workspace 同 fingerprint 再启动 → 复用，不再 spawn
    const second = await startOwnedService(
      { workspaceId: "ws_o1", cwd: "/w/o1", command: "npm run dev", snapshotFingerprint: "fp-o1", expectedAppIdentity: "App A|proj-a" },
      d,
    );
    expect(second.ok && second.instance.id).toBe(first.instance.id);
    expect(d.spawned.length).toBe(1);
  });

  it("owned 就绪失败：如实 unhealthy + 记录保留可修复（不伪报 running）", async () => {
    const d = deps({ portAllocator: () => 45999, probe: async () => ({ ok: false, reason: "connect ECONNREFUSED" }) });
    const r = await startOwnedService(
      { workspaceId: "ws_o2", cwd: "/w/o2", command: "npm run dev", readyTimeoutMs: 10 },
      d,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.instance.status).toBe("unhealthy");
    expect(r.instance.actualOrigin).toBeUndefined();
    // unhealthy 不可被复用
    expect(findReusableService({ workspaceId: "ws_o2" })).toBeNull();
  });

  it("owned 停止：受管通道停止 + status=stopped；borrowed 拒停（V04）", async () => {
    const svc = await serve(APP_A);
    closers.push(svc.close);
    const port = Number(svc.origin.split(":").at(-1));
    const d = deps({ portAllocator: () => port });
    const r = await startOwnedService(
      { workspaceId: "ws_o3", cwd: "/w/o3", command: "npm run dev", expectedAppIdentity: "App A|proj-a" },
      d,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const stop = await stopServiceInstance(r.instance.id, d);
    expect(stop.ok).toBe(true);
    expect(d.stopped).toEqual([r.instance.terminalId]);
    expect(listServicesForWorkspace("ws_o3")[0]?.status).toBe("stopped");
    // stopped 不再复用
    expect(findReusableService({ workspaceId: "ws_o3" })).toBeNull();
  });
});

describe("cacheDirs 排除进 fingerprint（V1-S2 / §11.2 末段）", () => {
  it("缓存目录写入不改变指纹；源码变化仍被捕获（排除不能掩盖源码变化）", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "v1-s2-git-"));
    try {
      execSync("git init -q -b main && git config user.email t@t && git config user.name t && echo app > src.txt && mkdir -p .lectern && git add . && git commit -qm init", { cwd: repo, shell: "/bin/bash" });
      const base = await worktreeFingerprint(repo, [".next"]);

      // 开发服务器写缓存目录（.next/**）→ 指纹不变（排除生效）
      mkdirSync(path.join(repo, ".next", "cache"), { recursive: true });
      writeFileSync(path.join(repo, ".next", "cache", "chunk.js"), "build output");
      writeFileSync(path.join(repo, ".next", "dirty.txt"), "more");
      expect(await worktreeFingerprint(repo, [".next"])).toBe(base);

      // 未声明排除的项目（exclude 未传）→ 缓存写入会变指纹（旧算法逐字节不变）
      expect(await worktreeFingerprint(repo)).not.toBe(base);

      // 源码变化 → 指纹必变（排除不能掩盖应用源码变化）
      writeFileSync(path.join(repo, "src.txt"), "app changed");
      expect(await worktreeFingerprint(repo, [".next"])).not.toBe(base);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("快照链集成：verify 时冻结 cacheExcludes；服务写缓存不 stale、改源码 stale", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "v1-s2-del-"));
    try {
      rtFixture.dir = path.join(base, "data2");
      ownerFixture.owner.mockImplementation((sessionId: string) => ({
        sessionId, project: { id: "p", path: repo }, effectiveWorkspaceRoot: repo,
      }));
      execSync("git init -q -b main && git config user.email t@t && git config user.name t && echo app > src.txt && mkdir -p .lectern && git add . && git commit -qm init", { cwd: repo, shell: "/bin/bash" });
      // manifest 预先声明缓存目录（spec：预先声明，不是事后忽略）
      writeFileSync(path.join(repo, ".lectern", "workspace.json"), JSON.stringify({ devServer: { command: "npm run dev", port: 4300, cacheDirs: [".next"] } }));

      const delivery = await import("./delivery.js");
      const owner = delivery.resolveOwner("ses_v1s2")!;
      const attempt = delivery.beginAttempt(owner, "run_s2");
      const verifying = await delivery.transitionToVerifying(attempt.id);
      expect(verifying.verificationSnapshot?.cacheExcludes).toEqual([".next"]); // 冻结进快照

      // 服务跑起来写缓存目录 → 快照仍有效
      mkdirSync(path.join(repo, ".next"), { recursive: true });
      writeFileSync(path.join(repo, ".next", "build.js"), "compiled");
      expect(await delivery.isSnapshotStillValid(verifying)).toBe(true);

      // 改源码 → stale
      writeFileSync(path.join(repo, "src.txt"), "changed");
      expect(await delivery.isSnapshotStillValid(verifying)).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
      fixtureData(base); // 还原共享 fixture
    }
  });
});
