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
  /** B1：真实 runtime 的只读面。缺省的方法对应端点 404；会话不存在由实现
   *  抛 SESSION_NOT_FOUND（server 映射 404）。 */
  realRuntime?: {
    listSessions(filter: { userId: string; workspaceId?: string }): Promise<unknown[]>;
    messages(sessionId: string): Promise<unknown[]>;
    abort?(sessionId: string): Promise<void>;
    resumeTask?(sessionId: string): Promise<boolean>;
    compact?(sessionId: string): Promise<{ ok: boolean; reason?: string }>;
    markRead?(sessionId: string, messageSeq: number, revision: number): Promise<unknown>;
    rewind?(sessionId: string, messageId: string, text?: string): Promise<{ ok: boolean; status?: number; error?: string; code?: string }>;
    attachmentUpload?(sessionId: string, input: { filename: string; mediaType: string; bytes: Buffer }): Promise<unknown>;
    attachmentReceipt?(sessionId: string, attachmentId: string): Promise<unknown>;
    attachmentRaw?(sessionId: string, attachmentId: string, download: boolean): Promise<unknown>;
    terminalList?(): Promise<unknown>;
    terminalCreate?(cwd: string, cols: number, rows: number, command?: string): Promise<unknown>;
    terminalOp?(id: string, op: "write" | "resize" | "kill" | "read" | "readAll", payload?: unknown): Promise<unknown>;
    mcpStatus?(): Promise<unknown>;
    mcpRescan?(): Promise<unknown>;
    worktreeStatus?(sessionId: string): Promise<unknown>;
    /** W1-S27：合并回目标 / 丢弃副本（动作层 { ok, output, status }）。 */
    worktreeAction?(sessionId: string, action: "merge" | "discard"): Promise<unknown>;
    replyPermission?(sessionId: string, requestId: string, reply: unknown, feedback?: string): Promise<boolean>;
    search?(sessionId: string, query: string, limit: number): Promise<unknown>;
    readState?(sessionId: string): Promise<unknown>;
    usage?(sessionId: string): Promise<unknown>;
  };
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

export type RealRuntimeFace = NonNullable<HostServerOptions["realRuntime"]>;

/** 活锁探测（spec §5.1：不能仅凭 PID 文件或删锁接管活进程）：
 *  lock 记录的进程存在且其 /health 可达 → 活锁，拒绝启动。 */
export async function probeLiveLock(lockPath: string): Promise<{ alive: boolean; detail?: string }> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; hostInstanceId: string; port: number; token: string; startedAt: string };
    let alive = false;
    try {
      process.kill(raw.pid, 0);
      alive = true;
    } catch {
      return { alive: false };
    }
    if (!alive) return { alive: false };
    try {
      const res = await fetch(`http://127.0.0.1:${raw.port}/health`, { headers: { authorization: `Bearer ${raw.token}` }, signal: AbortSignal.timeout(1500) });
      if (res.ok) return { alive: true, detail: `pid=${raw.pid} health 可达（${raw.startedAt} 启动）` };
    } catch { /* 端口不通：可能僵尸进程残留 lock */ }
    // 进程在但 health 不可达：仍按活锁处理（不删锁接管），由用户处置
    return { alive: true, detail: `pid=${raw.pid} 存在但 health 不可达（疑似僵死，需人工处理 ${lockPath}）` };
  } catch {
    return { alive: false };
  }
}

/** credentialRef（spec §5.3 的 B2 子集）：Next 网关只提取 muzhi_session 单值
 *  经 x-lectern-credential 头转发，Host 存内存表供模型装配取用。
 *  不落日志、不进事件、不写 store；进程重启即失效（重新登录恢复）。 */
const credentialRefs = new Map<string, string>();

export function credentialFor(sessionId: string): string | undefined {
  return credentialRefs.get(sessionId);
}

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
      const sessMatch = /^\/v1\/sessions\/([^/]+)\/(messages|search|read-state|usage)$/.exec(url.pathname);
      if (req.method === "GET" && sessMatch && options.realRuntime) {
        const real = options.realRuntime;
        const sessionId = decodeURIComponent(sessMatch[1]);
        const kind = sessMatch[2];
        const method = kind === "messages" ? "messages" : kind === "search" ? "search" : kind === "read-state" ? "readState" : "usage";
        const impl = (real as Record<string, unknown>)[method] as ((...args: unknown[]) => Promise<unknown>) | undefined;
        if (!impl) {
          send(res, 404, { error: "NOT_FOUND", message: `后端未提供 ${kind}` });
          return;
        }
        try {
          const query = url.searchParams.get("q") ?? "";
          const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? "50") || 50));
          const body = kind === "messages" ? await impl(sessionId)
            : kind === "search" ? await impl(sessionId, query, limit)
            : await impl(sessionId);
          send(res, 200, body as Record<string, unknown> ?? { });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/SESSION_NOT_FOUND/.test(message)) send(res, 404, { error: "SESSION_NOT_FOUND", message: "会话不存在" });
          else send(res, 500, { error: "INTERNAL", message });
        }
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
        if (req.method === "POST" && url.pathname === "/v1/shutdown" && options.realRuntime) {
          // 有序停止（spec §5.2）：停新命令 → 收任务树/终端 → 结算落库 → 关服务
          send(res, 200, { ok: true, note: "shutdown-accepted" });
          setTimeout(() => process.exit(0), 100);
          return;
        }
        if (url.pathname === "/v1/mcp" && options.realRuntime) {
          if (req.method === "GET") {
            if (!options.realRuntime.mcpStatus) { send(res, 404, { error: "NOT_FOUND", message: "后端未提供 mcp" }); return; }
            try { send(res, 200, await options.realRuntime.mcpStatus()); } catch (error) { send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) }); }
            return;
          }
          if (req.method === "POST") {
            if (!options.realRuntime.mcpRescan) { send(res, 404, { error: "NOT_FOUND", message: "后端未提供 mcp rescan" }); return; }
            try { send(res, 200, await options.realRuntime.mcpRescan()); } catch (error) { send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) }); }
            return;
          }
        }
        const wtMatch = /^\/v1\/sessions\/([^/]+)\/worktree$/.exec(url.pathname);
        if (req.method === "GET" && wtMatch && options.realRuntime) {
          const sessionId = decodeURIComponent(wtMatch[1] ?? "");
          if (!sessionId) { send(res, 400, { error: "INVALID_INPUT", message: "sessionId 必填" }); return; }
          const impl = options.realRuntime.worktreeStatus;
          if (!impl) { send(res, 404, { error: "NOT_FOUND", message: "后端未提供 worktree 查询" }); return; }
          try { send(res, 200, await impl(sessionId)); } catch (error) { send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) }); }
          return;
        }
        if (req.method === "POST" && wtMatch && options.realRuntime) {
          const sessionId = decodeURIComponent(wtMatch[1] ?? "");
          if (!sessionId) { send(res, 400, { error: "INVALID_INPUT", message: "sessionId 必填" }); return; }
          try {
            const body = await readJsonBody(req);
            const action = body.action;
            // 非法请求先拒（与 Next 路由同序：action 校验先于实现可用性）
            if (action !== "merge" && action !== "discard") { send(res, 400, { error: "INVALID_INPUT", message: "action 必须是 merge 或 discard" }); return; }
            const impl = options.realRuntime.worktreeAction;
            if (!impl) { send(res, 404, { error: "NOT_FOUND", message: "后端未提供 worktree 写操作" }); return; }
            const result = (await impl(sessionId, action)) as { ok: boolean; output: string; status?: number };
            send(res, result.status ?? (result.ok ? 200 : 409), { ok: result.ok, output: result.output });
          } catch (error) { send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) }); }
          return;
        }
        if (req.method === "GET" && url.pathname === "/v1/terminal") {
          if (!options.realRuntime?.terminalList) {
            send(res, 404, { error: "NOT_FOUND", message: "后端未提供终端" });
            return;
          }
          try {
            send(res, 200, await options.realRuntime.terminalList());
          } catch (error) {
            send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/terminal") {
          const body = await readJsonBody(req);
          if (!options.realRuntime?.terminalCreate) {
            send(res, 404, { error: "NOT_FOUND", message: "后端未提供终端" });
            return;
          }
          try {
            send(res, 200, await options.realRuntime.terminalCreate(typeof body.cwd === "string" ? body.cwd : "", Math.floor(Number(body.cols ?? 80)), Math.floor(Number(body.rows ?? 24)), typeof body.command === "string" ? body.command : undefined));
          } catch (error) {
            send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        const termMatch = /^\/v1\/terminal\/([^/]+)$/.exec(url.pathname);
        if (termMatch && options.realRuntime?.terminalOp) {
          const id = decodeURIComponent(termMatch[1]!);
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const op = body.op;
            if (op !== "write" && op !== "resize" && op !== "kill") {
              send(res, 400, { error: "INVALID_INPUT", message: "op ∈ write|resize|kill" });
              return;
            }
            try {
              send(res, 200, await options.realRuntime.terminalOp(id, op, body.payload));
            } catch (error) {
              send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) });
            }
            return;
          }
          if (req.method === "GET") {
            const all = url.searchParams.get("all") === "1";
            try {
              send(res, 200, await options.realRuntime.terminalOp(id, all ? "readAll" : "read"));
            } catch (error) {
              send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) });
            }
            return;
          }
          if (req.method === "DELETE") {
            try {
              send(res, 200, await options.realRuntime.terminalOp(id, "kill"));
            } catch (error) {
              send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) });
            }
            return;
          }
        }
        if (req.method === "POST" && url.pathname === "/v1/commands/attachment") {
          const body = await readJsonBody(req);
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
          const filename = typeof body.filename === "string" ? body.filename : "";
          const mediaType = typeof body.mediaType === "string" ? body.mediaType : "application/octet-stream";
          const bytes = typeof body.bytesBase64 === "string" ? Buffer.from(body.bytesBase64, "base64") : null;
          if (!sessionId || !filename || !bytes || bytes.length === 0) {
            send(res, 400, { error: "INVALID_INPUT", message: "sessionId/filename/bytesBase64 必填" });
            return;
          }
          const upload = options.realRuntime?.attachmentUpload;
          if (!upload) {
            send(res, 404, { error: "NOT_FOUND", message: "后端未提供附件上传" });
            return;
          }
          try {
            send(res, 200, await upload(sessionId, { filename, mediaType, bytes }));
          } catch (error) {
            send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        const attMatch = /^\/v1\/attachments\/([^/]+)(\/raw)?$/.exec(url.pathname);
        if (req.method === "GET" && attMatch && options.realRuntime) {
          const sessionId = url.searchParams.get("sessionId") ?? "";
          if (!sessionId) {
            send(res, 400, { error: "INVALID_INPUT", message: "sessionId 必填" });
            return;
          }
          try {
            if (attMatch[2]) {
              const raw = (await options.realRuntime.attachmentRaw?.(sessionId, decodeURIComponent(attMatch[1]), url.searchParams.get("download") === "1")) as
                | { kind: "not_found" | "gone"; message: string; status: number }
                | { kind: "raw"; mediaType: string; size: number; filename: string; disposition: string; stream: import("node:stream").Readable }
                | undefined;
              if (!raw || raw.kind !== "raw") {
                const miss = raw as { status?: number; message?: string; kind?: string } | undefined;
                send(res, miss?.status ?? 404, { error: miss?.message ?? "附件不存在", ...(miss?.kind === "gone" ? { code: "not_found" } : {}) });
                return;
              }
              res.writeHead(200, {
                "content-type": raw.mediaType,
                "content-length": String(raw.size),
                "content-disposition": `${raw.disposition}; filename="${raw.filename.replace(/[^ -~]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(raw.filename)}`,
                "cache-control": "private, max-age=0, must-revalidate",
                "x-content-type-options": "nosniff",
                "cross-origin-resource-policy": "same-origin",
                "content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
              });
              raw.stream.pipe(res);
              return;
            }
            const receipt = await options.realRuntime.attachmentReceipt?.(sessionId, decodeURIComponent(attMatch[1]));
            if (!receipt || (receipt as { kind?: string }).kind === "not_found") {
              send(res, 404, { error: "附件不存在或不属于该会话", code: "not_found" });
              return;
            }
            send(res, 200, receipt);
          } catch (error) {
            send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/commands/rewind") {
          const body = await readJsonBody(req);
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
          const messageId = typeof body.messageId === "string" ? body.messageId : "";
          const text = typeof body.text === "string" && body.text ? body.text : undefined;
          if (!sessionId || !messageId) {
            send(res, 400, { error: "INVALID_INPUT", message: "sessionId 与 messageId 必填" });
            return;
          }
          const rewindImpl = options.realRuntime?.rewind;
          if (!rewindImpl) {
            send(res, 404, { error: "NOT_FOUND", message: "后端未提供 rewind" });
            return;
          }
          const outcome = await rewindImpl(sessionId, messageId, text);
          if (outcome.ok) send(res, 200, { ok: true });
          else send(res, outcome.status ?? 500, { error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}) });
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/commands/compact") {
          const body = await readJsonBody(req);
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
          if (!sessionId) {
            send(res, 400, { error: "INVALID_INPUT", message: "sessionId 必填" });
            return;
          }
          const compactImpl = options.realRuntime?.compact ?? ((sid: string) => rt.runner.compactSession(sid));
          try {
            send(res, 200, await compactImpl(sessionId));
          } catch (error) {
            send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/commands/read-state") {
          const body = await readJsonBody(req);
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
          const messageSeq = Number(body.messageSeq);
          const revision = Number(body.revision ?? 1);
          if (!sessionId || !Number.isFinite(messageSeq) || !Number.isFinite(revision)) {
            send(res, 400, { error: "INVALID_INPUT", message: "sessionId/messageSeq/revision 必填" });
            return;
          }
          const markImpl = options.realRuntime?.markRead;
          if (!markImpl) {
            send(res, 404, { error: "NOT_FOUND", message: "后端未提供 read-state 写" });
            return;
          }
          try {
            send(res, 200, await markImpl(sessionId, Math.floor(messageSeq), Math.floor(revision)));
          } catch (error) {
            send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/commands/task") {
          const body = await readJsonBody(req);
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
          const action = body.action;
          if (!sessionId || (action !== "resume" && action !== "stop")) {
            send(res, 400, { error: "INVALID_INPUT", message: "sessionId 必填；action ∈ resume|stop" });
            return;
          }
          const runner = options.realRuntime ?? { abort: rt.runner.abort.bind(rt.runner), resumeTask: rt.runner.resumeTask.bind(rt.runner) } as never as { abort(s: string): Promise<void>; resumeTask(s: string): Promise<boolean> };
          try {
            const result = action === "resume" ? await (runner as { resumeTask(s: string): Promise<boolean> }).resumeTask(sessionId) : undefined;
            if (action === "stop") await (runner as { abort(s: string): Promise<void> }).abort(sessionId);
            send(res, 200, { ok: action === "resume" ? result !== false : true });
          } catch (error) {
            send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/commands/abort") {
          const body = await readJsonBody(req);
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
          if (!sessionId) {
            send(res, 400, { error: "INVALID_INPUT", message: "sessionId 必填" });
            return;
          }
          const abortImpl = options.realRuntime?.abort ?? rt.runner.abort.bind(rt.runner);
          try {
            await abortImpl(sessionId);
            send(res, 200, { ok: true });
          } catch (error) {
            send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/commands/permission") {
          const body = await readJsonBody(req);
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
          const requestId = typeof body.requestId === "string" ? body.requestId : "";
          if (!sessionId || !requestId) {
            send(res, 400, { error: "INVALID_INPUT", message: "sessionId 与 requestId 必填" });
            return;
          }
          const replyImpl = options.realRuntime?.replyPermission
            ?? ((sid: string, rid: string, reply: unknown, feedback?: string) => rt.runner.replyPermission(sid, rid, reply as never, feedback));
          try {
            const handled = await replyImpl(sessionId, requestId, body.reply, typeof body.feedback === "string" ? body.feedback : undefined);
            send(res, 200, { handled });
          } catch (error) {
            send(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/commands/prompt") {
          const body = await readJsonBody(req);
          // credentialRef：网关提取的 muzhi_session 单值（存在才记；不落日志）
          const credentialHeader = req.headers["x-lectern-credential"];
          if (typeof body.sessionId === "string" && body.sessionId && typeof credentialHeader === "string" && credentialHeader) {
            credentialRefs.set(body.sessionId, credentialHeader);
          }
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
          // A08：水位失效（since 超过最新 seq，如 rewind 后游标前跳）显式 409，
          // 客户端重新取快照——不能把缺口后的事件当已完整应用
          const latest = await rt.eventLog.count(sessionId).catch(() => 0);
          if (sinceSeq > latest) {
            send(res, 409, { error: "CURSOR_STALE", message: "事件水位已失效，请重新加载会话快照" });
            return;
          }
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
