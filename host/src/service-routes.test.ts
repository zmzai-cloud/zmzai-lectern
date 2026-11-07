import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** P0 2026-11-07（route-ownership-matrix）：直通服务族的生产装配验证。
 *
 *  真实 buildRealRuntimeFace + startHostServer + 两个项目各自 SQLite 库（不替换
 *  resolver/服务）：fs/git/会话改删/读面/预览/skills/plugins/全局搜索经 Host 端点
 *  按会话持久归属（或网关固定的 projectId）落到正确项目；未知会话/项目给结构化
 *  错误，不回落活动项目。事件流按会话归属取事件日志，live 扇出即时推送。 */

vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
const TOKEN = "p0-service-token";

type Framework = typeof import("@zmzai/agent-framework");
type Booted = {
  dir: string;
  projA: string;
  projB: string;
  base: string;
  sessionA: string;
  sessionB: string;
  framework: Framework;
  close(): Promise<void>;
};

let b: Booted;

async function boot(): Promise<Booted> {
  const dir = await mkdtemp(path.join(tmpdir(), "p0-svc-"));
  const dataDir = path.join(dir, "data");
  const projA = path.join(dir, "projA");
  const projB = path.join(dir, "projB");
  const defaultWs = path.join(dir, "ws-default");
  for (const d of [dataDir, projA, projB, defaultWs]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(dataDir, "projects.json"), JSON.stringify({
    activeId: "default",
    projects: [
      { id: "p_a", name: "A", path: projA, createdAt: new Date().toISOString() },
      { id: "p_b", name: "B", path: projB, createdAt: new Date().toISOString() },
    ],
  }));
  writeFileSync(path.join(projA, "owner.txt"), "project-A\n");
  writeFileSync(path.join(projB, "owner.txt"), "project-B\n");
  writeFileSync(path.join(projA, "page.png"), PNG);
  writeFileSync(path.join(projA, "calc.mjs"), "export function addTotals(a, b) { return a + b; }\n");
  mkdirSync(path.join(projA, ".zmzai", "skills", "alpha"), { recursive: true });
  writeFileSync(path.join(projA, ".zmzai", "skills", "alpha", "SKILL.md"), "---\nname: alpha-skill\ndescription: A 专属\n---\n正文");
  // 项目 B 是 git 仓库（检查点/回滚/diff 全流程）；仓库级身份，不依赖全局 git 配置
  const git = (...args: string[]) => execFileSync("git", args, { cwd: projB, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "p0@test.invalid");
  git("config", "user.name", "p0");
  git("add", "-A");
  git("commit", "-qm", "init");

  // env 先行（runtime-constants 模块加载期求值）→ resetModules → 动态 import
  process.env.LECTERN_DATA_DIR = dataDir;
  process.env.LECTERN_WORKSPACE = defaultWs;
  vi.resetModules();
  const globals = globalThis as Record<string, unknown>;
  for (const key of ["__lecternRuntimes", "__lecternProjectStores", "__lecternMcp", "__lecternTerminalManager", "__lecternLeaseTargets", "__lecternSubagentAdmission", "__lecternLeaseTimer"]) {
    delete globals[key];
  }
  const { buildRealRuntimeFace } = await import("./real-runtime.js");
  const { startHostServer } = await import("./server.js");
  const framework: Framework = await import("@zmzai/agent-framework");

  const storeA = framework.createSqliteSessionStore({ dataDir: path.join(dataDir, "projects", "p_a") });
  const storeB = framework.createSqliteSessionStore({ dataDir: path.join(dataDir, "projects", "p_b") });
  const mk = async (store: unknown) =>
    (await framework.createFrameworkSession({ store: store as never, userId: "local", workspaceId: "local", model: { providerId: "openai", modelId: "m" }, prompt: "s" })).id;
  const sessionA = await mk(storeA);
  const sessionB = await mk(storeB);
  // 可搜索的种子消息（会话 A）
  await storeA.appendMessage({ id: "msg_seed_a", sessionId: sessionA, role: "user", agent: "default", model: { providerId: "faux", modelId: "m" }, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, time: { created: new Date().toISOString() } } as never);
  await storeA.appendPart({ id: "part_seed_a", sessionId: sessionA, messageId: "msg_seed_a", type: "text", text: "alpha 种子文本" } as never);

  // runtime 占位：/v1/events 位于 fixture 分支内；提供 sessionEvents 时不触碰它
  const host = await startHostServer({ dataDir, token: TOKEN, runtime: {} as never, realRuntime: buildRealRuntimeFace({ credentialFor: () => null }) });
  return {
    dir, projA, projB, base: `http://127.0.0.1:${host.port}`, sessionA, sessionB, framework,
    close: async () => {
      await host.close();
      delete process.env.LECTERN_DATA_DIR;
      delete process.env.LECTERN_WORKSPACE;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const auth = { authorization: `Bearer ${TOKEN}` };
const get = (p: string) => fetch(`${b.base}${p}`, { headers: auth });
const send = (method: string, p: string, body?: unknown) =>
  fetch(`${b.base}${p}`, { method, headers: { ...auth, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeAll(async () => { b = await boot(); }, 60_000);
afterAll(async () => { await b?.close(); });

describe("P0 Host 直通服务族：按会话持久归属落到正确项目", () => {
  it("无 token → 401 且零副作用（写文件未落盘）", async () => {
    const res = await fetch(`${b.base}/v1/fs/file`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "leak.txt", content: "x", sessionId: b.sessionA }) });
    expect(res.status).toBe(401);
    expect(existsSync(path.join(b.projA, "leak.txt"))).toBe(false);
  });

  it("fs/file：两个会话读到各自项目的文件；写入只落归属项目；未知会话 404 结构化", async () => {
    const a = await (await get(`/v1/fs/file?path=owner.txt&sessionId=${b.sessionA}`)).json();
    const bb = await (await get(`/v1/fs/file?path=owner.txt&sessionId=${b.sessionB}`)).json();
    expect(a).toMatchObject({ content: "project-A\n", binary: false });
    expect(bb).toMatchObject({ content: "project-B\n", binary: false });

    const put = await send("PUT", "/v1/fs/file", { path: "notes/new.md", content: "# A\n", sessionId: b.sessionA });
    expect(put.status).toBe(200);
    expect(readFileSync(path.join(b.projA, "notes", "new.md"), "utf8")).toBe("# A\n");
    expect(existsSync(path.join(b.projB, "notes", "new.md"))).toBe(false);

    const missing = await get(`/v1/fs/file?path=owner.txt&sessionId=ses_unknown_owner`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ detail: { code: "NOT_FOUND" } });

    const escape = await get(`/v1/fs/file?path=${encodeURIComponent("../projB/owner.txt")}&sessionId=${b.sessionA}`);
    expect(escape.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await escape.json())).not.toContain("project-B");
  });

  it("fs/tree 与 fs/search：根目录随会话归属", async () => {
    const tree = await (await get(`/v1/fs/tree?path=&sessionId=${b.sessionB}`)).json() as { nodes: { name: string }[] };
    expect(tree.nodes.map((n) => n.name)).toContain("owner.txt");
    expect(tree.nodes.map((n) => n.name)).not.toContain("page.png");
    const hits = await (await get(`/v1/fs/search?q=page&sessionId=${b.sessionA}`)).json() as { results: { path: string }[] };
    expect(hits.results.map((r) => r.path)).toEqual(["page.png"]);
  });

  it("git：非仓库 diff available:false；仓库内 快照 → 列表 → 回滚 全流程在归属项目执行", async () => {
    expect(await (await get(`/v1/git/diff?sessionId=${b.sessionA}`)).json()).toMatchObject({ available: false });

    writeFileSync(path.join(b.projB, "draft.txt"), "draft\n");
    const snap = await (await send("POST", "/v1/git/checkpoint", { label: "P0 快照", sessionId: b.sessionB })).json() as { ok: boolean; hash: string };
    expect(snap.ok).toBe(true);
    const points = await (await get(`/v1/git/checkpoint?sessionId=${b.sessionB}`)).json() as { points: { hash: string; checkpoint: boolean; subject: string }[] };
    expect(points.points[0]).toMatchObject({ checkpoint: true });
    expect(points.points[0]!.subject).toContain("P0 快照");
    const init = points.points.find((p) => !p.checkpoint)!;

    const rollback = await send("PUT", "/v1/git/checkpoint", { hash: init.hash, sessionId: b.sessionB });
    expect(rollback.status).toBe(200);
    expect(existsSync(path.join(b.projB, "draft.txt"))).toBe(false);
    expect(readFileSync(path.join(b.projB, "owner.txt"), "utf8")).toBe("project-B\n");

    const bad = await send("PUT", "/v1/git/checkpoint", { hash: "not-a-hash", sessionId: b.sessionB });
    expect(bad.status).toBe(400);
  });

  it("会话读面与 UI 同契约：messages 窗口快照 / search 游标形状 / usage / read-state", async () => {
    const win = await (await get(`/v1/sessions/${b.sessionA}/messages?view=window&limit=50`)).json() as Record<string, unknown>;
    expect(win).toMatchObject({ sessionId: b.sessionA, projectId: "p_a" });
    expect(Array.isArray(win.messages)).toBe(true);
    expect(win).toHaveProperty("historyRevision");
    expect(win).toHaveProperty("task");

    const search = await (await get(`/v1/sessions/${b.sessionA}/search?q=${encodeURIComponent("种子")}`)).json() as { results: { projectId: string }[]; nextCursor: unknown };
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results.every((r) => r.projectId === "p_a")).toBe(true);
    expect(search).toHaveProperty("nextCursor");

    const usage = await (await get(`/v1/sessions/${b.sessionA}/usage`)).json();
    expect(usage).toMatchObject({ used: 0, steps: 0 });
    expect(typeof (usage as { contextWindow: number }).contextWindow).toBe("number");

    const read = await get(`/v1/sessions/${b.sessionA}/read-state`);
    expect(read.status).toBe(200);
    const badPut = await send("PUT", `/v1/sessions/${b.sessionA}/read-state`, { lastReadMessageSeq: -1, historyRevision: 1 });
    expect(badPut.status).toBe(422);

    const gone = await get(`/v1/sessions/ses_none_here/messages?view=window`);
    expect(gone.status).toBe(404);
  });

  it("预览：字节流原样到达，内容类型与安全头保留；会话归属决定根目录", async () => {
    const res = await get(`/v1/preview/${b.sessionA}/page.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await get(`/v1/preview/${b.sessionB}/page.png`)).status).toBe(404);
  });

  it("skills 按会话根目录；plugins 按固定 projectId，未知项目 404 不回落", async () => {
    const skillsA = await (await get(`/v1/skills?sessionId=${b.sessionA}`)).json() as { skills: { name: string; source: string }[] };
    const skillsB = await (await get(`/v1/skills?sessionId=${b.sessionB}`)).json() as { skills: { name: string; source: string }[] };
    expect(skillsA.skills.filter((s) => s.source === "workspace").map((s) => s.name)).toEqual(["alpha-skill"]);
    expect(skillsB.skills.filter((s) => s.source === "workspace")).toEqual([]);

    const plugins = await get(`/v1/plugins?projectId=p_b`);
    expect(plugins.status).toBe(200);
    expect(await plugins.json()).toHaveProperty("plugins");
    expect((await get(`/v1/plugins?projectId=p_missing`)).status).toBe(404);
  });

  it("repomap：Host 内用核对过的 wasm 目录出图，且进程存活（错误目录曾让 emscripten 结束 Host）", async () => {
    const res = await get(`/v1/repomap?projectId=p_a`);
    const body = await res.json() as { ok: boolean; text?: string; error?: string };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.text).toContain("addTotals");
    expect((await get("/health")).status).toBe(200);
  });

  it("全局搜索跨项目带归属；交付概览按会话推导 owner", async () => {
    const found = await (await get(`/v1/session-search?q=${encodeURIComponent("种子")}`)).json() as { results: { sessionId: string; projectId: string }[] };
    expect(found.results).toContainEqual(expect.objectContaining({ sessionId: b.sessionA, projectId: "p_a" }));
    const overview = await get(`/v1/delivery-overview?sessionId=${b.sessionA}`);
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({ delivery: null, attempt: null, runs: [] });
  });

  it("事件流：归属错误结构化（未知会话 404 / 水位失效 409）；live 扇出即时推送（不等 1s 轮询）", async () => {
    expect((await get(`/v1/events?sessionId=ses_none_here`)).status).toBe(404);
    expect((await get(`/v1/events?sessionId=${b.sessionA}&since=99999`)).status).toBe(409);

    const { sessionRuntime } = await import("../../lib/runtime.js");
    const rt = sessionRuntime(b.sessionA);
    const baseline = await rt.eventLog.count(b.sessionA);
    const controller = new AbortController();
    try {
    // 空闲会话也必须立即拿到响应头（Host flushHeaders；否则要等 15s 心跳）
    const connectStarted = Date.now();
    const res = await fetch(`${b.base}/v1/events?sessionId=${b.sessionA}&since=${baseline}`, { headers: auth, signal: controller.signal });
    expect(Date.now() - connectStarted).toBeLessThan(2_000);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    // 订阅建立后再发事件：等 SSE 头已到即可（订阅循环的首轮 read 已执行）
    await new Promise((r) => setTimeout(r, 150));
    const started = Date.now();
    const persisted = await rt.eventLog.append({ sessionId: b.sessionA, type: "session.status", data: { status: "running" } } as never);
    b.framework.notifyEventLogListeners(persisted);
    let text = "";
    while (!text.includes(`id: ${persisted.seq}`)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    const latency = Date.now() - started;
    expect(text).toContain(`id: ${persisted.seq}`);
    expect(text).toContain("\"session.status\"");
    // live 扇出在 Host 进程内触发；轮询兜底是 1s——远低于该值即证明走的是实时推送
    expect(latency).toBeLessThan(600);
    } finally {
      controller.abort();
    }
  });

  it("会话改删：PATCH 改标题落归属库；DELETE 后读面 404；非法 id 400", async () => {
    expect((await send("PATCH", `/v1/sessions/${b.sessionA}`, { title: "  P0 改名  " })).status).toBe(200);
    const { projectStore } = await import("../../lib/projects.js");
    expect((await projectStore("p_a").getSession(b.sessionA))?.title).toBe("P0 改名");
    expect((await send("PATCH", `/v1/sessions/${b.sessionA}`, {})).status).toBe(400);
    expect((await send("PATCH", `/v1/sessions/${b.sessionA}`, { permissionMode: "bogus" })).status).toBe(400);

    expect((await send("DELETE", `/v1/sessions/${b.sessionB}`)).status).toBe(200);
    expect((await get(`/v1/sessions/${b.sessionB}/messages`)).status).toBe(404);
    expect((await send("DELETE", `/v1/sessions/${b.sessionB}`)).status).toBe(404);
    expect((await send("DELETE", `/v1/sessions/bad.id`)).status).toBe(400);
  });
});

describe("P0 Host 直通服务族：透传机制", () => {
  it("缺实现的服务面继续向下匹配，最终 404（不伪造空成功）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "p0-svc-bare-"));
    const { startHostServer } = await import("./server.js");
    const host = await startHostServer({ dataDir: dir, token: TOKEN, realRuntime: { listSessions: async () => [], messages: async () => [] } });
    try {
      const res = await fetch(`http://127.0.0.1:${host.port}/v1/fs/file?path=x`, { headers: auth });
      expect(res.status).toBe(404);
    } finally { await host.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("事件流透传：帧逐个到达（不缓冲到结束）；客户端断开 → 服务侧订阅信号中止", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "p0-svc-sse-"));
    const { startHostServer } = await import("./server.js");
    let serviceSignal: AbortSignal | undefined;
    const encoder = new TextEncoder();
    const host = await startHostServer({
      dataDir: dir, token: TOKEN, runtime: {} as never,
      realRuntime: {
        listSessions: async () => [], messages: async () => [],
        sessionEvents: async (request) => {
          serviceSignal = request.signal;
          let n = 0;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const timer = setInterval(() => {
                n += 1;
                try { controller.enqueue(encoder.encode(`id: ${n}\ndata: {"n":${n}}\n\n`)); } catch { clearInterval(timer); }
              }, 50);
              request.signal.addEventListener("abort", () => { clearInterval(timer); try { controller.close(); } catch { /* 已关 */ } });
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        },
      },
    });
    try {
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${host.port}/v1/events?sessionId=ses_x`, { headers: auth, signal: controller.signal });
      const reader = res.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain("id: 1");
      controller.abort();
      await new Promise((r) => setTimeout(r, 200));
      expect(serviceSignal?.aborted).toBe(true);
    } finally { await host.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
