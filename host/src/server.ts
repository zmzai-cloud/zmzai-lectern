import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { subscribeEventLog } from "@zmzai/agent-framework";
import type { FixtureRuntime } from "./runtime.js";

/** M2a Host 骨架（spec §5.1）。
 *
 *  设计文档：docs/superpowers/plans/2026-09-22-m2a-host-minimal-design.md
 *  - 随机 loopback 端口 + 高熵 token，握手文件 host.json（600）落数据目录
 *  - 无/错 token → 401 且零副作用（A24 探针依赖这一点）
 *  - Origin 骨架校验：非回环 Origin → 403（完整规则随 M2b 固定端口策略）
 *  - token 永不出现在响应、日志或 /health 里 */

export const HOST_PROTOCOL_VERSION = 1;
export const HOST_SCHEMA_VERSION = 1;

export type HostHandshake = {
  protocolVersion: number;
  hostInstanceId: string;
  schemaVersion: number;
  capabilities: { commands: string[]; events: boolean };
  uptimeMs: number;
};

export type HostHandle = {
  port: number;
  token: string;
  hostInstanceId: string;
  hostJsonPath: string;
  handshake: HostHandshake;
  close(): Promise<void>;
};

export type HostServerOptions = {
  /** 数据目录（M2a 为 fixture 目录）；host.json 落在其下。 */
  dataDir: string;
  /** 测试注入：固定 token / hostInstanceId。 */
  token?: string;
  hostInstanceId?: string;
  /** M2a fixture 执行链（S10+）。缺省时仅 /health 可用。 */
  runtime?: FixtureRuntime;
  /** B1：真实 runtime 的只读面（sessions 列表）。缺省时端点 404。 */
  realRuntime?: { listSessions(filter: { userId: string; workspaceId?: string }): Promise<unknown[]> };
};

async function readJsonBody(req: IncomingMessageLike): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) throw new Error("BODY_TOO_LARGE");
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("BODY_NOT_OBJECT");
  return parsed as Record<string, unknown>;
}

type IncomingMessageLike = AsyncIterable<unknown> & { headers: Record<string, string | string[] | undefined> };

function send(res: ServerResponseLike, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

type ServerResponseLike = { writeHead(status: number, headers: Record<string, number | string>): void; end(text: string): void };

function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

export async function startHostServer(options: HostServerOptions): Promise<HostHandle> {
  const token = options.token ?? randomBytes(32).toString("hex");
  const hostInstanceId = options.hostInstanceId ?? randomUUID();
  const startedAt = Date.now();

  const authorized = (req: { headers: Record<string, string | string[] | undefined> }): boolean => {
    const header = req.headers.authorization;
    return typeof header === "string" && header === `Bearer ${token}`;
  };

  const server = createServer((req, res) => {
    void (async () => {
      // 先鉴权后一切：401 路径上不得产生任何副作用（A24）
      if (!authorized(req)) {
        send(res, 401, { error: "UNAUTHORIZED", message: "缺少或错误的 Host token" });
        return;
      }
      const origin = req.headers.origin;
      if (typeof origin === "string" && origin.length > 0 && !isLoopbackOrigin(origin)) {
        send(res, 403, { error: "FORBIDDEN", message: "Origin 不在允许列表" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") {
        const handshake: HostHandshake = {
          protocolVersion: HOST_PROTOCOL_VERSION,
          hostInstanceId,
          schemaVersion: HOST_SCHEMA_VERSION,
          capabilities: { commands: options.runtime ? ["prompt", "session"] : [], events: !!options.runtime, ...(options.realRuntime ? { sessions: true } : {}) },
          uptimeMs: Date.now() - startedAt,
        };
        send(res, 200, handshake);
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/sessions" && options.realRuntime) {
        const userId = url.searchParams.get("userId") ?? "";
        const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
        if (!userId) {
          send(res, 400, { error: "INVALID_INPUT", message: "userId 必填" });
          return;
        }
        try {
          send(res, 200, { sessions: await options.realRuntime.listSessions(workspaceId ? { userId, workspaceId } : { userId }) });
        } catch (error) {
          send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (options.runtime) {
        const rt = options.runtime;
        if (req.method === "POST" && url.pathname === "/v1/commands/session") {
          send(res, 200, { sessionId: await rt.createSession() });
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/commands/prompt") {
          const body = await readJsonBody(req);
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!sessionId || !text) {
            send(res, 400, { error: "INVALID_INPUT", message: "sessionId 与 text 必填" });
            return;
          }
          const input: Record<string, unknown> = { text, ...(typeof body.requestId === "string" && body.requestId ? { requestId: body.requestId } : {}) };
          try {
            const receipt = await rt.runner.prompt(sessionId, input as never);
            send(res, 200, receipt);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/REQUEST_ID_REUSED/.test(message)) send(res, 409, { error: "REQUEST_ID_REUSED", message: "同 requestId 换 payload 被拒" });
            else if (/SESSION_NOT_FOUND/.test(message)) send(res, 404, { error: "SESSION_NOT_FOUND", message: "会话不存在" });
            else if (/RECOVERY_REQUIRED/.test(message)) send(res, 409, { error: "RECOVERY_REQUIRED", message: "恢复后重试" });
            else send(res, 500, { error: "INTERNAL", message });
          }
          return;
        }
        if (req.method === "GET" && url.pathname === "/v1/events") {
          const sessionId = url.searchParams.get("sessionId") ?? "";
          if (!sessionId) {
            send(res, 400, { error: "INVALID_INPUT", message: "sessionId 必填" });
            return;
          }
          const sinceRaw = Number(url.searchParams.get("since") ?? "0");
          const sinceSeq = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
          const abort = new AbortController();
          req.on("close", () => abort.abort());
          const heartbeat = setInterval(() => {
            try { res.write(": ping\n\n"); } catch { /* 已关闭 */ }
          }, 15_000);
          try {
            for await (const ev of subscribeEventLog(rt.eventLog, sessionId, { signal: abort.signal, sinceSeq })) {
              res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
            }
          } catch {
            /* 客户端断开：直接结束流 */
          } finally {
            clearInterval(heartbeat);
          }
          res.end();
          return;
        }
      }
      send(res, 404, { error: "NOT_FOUND", message: options.runtime ? "未知路径" : "M2a 骨架仅提供 /health" });
    })().catch(() => send(res, 500, { error: "INTERNAL", message: "请求处理失败" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const hostJsonPath = join(options.dataDir, "host.json");
  writeFileSync(hostJsonPath, JSON.stringify({ protocolVersion: HOST_PROTOCOL_VERSION, hostInstanceId, port, token, startedAt }, null, 2));
  chmodSync(hostJsonPath, 0o600);

  return {
    port,
    token,
    hostInstanceId,
    hostJsonPath,
    handshake: {
      protocolVersion: HOST_PROTOCOL_VERSION,
      hostInstanceId,
      schemaVersion: HOST_SCHEMA_VERSION,
      capabilities: { commands: ["prompt"], events: true },
      uptimeMs: 0,
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
