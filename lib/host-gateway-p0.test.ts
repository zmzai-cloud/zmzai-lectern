import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** P0 2026-11-07（route-ownership-matrix）：剩余执行/读写面网关映射。
 *  armed 下每条路由的方法、Host 路径、query、body、凭据头逐条核对；项目级路由在
 *  入口固定活动项目（客户端带别的 projectId 也被覆盖）；不可达 503 不回落；
 *  字节流（预览）与头原样透传；legacy（未 armed）一律 null。 */

type Recorded = { method: string; url: string; body: string; credential: string | undefined };
type FakeHost = { server: Server; port: number; requests: Recorded[] };

async function startFakeHost(reply?: (req: Recorded, res: import("node:http").ServerResponse) => void): Promise<FakeHost> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry: Recorded = { method: req.method ?? "", url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8"), credential: req.headers["x-lectern-credential"] as string | undefined };
      requests.push(entry);
      if (reply) { reply(entry, res); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port, requests };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  delete process.env.LECTERN_HOST_GATEWAY;
  delete process.env.LECTERN_DATA_DIR;
  while (cleanups.length) await cleanups.pop()!();
});

/** 带活动项目的数据目录 + armed 网关（模块级 armed 快照：设 env 后 resetModules 再 import）。 */
async function armed(host: FakeHost | { port: number }) {
  const dir = await mkdtemp(path.join(tmpdir(), "p0-gw-"));
  mkdirSync(path.join(dir, "data"), { recursive: true });
  mkdirSync(path.join(dir, "pa"), { recursive: true });
  writeFileSync(path.join(dir, "data", "projects.json"), JSON.stringify({ activeId: "p_active", projects: [{ id: "p_active", name: "A", path: path.join(dir, "pa"), createdAt: new Date().toISOString() }] }));
  const hostJson = path.join(dir, "host.json");
  await writeFile(hostJson, JSON.stringify({ port: host.port, token: "t0k", hostInstanceId: "h1" }));
  process.env.LECTERN_DATA_DIR = path.join(dir, "data");
  process.env.LECTERN_HOST_GATEWAY = hostJson;
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  vi.resetModules();
  return import("./host-gateway.js");
}

function req(method: string, pathAndQuery: string, body?: unknown, cookie?: string): Request {
  return new Request(`http://127.0.0.1${pathAndQuery}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("P0 网关：剩余路由映射到 Host（方法/路径/query/body 原样）", () => {
  const cases: { name: string; method: string; path: string; body?: unknown; host: { method: string; url: string; body?: unknown } }[] = [
    { name: "会话改名", method: "PATCH", path: "/api/sessions/ses_1", body: { title: "新名" }, host: { method: "PATCH", url: "/v1/sessions/ses_1", body: { title: "新名" } } },
    { name: "会话删除", method: "DELETE", path: "/api/sessions/ses_1", host: { method: "DELETE", url: "/v1/sessions/ses_1" } },
    { name: "fs 读", method: "GET", path: "/api/fs/file?path=a.md&sessionId=ses_1", host: { method: "GET", url: "/v1/fs/file?path=a.md&sessionId=ses_1" } },
    { name: "fs 写", method: "PUT", path: "/api/fs/file", body: { path: "a.md", content: "x", sessionId: "ses_1" }, host: { method: "PUT", url: "/v1/fs/file", body: { path: "a.md", content: "x", sessionId: "ses_1" } } },
    { name: "fs 搜索", method: "GET", path: "/api/fs/search?q=main&sessionId=ses_1", host: { method: "GET", url: "/v1/fs/search?q=main&sessionId=ses_1" } },
    { name: "fs 目录", method: "GET", path: "/api/fs/tree?path=src&sessionId=ses_1", host: { method: "GET", url: "/v1/fs/tree?path=src&sessionId=ses_1" } },
    { name: "检查点列表", method: "GET", path: "/api/git/checkpoint?sessionId=ses_1", host: { method: "GET", url: "/v1/git/checkpoint?sessionId=ses_1" } },
    { name: "打快照", method: "POST", path: "/api/git/checkpoint", body: { label: "x", sessionId: "ses_1" }, host: { method: "POST", url: "/v1/git/checkpoint", body: { label: "x", sessionId: "ses_1" } } },
    { name: "回滚", method: "PUT", path: "/api/git/checkpoint", body: { hash: "abcd1234", sessionId: "ses_1" }, host: { method: "PUT", url: "/v1/git/checkpoint", body: { hash: "abcd1234", sessionId: "ses_1" } } },
    { name: "diff", method: "GET", path: "/api/git/diff?sessionId=ses_1&path=a.ts", host: { method: "GET", url: "/v1/git/diff?sessionId=ses_1&path=a.ts" } },
    { name: "交付概览", method: "GET", path: "/api/deliveries?sessionId=ses_1", host: { method: "GET", url: "/v1/delivery-overview?sessionId=ses_1" } },
    { name: "交付动作", method: "POST", path: "/api/deliveries/attempt", body: { sessionId: "ses_1", action: "begin" }, host: { method: "POST", url: "/v1/delivery-attempt", body: { sessionId: "ses_1", action: "begin" } } },
    { name: "截图证据", method: "GET", path: "/api/deliveries/browser-screenshot?ref=browser-screenshots%2Fa.png", host: { method: "GET", url: "/v1/browser-screenshot?ref=browser-screenshots%2Fa.png" } },
    { name: "预览（编码路径原样）", method: "GET", path: "/api/preview/ses_1/dist/a%20b.html", host: { method: "GET", url: "/v1/preview/ses_1/dist/a%20b.html" } },
    { name: "skills", method: "GET", path: "/api/skills?sessionId=ses_1&id=workspace%3Ax", host: { method: "GET", url: "/v1/skills?sessionId=ses_1&id=workspace%3Ax" } },
    { name: "消息窗口", method: "GET", path: "/api/sessions/ses_1/messages?view=window&limit=50", host: { method: "GET", url: "/v1/sessions/ses_1/messages?view=window&limit=50" } },
    { name: "会话内搜索", method: "GET", path: "/api/sessions/ses_1/search?q=x&cursor=c1", host: { method: "GET", url: "/v1/sessions/ses_1/search?q=x&cursor=c1" } },
    { name: "用量", method: "GET", path: "/api/sessions/ses_1/usage", host: { method: "GET", url: "/v1/sessions/ses_1/usage" } },
    { name: "已读读", method: "GET", path: "/api/sessions/ses_1/read-state", host: { method: "GET", url: "/v1/sessions/ses_1/read-state" } },
    { name: "已读写（UI 的 PUT 形状）", method: "PUT", path: "/api/sessions/ses_1/read-state", body: { lastReadMessageSeq: 3, historyRevision: 1 }, host: { method: "PUT", url: "/v1/sessions/ses_1/read-state", body: { lastReadMessageSeq: 3, historyRevision: 1 } } },
    { name: "全局搜索", method: "GET", path: "/api/sessions/search?q=x", host: { method: "GET", url: "/v1/session-search?q=x" } },
    { name: "优雅收尾", method: "POST", path: "/api/shutdown/graceful", host: { method: "POST", url: "/v1/graceful-shutdown" } },
  ];

  it.each(cases)("$name", async (c) => {
    const host = await startFakeHost();
    cleanups.push(() => { host.server.close(); });
    const gw = await armed(host);
    const res = await gw.hostGateway(req(c.method, c.path, c.body));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(host.requests).toHaveLength(1);
    const hit = host.requests[0]!;
    expect(hit.method).toBe(c.host.method);
    expect(hit.url).toBe(c.host.url);
    if (c.host.body !== undefined) expect(JSON.parse(hit.body)).toEqual(c.host.body);
    else expect(hit.body).toBe("");
  });

  it("rewind 补缺：路径 sessionId 并入 body，且带凭据通道（回溯会重发 prompt）", async () => {
    const host = await startFakeHost();
    cleanups.push(() => { host.server.close(); });
    const gw = await armed(host);
    const res = await gw.hostGateway(req("POST", "/api/sessions/ses_r/rewind", { messageId: "msg_1", text: "改写" }, "other=1; muzhi_session=abc%3D; x=2"));
    expect(res!.status).toBe(200);
    const hit = host.requests[0]!;
    expect(hit.url).toBe("/v1/commands/rewind");
    expect(JSON.parse(hit.body)).toEqual({ messageId: "msg_1", text: "改写", sessionId: "ses_r" });
    expect(hit.credential).toBe("muzhi_session=abc=");
  });

  it("plugins/repomap：入口固定活动项目；客户端自带的 projectId 被覆盖", async () => {
    const host = await startFakeHost();
    cleanups.push(() => { host.server.close(); });
    const gw = await armed(host);
    await gw.hostGateway(req("GET", "/api/plugins"));
    await gw.hostGateway(req("POST", "/api/plugins", { sourcePath: "/tmp/p" }));
    await gw.hostGateway(req("GET", "/api/repomap?focus=src&projectId=p_evil"));
    expect(host.requests.map((r) => r.url)).toEqual([
      "/v1/plugins?projectId=p_active",
      "/v1/plugins?projectId=p_active",
      "/v1/repomap?focus=src&projectId=p_active",
    ]);
    expect(JSON.parse(host.requests[1]!.body)).toEqual({ sourcePath: "/tmp/p" });
  });

  it("预览字节流与头原样透传（含 access-control-allow-origin）", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const host = await startFakeHost((_r, res) => {
      res.writeHead(200, { "content-type": "image/png", "x-content-type-options": "nosniff", "access-control-allow-origin": "*", "cache-control": "no-store" });
      res.end(png);
    });
    cleanups.push(() => { host.server.close(); });
    const gw = await armed(host);
    const res = await gw.hostGateway(req("GET", "/api/preview/ses_1/page.png"));
    expect(res!.headers.get("content-type")).toBe("image/png");
    expect(res!.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res!.headers.get("access-control-allow-origin")).toBe("*");
    expect(Buffer.from(await res!.arrayBuffer()).equals(png)).toBe(true);
  });

  it("Host 不可达：新路由一律 503 HOST_UNAVAILABLE（不回落进程内）；非会话路由不伪造 sessionId", async () => {
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const port = (dead.address() as { port: number }).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const gw = await armed({ port });
    for (const [method, p, body] of [["PUT", "/api/fs/file", { path: "a", content: "b" }], ["DELETE", "/api/sessions/ses_d"], ["POST", "/api/shutdown/graceful"], ["GET", "/api/git/diff"]] as const) {
      const res = await gw.hostGateway(req(method, p, body));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(503);
      const detail = ((await res!.json()) as { detail: { code: string; sessionId?: string } }).detail;
      expect(detail.code).toBe("HOST_UNAVAILABLE");
      if (p === "/api/sessions/ses_d") expect(detail.sessionId).toBe("ses_d");
      else expect(detail.sessionId).toBeUndefined();
    }
  });

  it("legacy（启动未 armed）：新路由一律 null，由进程内同一服务执行", async () => {
    delete process.env.LECTERN_HOST_GATEWAY;
    vi.resetModules();
    const gw = await import("./host-gateway.js");
    for (const [method, p] of [["PATCH", "/api/sessions/ses_1"], ["GET", "/api/fs/file"], ["GET", "/api/plugins"], ["GET", "/api/sessions/ses_1/events"]] as const) {
      expect(await gw.hostGateway(req(method, p))).toBeNull();
    }
  });
});
