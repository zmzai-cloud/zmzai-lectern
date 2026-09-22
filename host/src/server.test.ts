import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL_VERSION, startHostServer } from "./server.js";

/** M2a-S9：Host 骨架——握手、token 门禁零副作用（A24 探针）、Origin 骨架。 */
describe("Host 骨架（M2a-S9）", () => {
  it("握手：随机端口 + host.json（token，600 权限）+ /health 形状且不含 token", async () => {
    const dataDir = await mkdtemp();
    try {
      const host = await startHostServer({ dataDir });
      const res = await fetch(`http://127.0.0.1:${host.port}/health`, { headers: { authorization: `Bearer ${host.token}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.protocolVersion).toBe(HOST_PROTOCOL_VERSION);
      expect(body.hostInstanceId).toBe(host.hostInstanceId);
      // 无 runtime 时骨架形状（S10 起 capabilities 随 runtime 出现）
      expect(body.capabilities).toEqual({ commands: [], events: false });
      expect(typeof body.uptimeMs).toBe("number");
      expect(JSON.stringify(body)).not.toContain(host.token);

      const raw = JSON.parse(await readFile(host.hostJsonPath, "utf8")) as { token: string; port: number; protocolVersion: number };
      expect(raw.token).toBe(host.token);
      expect(raw.port).toBe(host.port);
      expect(raw.protocolVersion).toBe(HOST_PROTOCOL_VERSION);
      await host.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("无 token / 错 token → 401，数据目录零新增文件（A24 探针）", async () => {
    const dataDir = await mkdtemp();
    try {
      const host = await startHostServer({ dataDir });
      const before = (await readdir(dataDir)).sort();

      const noToken = await fetch(`http://127.0.0.1:${host.port}/health`);
      expect(noToken.status).toBe(401);

      const wrong = await fetch(`http://127.0.0.1:${host.port}/health`, { headers: { authorization: "Bearer " + "0".repeat(64) } });
      expect(wrong.status).toBe(401);
      expect(((await wrong.json()) as { error: string }).error).toBe("UNAUTHORIZED");

      const after = (await readdir(dataDir)).sort();
      expect(after).toEqual(before); // 只有 host.json，401 请求没碰任何东西
      await host.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("非回环 Origin → 403；未知路径 → 404（带合法 token）", async () => {
    const dataDir = await mkdtemp();
    try {
      const host = await startHostServer({ dataDir });
      const evil = await fetch(`http://127.0.0.1:${host.port}/health`, {
        headers: { authorization: `Bearer ${host.token}`, origin: "https://evil.example" },
      });
      expect(evil.status).toBe(403);

      const notFound = await fetch(`http://127.0.0.1:${host.port}/v1/commands/prompt`, {
        method: "POST",
        headers: { authorization: `Bearer ${host.token}` },
      });
      expect(notFound.status).toBe(404);
      await host.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

async function mkdtemp(): Promise<string> {
  const { mkdtemp: mk } = await import("node:fs/promises");
  return mk(path.join(tmpdir(), "host-s9-"));
}
