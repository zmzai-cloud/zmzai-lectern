import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
};

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
        capabilities: { commands: ["prompt"], events: true },
        uptimeMs: Date.now() - startedAt,
      };
      send(res, 200, handshake);
      return;
    }
    send(res, 404, { error: "NOT_FOUND", message: "M2a 骨架仅提供 /health" });
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
