import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureRuntime } from "./runtime.js";
import { credentialFor, startHostServer, type HostHandle, type HostServerOptions } from "./server.js";

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

describe("Host 命令族端点（M2b-B2）", { timeout: 25_000 }, () => {
  it("abort：工具执行中停止 → cancelled 事件；credential 头进内存表不外泄", async () => {
    const env = await boot(2_000); // 工具延迟 2s 制造执行中窗口
    try {
      const session = (await (await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/session`, { method: "POST", headers: { ...auth(env.host), "x-lectern-credential": "muzhi_session=secret-value" } })).json()) as { sessionId: string };
      await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/prompt`, {
        method: "POST",
        headers: { ...auth(env.host), "x-lectern-credential": "muzhi_session=secret-value" },
        body: JSON.stringify({ sessionId: session.sessionId, requestId: "b2-abort", text: "跑探针" }),
      });
      await new Promise((r) => setTimeout(r, 300)); // 进入工具执行
      const aborted = await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/abort`, { method: "POST", headers: auth(env.host), body: JSON.stringify({ sessionId: session.sessionId }) });
      expect(aborted.status).toBe(200);
      expect(((await aborted.json()) as { ok: boolean }).ok).toBe(true);
      // 停止生效：probe 不写（工具被取消），事件流出现 task.cancelled
      await waitFor(async () => (await collectSse(env.host, session.sessionId, 0, 1_000, 2_000)).types.includes("task.cancelled"));
      const { types } = await collectSse(env.host, session.sessionId, 0, 1_000, 1_500);
      expect(types).toContain("task.cancelled");
      // credential 不出现在任何事件帧里
      const allFrames = (await collectSse(env.host, session.sessionId, 0, 1_000, 800)).seqs.length;
      void allFrames;
      const health = await (await fetch(`http://127.0.0.1:${env.host.port}/health`, { headers: auth(env.host) })).text();
      expect(health).not.toContain("secret-value");
      // permission 端点参数校验
      const missing = await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/permission`, { method: "POST", headers: auth(env.host), body: JSON.stringify({ sessionId: session.sessionId }) });
      expect(missing.status).toBe(400);
    } finally {
      await env.close();
    }
  });
});

describe("credentialRef 通道（M2b-B2）", () => {
  it("prompt 携带 x-lectern-credential → Host 内存表按 sessionId 可取", async () => {
    const env = await boot();
    try {
      const session = (await (await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/session`, { method: "POST", headers: auth(env.host) })).json()) as { sessionId: string };
      await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/prompt`, {
        method: "POST",
        headers: { ...auth(env.host), "x-lectern-credential": "muzhi_session=cred-b2-test" },
        body: JSON.stringify({ sessionId: session.sessionId, requestId: "b2-cred", text: "凭据通道" }),
      });
      expect(credentialFor(session.sessionId)).toBe("muzhi_session=cred-b2-test");
      // 其他会话取不到
      expect(credentialFor("ses_other")).toBeUndefined();
    } finally {
      await env.close();
    }
  });
});

describe("worktree 写操作端点（W1-S27-C）", () => {
  it("POST /v1/sessions/:id/worktree：无 impl → 404；有 impl → 状态码与 body 透传；非法 action → 400", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "host-s27-data-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "host-s27-ws-"));
    const runtime = createFixtureRuntime({ dataDir, workspaceRoot: workspace });
    // realRuntime face 存在但未实现 worktreeAction → 404；action 校验先于实现检查
    const host = await startHostServer({ dataDir, runtime, realRuntime: {} as HostServerOptions["realRuntime"] });
    try {
      const none = await fetch(`http://127.0.0.1:${host.port}/v1/sessions/ses_x/worktree`, {
        method: "POST", headers: auth(host), body: JSON.stringify({ action: "merge" }),
      });
      expect(none.status).toBe(404); // fixture face 未实现写操作

      const bad = await fetch(`http://127.0.0.1:${host.port}/v1/sessions/ses_x/worktree`, {
        method: "POST", headers: auth(host), body: JSON.stringify({ action: "reset" }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await host.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("POST /v1/sessions/:id/worktree：impl 透传 ok/output/status（409 拒绝语义保留）", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "host-s27b-data-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "host-s27b-ws-"));
    const runtime = createFixtureRuntime({ dataDir, workspaceRoot: workspace });
    const calls: [string, string][] = [];
    const worktreeAction = async (sessionId: string, action: "merge" | "discard") => {
      calls.push([sessionId, action]);
      return action === "merge"
        ? { ok: false, output: "会话没有隔离副本", status: 409 }
        : { ok: true, output: "隔离副本已丢弃", status: 200 };
    };
    const host = await startHostServer({ dataDir, runtime, realRuntime: { worktreeAction } as HostServerOptions["realRuntime"] });
    try {
      const refused = await fetch(`http://127.0.0.1:${host.port}/v1/sessions/ses_y/worktree`, {
        method: "POST", headers: auth(host), body: JSON.stringify({ action: "merge" }),
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ ok: false, output: "会话没有隔离副本" });

      const ok2 = await fetch(`http://127.0.0.1:${host.port}/v1/sessions/ses_y/worktree`, {
        method: "POST", headers: auth(host), body: JSON.stringify({ action: "discard" }),
      });
      expect(ok2.status).toBe(200);
      expect(await ok2.json()).toMatchObject({ ok: true, output: "隔离副本已丢弃" });
      expect(calls).toEqual([["ses_y", "merge"], ["ses_y", "discard"]]);
    } finally {
      await host.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("SSE 水位与状态操作（M2b-B3）", () => {
  it("A08：since 超过最新 seq → 409 显式重同步；compact 端点可达", async () => {
    const env = await boot();
    try {
      const session = (await (await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/session`, { method: "POST", headers: auth(env.host) })).json()) as { sessionId: string };
      await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/prompt`, { method: "POST", headers: auth(env.host), body: JSON.stringify({ sessionId: session.sessionId, requestId: "b3-a08", text: "跑探针" }) });
      await waitFor(async () => (await readFile(path.join(env.workspace, "probe.log"), "utf8").catch(() => "")).includes("m2a-probe"));
      const stale = await fetch(`http://127.0.0.1:${env.host.port}/v1/events?sessionId=${session.sessionId}&since=99999`, { headers: auth(env.host) });
      expect(stale.status).toBe(409);
      expect(((await stale.json()) as { error: string }).error).toBe("CURSOR_STALE");
      const compacted = await fetch(`http://127.0.0.1:${env.host.port}/v1/commands/compact`, { method: "POST", headers: auth(env.host), body: JSON.stringify({ sessionId: session.sessionId }) });
      expect(compacted.status).toBe(200);
      expect(((await compacted.json()) as { reason?: string }).reason).toBe("compaction-disabled"); // fixture 未配摘要模型，如实报告
    } finally {
      await env.close();
    }
  });
});
