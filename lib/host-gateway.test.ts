import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/** T07 / F04 / PC10-11（production-chain-closure）：armed 网关绝不静默回落。
 *
 *  缺陷（F04）：hostGateway 的 fetch 异常 `.catch(() => null)` → 路由 handler
 *  回落进程内执行——「Host 已接受命令、响应丢失」窗口里会出现第二执行者。
 *  修复后：armed（启动快照锁定）+ 路由命中 + 不可达 → 结构化 503
 *  HOST_UNAVAILABLE（带 requestId/结果未知语义），客户端同键重试或查回执。
 *
 *  模块级 armedAtStartup 快照：每用例设 env 后 vi.resetModules + 动态 import。 */

type HostHandle = { server: Server; port: number; requests: { method: string; url: string; body: unknown; authorization: string }[] };

async function startFakeHost(handler?: (req: { method: string; url: string; body: unknown }, res: { setHeader(k: string, v: string): void; end(body?: string): void; destroy(): void }, ctx: { requests: { method: string; url: string; body: unknown; authorization: string }[] }) => void): Promise<HostHandle> {
  const requests: HostHandle["requests"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const entry = { method: req.method ?? "", url: req.url ?? "", body, authorization: String(req.headers.authorization ?? "") };
      requests.push(entry);
      if (handler) handler({ method: entry.method, url: entry.url, body: entry.body }, res, { requests });
      else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, via: "host" })); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port, requests };
}

type Gateway = typeof import("./host-gateway.js");

async function importGateway(): Promise<Gateway> {
  vi.resetModules();
  return import("./host-gateway.js");
}

async function withHostJson(dir: string, port: number, token = "t0k"): Promise<string> {
  const file = path.join(dir, "host.json");
  await writeFile(file, JSON.stringify({ port, token, hostInstanceId: "h1" }));
  return file;
}

function postPrompt(sessionId: string, body: Record<string, unknown>): Request {
  return new Request(`http://127.0.0.1/api/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("T07：armed 网关禁动态回退（F04/PC10/PC11）", () => {
  it("未 armed（legacy）：一律 null——模式是启动快照，不是请求期回退", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t07-legacy-"));
    try {
      delete process.env.LECTERN_HOST_GATEWAY;
      const gw = await importGateway();
      expect(await gw.hostGateway(postPrompt("s1", { text: "hi" }))).toBeNull();
      // armed 后同进程也不生效：快照已锁（运行中不切模式）
      process.env.LECTERN_HOST_GATEWAY = path.join(dir, "missing.json");
      expect(await gw.hostGateway(postPrompt("s1", { text: "hi" }))).toBeNull();
    } finally {
      delete process.env.LECTERN_HOST_GATEWAY;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("armed + 路由未命中 → null（静态非执行路径的合法回落）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t07-unmatched-"));
    try {
      const host = await startFakeHost();
      try {
        process.env.LECTERN_HOST_GATEWAY = await withHostJson(dir, host.port);
        const gw = await importGateway();
        const req = new Request("http://127.0.0.1/api/models", { method: "GET" });
        expect(await gw.hostGateway(req)).toBeNull();
      } finally {
        delete process.env.LECTERN_HOST_GATEWAY;
        host.server.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("armed + Host 不可达 → 结构化 503 HOST_UNAVAILABLE（带 requestId/结果未知语义），不返回 null", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t07-down-"));
    try {
      // 占一个已关闭的端口：先起再停
      const dead = await startFakeHost();
      const port = dead.port;
      dead.server.close();
      await new Promise((r) => setTimeout(r, 100));
      process.env.LECTERN_HOST_GATEWAY = await withHostJson(dir, port);
      const gw = await importGateway();
      const res = await gw.hostGateway(postPrompt("ses_x", { text: "hi", requestId: "req_pc10_aaaa" }));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(503);
      const body = (await res!.json()) as { error: string; detail: { code: string; retryable: boolean; requestId?: string; sessionId?: string } };
      expect(body.detail.code).toBe("HOST_UNAVAILABLE");
      expect(body.detail.retryable).toBe(true);
      expect(body.detail.requestId).toBe("req_pc10_aaaa");
      expect(body.detail.sessionId).toBe("ses_x");
      expect(body.error).toContain("结果未知");
    } finally {
      delete process.env.LECTERN_HOST_GATEWAY;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("armed + host.json 不可读 → 同样 503 结构化（不回落）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t07-nojson-"));
    try {
      process.env.LECTERN_HOST_GATEWAY = path.join(dir, "ghost.json");
      const gw = await importGateway();
      const res = await gw.hostGateway(postPrompt("ses_y", { text: "hi", requestId: "req_pc10_bbbb" }));
      expect(res!.status).toBe(503);
      const body = (await res!.json()) as { detail: { code: string; requestId?: string } };
      expect(body.detail.code).toBe("HOST_UNAVAILABLE");
      expect(body.detail.requestId).toBe("req_pc10_bbbb");
    } finally {
      delete process.env.LECTERN_HOST_GATEWAY;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("PC10 全链：Host 接受后断连（响应丢失）→ 503；同键重试 → 拿回原回执，Host 两次收到同一 requestId", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t07-pc10-"));
    let dropConnection = false;
    const receipts = new Map<string, unknown>();
    const host = await startFakeHost((req, res, ctx) => {
      if (req.url === "/v1/commands/prompt") {
        const requestId = String((req.body as { requestId?: string })?.requestId ?? "");
        res.setHeader("content-type", "application/json");
        if (dropConnection && !receipts.has(`done:${requestId}`)) {
          // 登记了命令但响应丢失（模拟响应窗口断连）
          receipts.set(requestId, { ok: true, requestId, runId: "run_1", userMessageId: "msg_1", queued: false });
          res.destroy();
          return;
        }
        receipts.set(`done:${requestId}`, true);
        res.end(JSON.stringify(receipts.get(requestId) ?? { ok: true, requestId, runId: "run_new", userMessageId: "msg_new", queued: false }));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      void ctx;
    });
    try {
      process.env.LECTERN_HOST_GATEWAY = await withHostJson(dir, host.port);
      const gw = await importGateway();
      // 第一次：Host 登记后断连 → 网关必须报结构化 503（绝不 null 回落进程内）
      dropConnection = true;
      const first = await gw.hostGateway(postPrompt("ses_pc10", { text: "hi", requestId: "req_same_key_1" }));
      expect(first!.status).toBe(503);
      // 同键重试：Host 返回登记时的原回执（run_1——不是新 run）
      dropConnection = false;
      const retry = await gw.hostGateway(postPrompt("ses_pc10", { text: "hi", requestId: "req_same_key_1" }));
      expect(retry!.status).toBe(200);
      const receipt = (await retry!.json()) as { runId: string; userMessageId: string };
      expect(receipt.runId).toBe("run_1");
      expect(receipt.userMessageId).toBe("msg_1");
      // Host 两次收到同一 requestId（幂等重放，不是第二条命令）
      const promptCalls = host.requests.filter((r) => r.url === "/v1/commands/prompt");
      expect(promptCalls).toHaveLength(2);
      expect(promptCalls.every((r) => (r.body as { requestId?: string }).requestId === "req_same_key_1")).toBe(true);
    } finally {
      delete process.env.LECTERN_HOST_GATEWAY;
      host.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("回执查询路由：GET /api/sessions/:id/command/:rid → Host /v1/commands/receipt（sessionId+requestId 透传）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t07-receipt-"));
    const host = await startFakeHost((req, res) => {
      if (req.url.startsWith("/v1/commands/receipt")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ found: true, receipt: { ok: true, requestId: "r" } }));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      process.env.LECTERN_HOST_GATEWAY = await withHostJson(dir, host.port);
      const gw = await importGateway();
      const res = await gw.hostGateway(new Request("http://127.0.0.1/api/sessions/ses_r/command/req_rrrr"));
      expect(res!.status).toBe(200);
      expect(host.requests[0]!.url).toBe(`/v1/commands/receipt?sessionId=ses_r&requestId=req_rrrr`);
    } finally {
      delete process.env.LECTERN_HOST_GATEWAY;
      host.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("armed + Host 正常：透传响应（成功路径不回归）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t07-pass-"));
    const host = await startFakeHost();
    try {
      process.env.LECTERN_HOST_GATEWAY = await withHostJson(dir, host.port);
      const gw = await importGateway();
      const res = await gw.hostGateway(postPrompt("ses_ok", { text: "hi", requestId: "req_ok_1111" }));
      expect(res!.status).toBe(200);
      const body = (await res!.json()) as { ok: boolean; via: string };
      expect(body.via).toBe("host");
      expect(host.requests[0]!.authorization).toBe("Bearer t0k");
    } finally {
      delete process.env.LECTERN_HOST_GATEWAY;
      host.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("T09：会话列表/事件流网关化（回归 d416ca4 撤下的多项目列表）", () => {
  async function bootWithProjects(): Promise<{ dir: string; host: HostHandle }> {
    const dir = await mkdtemp(path.join(tmpdir(), "t09-gw-"));
    const { mkdirSync, writeFileSync: wf } = await import("node:fs");
    mkdirSync(path.join(dir, "data"), { recursive: true });
    mkdirSync(path.join(dir, "pa"), { recursive: true });
    wf(path.join(dir, "data", "projects.json"), JSON.stringify({ activeId: "p_active", projects: [{ id: "p_active", name: "A", path: path.join(dir, "pa"), createdAt: new Date().toISOString() }] }));
    const host = await startFakeHost((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/v1/sessions")) {
        const url = new URL(req.url, "http://x");
        res.end(JSON.stringify({ sessions: [{ id: "s1", projectId: url.searchParams.get("projectId") }] }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    return { dir, host };
  }

  it("缺省视图注入 active projectId（每请求重读）；Host 收到 local 身份", async () => {
    const { dir, host } = await bootWithProjects();
    try {
      process.env.LECTERN_DATA_DIR = path.join(dir, "data");
      process.env.LECTERN_HOST_GATEWAY = await withHostJson(dir, host.port);
      const gw = await importGateway();
      const res = await gw.hostGateway(new Request("http://127.0.0.1/api/sessions"));
      expect(res!.status).toBe(200);
      // unwrap：Host {sessions:[...]} → UI 裸数组契约
      const list = (await res!.json()) as { id: string; projectId: string | null }[];
      expect(Array.isArray(list)).toBe(true);
      expect(list[0]!.projectId).toBe("p_active");
      const hit = host.requests.find((r) => r.url.startsWith("/v1/sessions"))!;
      expect(hit.url).toContain("userId=local");
      expect(hit.url).toContain("workspaceId=local");
      expect(hit.url).toContain("projectId=p_active");
    } finally {
      delete process.env.LECTERN_HOST_GATEWAY;
      delete process.env.LECTERN_DATA_DIR;
      host.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("?all=1 → 全项目聚合（不注入 projectId）；SSE 事件路由映射 + since 透传", async () => {
    const { dir, host } = await bootWithProjects();
    try {
      process.env.LECTERN_DATA_DIR = path.join(dir, "data");
      process.env.LECTERN_HOST_GATEWAY = await withHostJson(dir, host.port);
      const gw = await importGateway();
      const res = await gw.hostGateway(new Request("http://127.0.0.1/api/sessions?all=1"));
      expect(res!.status).toBe(200);
      const hit = host.requests.find((r) => r.url.startsWith("/v1/sessions"))!;
      expect(hit.url).not.toContain("projectId=");

      const evRes = await gw.hostGateway(new Request("http://127.0.0.1/api/sessions/ses_ev/events?since=42"));
      expect(evRes).not.toBeNull();
      const evHit = host.requests.find((r) => r.url.startsWith("/v1/events"))!;
      expect(evHit.url).toBe(`/v1/events?sessionId=ses_ev&since=42`);
    } finally {
      delete process.env.LECTERN_HOST_GATEWAY;
      delete process.env.LECTERN_DATA_DIR;
      host.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
