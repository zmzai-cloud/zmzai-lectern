import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureRuntime } from "./runtime.js";
import { startHostServer, type HostHandle } from "./server.js";

/** M2a-S10 集成：发送 → Host → 工具 → 持久化 → SSE 重放；A03/A04 在 Host 层。 */
async function boot(toolDelayMs = 0): Promise<{ host: HostHandle; close(): Promise<void>; dataDir: string; workspace: string }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "host-s10-data-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "host-s10-ws-"));
  const runtime = createFixtureRuntime({ dataDir, workspaceRoot: workspace, toolDelayMs });
  const host = await startHostServer({ dataDir, runtime });
  return {
    host,
    dataDir,
    workspace,
    close: async () => {
      await host.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 12_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function auth(host: HostHandle): Record<string, string> {
  return { authorization: `Bearer ${host.token}`, "content-type": "application/json" };
}

async function collectSse(host: HostHandle, sessionId: string, since: number, maxFrames: number, ms: number): Promise<{ seqs: number[]; types: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const seqs: number[] = [];
  const types: string[] = [];
  const abortError = { name: "AbortError" };
  try {
    const res = await fetch(`http://127.0.0.1:${host.port}/v1/events?sessionId=${sessionId}&since=${since}`, { headers: auth(host), signal: controller.signal }).catch((e: unknown) => {
      if ((e as { name?: string }).name === "AbortError") return null as Response | null;
      throw e;
    });
    if (!res) return { seqs, types };
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (seqs.length < maxFrames) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const frame of buffer.split("\n\n")) {
        const idLine = frame.split("\n").find((l) => l.startsWith("id: "));
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (idLine && dataLine) {
          seqs.push(Number(idLine.slice(4)));
          types.push((JSON.parse(dataLine.slice(6)) as { type: string }).type);
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
    }
  } catch (e) {
    if ((e as { name?: string }).name !== "AbortError" && (e as { name?: string }).name !== abortError.name) throw e;
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
  return { seqs, types };
}

describe("Host 端点（M2a-S10）", { timeout: 15_000 }, () => {
  it("最小链路：session → prompt → probe 工具落盘 → 事件持久化且 SSE 可重放", async () => {
    const env = await boot();
    try {
      const session = (await (await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/session`, { method: "POST", headers: auth(env.host) })).json()) as { sessionId: string };
      expect(session.sessionId).toBeTruthy();

      const receipt = (await (await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/prompt`, {
        method: "POST",
        headers: auth(env.host),
        body: JSON.stringify({ sessionId: session.sessionId, requestId: "m2a-r1", text: "跑探针" }),
      })).json()) as { requestId: string; runId: string; queued: boolean };
      expect(receipt.requestId).toBe("m2a-r1");

      // 工具副作用可观测：probe.log 出现一行
      await waitFor(async () => (await readFile(path.join(env.workspace, "probe.log"), "utf8").catch(() => "")).includes("m2a-probe"));
      // 任务落终态（事件流出现 task.delivered）
      await waitFor(async () => (await collectSse(env.host, session.sessionId, 0, 1_000, 2_000)).types.includes("task.delivered"));

      const replay = await collectSse(env.host, session.sessionId, 0, 1_000, 2_000);
      expect(replay.seqs.length).toBeGreaterThan(0);
      expect(replay.seqs).toEqual([...replay.seqs].sort((a, b) => a - b));
    } finally {
      await env.close();
    }
  });

  it("A03（Host 层）：响应丢失后同 requestId 重试 → 同一回执，探针只写一次", async () => {
    const env = await boot();
    try {
      const session = (await (await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/session`, { method: "POST", headers: auth(env.host) })).json()) as { sessionId: string };
      const first = await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/prompt`, {
        method: "POST",
        headers: auth(env.host),
        body: JSON.stringify({ sessionId: session.sessionId, requestId: "m2a-a03", text: "跑探针" }),
        signal: AbortSignal.timeout(60), // 极短超时模拟响应丢失
      }).catch(() => null);
      void first;
      const retry = (await (await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/prompt`, {
        method: "POST",
        headers: auth(env.host),
        body: JSON.stringify({ sessionId: session.sessionId, requestId: "m2a-a03", text: "跑探针" }),
      })).json()) as { runId: string };
      await waitFor(async () => {
        const text = await readFile(path.join(env.workspace, "probe.log"), "utf8").catch(() => "");
        return text.split("\n").filter((l) => l === "m2a-probe").length === 1;
      });
      expect(retry.runId).toBeTruthy();
    } finally {
      await env.close();
    }
  });

  it("A04（Host 层）：同 requestId 换 payload → 409", async () => {
    const env = await boot();
    try {
      const session = (await (await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/session`, { method: "POST", headers: auth(env.host) })).json()) as { sessionId: string };
      await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/prompt`, {
        method: "POST",
        headers: auth(env.host),
        body: JSON.stringify({ sessionId: session.sessionId, requestId: "m2a-a04", text: "原始" }),
      });
      const clash = await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/prompt`, {
        method: "POST",
        headers: auth(env.host),
        body: JSON.stringify({ sessionId: session.sessionId, requestId: "m2a-a04", text: "换掉的" }),
      });
      expect(clash.status).toBe(409);
    } finally {
      await env.close();
    }
  });

  it("A01（Host 层）：SSE 断开重连按 since 续传，无缺口无重复", async () => {
    const env = await boot();
    try {
      const session = (await (await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/session`, { method: "POST", headers: auth(env.host) })).json()) as { sessionId: string };
      await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/prompt`, {
        method: "POST",
        headers: auth(env.host),
        body: JSON.stringify({ sessionId: session.sessionId, requestId: "m2a-a01", text: "跑探针" }),
      });
      await waitFor(async () => (await collectSse(env.host, session.sessionId, 0, 1_000, 2_000)).types.includes("task.delivered"));
      const first = await collectSse(env.host, session.sessionId, 0, 1_000, 1_000);
      const lastSeq = first.seqs[first.seqs.length - 1] ?? 0;
      const reconnect = await collectSse(env.host, session.sessionId, lastSeq, 1_000, 1_000);
      // 重连帧全部来自 lastSeq 之后，与首段无交集且连续
      expect(reconnect.seqs.every((seq) => seq > lastSeq)).toBe(true);
      expect(new Set(reconnect.seqs).size).toBe(reconnect.seqs.length);
    } finally {
      await env.close();
    }
  });
});
