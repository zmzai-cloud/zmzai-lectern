import { createRequire } from "node:module";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentFramework, Part, SqliteSessionStore } from "@zmzai/agent-framework";

/** T01 / F01+F02 Lectern 层生产装配复现（production-chain-closure）。
 *
 *  与 Framework 层复现（src/server/create-agent-runtime.subagents-assembly.test.ts，
 *  本地源码）对照，本文件用 Lectern 真实装配链证明缺陷在**安装包消费路径**上成立：
 *  vendored @zmzai/agent-framework 0.11.0 + lib/runtime.ts 的真实 createAgentRuntime
 *  接线 + 真实 SQLite store/eventLog——除模型端点（scripted relay，OpenAI SSE 线格式）
 *  外零替身。
 *
 *  F01（spec 2026-09-28 §2）：runtimeFor 传给 createAgentRuntime 的
 *  SubagentCoordinator 在 vendored 包的 createServer 边界被静默丢弃（FrameworkDeps
 *  无该字段、条件 spread 豁免 excess property 检查）→ agent_spawn 工具已注册
 *  （createAgentRuntime 见协调器即拼 subagentTools）但执行期 ctx.subagents 永不
 *  注入 → 抛 SUBAGENTS_UNSUPPORTED。
 *
 *  F02（spec 2026-09-28 §2）：lib/runtime.ts 的 runChild 忽略 runAttempt 的真实
 *  outcome、无条件 return "completed"。本用例用 401（pi-ai SDK 不可重试档：
 *  仅 408/409/429/5xx 重试）让真实 runner 的 runAttempt 落 state "failed"，
 *  与生产 runChild 对同一调用固定报 completed 构成矛盾。T02 修复装配、T03
 *  传播真实 outcome 后，本用例翻转为经真实协调器执行并断言 failed 传播。 */

// Vite 的内置模块枚举不含 node:sqlite（与 lib/session-owner.test.ts 同一约定）。
// runtime → attachments/scope 与 vendored framework 的 SQLite store 都要真开库文件，
// 不 mock 会在收集阶段就 "Failed to load url sqlite"。
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

// ---- scripted relay：OpenAI chat-completions SSE 线格式（pi-ai 官方 SDK 解析） ----

type RelayResponse = { status: number; sse?: string };

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 一条 assistant 工具调用（单 delta 完整 arguments + finish_reason=tool_calls 收尾；
 *  provider compat 声明 supportsFinishReason，缺收尾 chunk 会被判流错误）。 */
function toolCallSse(name: string, args: Record<string, unknown>): string {
  const base = { id: "chatcmpl-t01", object: "chat.completion.chunk", created: 1, model: "test-model" };
  return [
    sse({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
    sse({
      ...base,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call_t01", type: "function", function: { name, arguments: JSON.stringify(args) } }] },
        finish_reason: null,
      }],
    }),
    sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ].join("");
}

function textSse(text: string): string {
  const base = { id: "chatcmpl-t01", object: "chat.completion.chunk", created: 1, model: "test-model" };
  return [
    sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
    sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ].join("");
}

const UNAUTHORIZED_BODY = JSON.stringify({
  error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" },
});

type RelayHandle = { url: string; requests: { path: string | undefined; body: unknown }[]; close: () => Promise<void> };

async function startScriptedRelay(handler: (count: number, body: unknown) => RelayResponse): Promise<RelayHandle> {
  const requests: { path: string | undefined; body: unknown }[] = [];
  let count = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      count += 1;
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      requests.push({ path: req.url, body });
      const r = handler(count, body);
      if (r.status !== 200) {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(UNAUTHORIZED_BODY);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(r.sse ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/api/v1`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

// ---- 生产装配：真实 runtimeFor（env 先行 → resetModules → 动态 import） ----

type Assembly = {
  runtime: AgentFramework;
  store: SqliteSessionStore;
  relay: RelayHandle;
  cleanup: () => Promise<void>;
};

/** dataDir/defaultWorkspaceRoot 是模块加载期常量：先设 env、vi.resetModules 清空
 *  模块注册表，再动态 import lib/runtime.js 按当前 env 重新求值。每用例独立
 *  temp dataDir/workspace 做缓存键，互不串库。 */
async function assembleProductionRuntime(handler: (count: number, body: unknown) => RelayResponse): Promise<Assembly> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "lectern-t01-data-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "lectern-t01-ws-"));
  const relay = await startScriptedRelay(handler);
  const saved: Record<string, string | undefined> = {
    LECTERN_DATA_DIR: process.env.LECTERN_DATA_DIR,
    LECTERN_WORKSPACE: process.env.LECTERN_WORKSPACE,
    RELAY_URL: process.env.RELAY_URL,
    LECTERN_FALLBACK_BASE_URL: process.env.LECTERN_FALLBACK_BASE_URL,
    HARNESS_FALLBACK_BASE_URL: process.env.HARNESS_FALLBACK_BASE_URL,
  };
  process.env.LECTERN_DATA_DIR = dataDir;
  process.env.LECTERN_WORKSPACE = workspace;
  process.env.RELAY_URL = relay.url;
  // 降级端点会让首个流错误触发端点切换，干扰 scripted relay 的确定性。
  delete process.env.LECTERN_FALLBACK_BASE_URL;
  delete process.env.HARNESS_FALLBACK_BASE_URL;
  vi.resetModules();
  globalThis.__lecternRuntimes = new Map();
  globalThis.__lecternProjectStores = new Map();
  globalThis.__lecternMcp = new Map();
  globalThis.__lecternLeaseTargets = new Set();
  const { runtimeFor } = await import("./runtime.js");
  const runtime = runtimeFor(workspace);
  return {
    runtime,
    store: runtime.store as SqliteSessionStore,
    relay,
    cleanup: async () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await relay.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

// prompt() 是提交收据语义（异步经 workflow 驱动链推进），不等待运行完成；
// 轮询消息快照直到目标工具 part 落到终态（error/completed）或超时。
type ToolPart = Extract<Part, { type: "tool" }>;

async function waitForToolParts(store: SqliteSessionStore, sessionId: string, tool: string, timeoutMs = 15_000): Promise<ToolPart[]> {
  const start = Date.now();
  for (;;) {
    const snapshot = await store.getMessageSnapshot!(sessionId, { limit: 50 });
    const parts = snapshot.messages
      .flatMap((m) => m.parts)
      .filter((p): p is ToolPart => p.type === "tool" && p.tool === tool);
    const settled = parts.filter((p) => p.state.status === "error" || p.state.status === "completed");
    if (settled.length > 0) return settled;
    if (Date.now() - start > timeoutMs) return parts;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("T01：Lectern 生产装配的子代理缺陷（vendored framework 0.11.0）", () => {
  it("F01：agent_spawn 已注册，但执行抛 SUBAGENTS_UNSUPPORTED——协调器在 createServer 边界被丢弃", async () => {
    const spawnArgs = { description: "并行探索A", prompt: "探索子目录并汇报", agent_type: "explorer", mode: "read_only" };
    const ctx = await assembleProductionRuntime((count) =>
      count === 1
        ? { status: 200, sse: toolCallSse("agent_spawn", spawnArgs) }
        : { status: 200, sse: textSse("已尝试派出子代理（工具报错）") });
    try {
      const { createFrameworkSession } = await import("@zmzai/agent-framework");
      const session = await createFrameworkSession({
        store: ctx.store,
        userId: "u-t01",
        workspaceId: "ws-t01",
        model: { providerId: "openai", modelId: "test-model" },
        // 预盖 task 权限：本用例考的是工具执行期的 ctx.subagents 注入，不是权限门
        permission: [{ permission: "task", pattern: "*", action: "allow" }],
      });
      await ctx.runtime.runner.prompt(session.id, { requestId: "t01_f01_lectern", text: "派一个子代理去探索" });

      const parts = await waitForToolParts(ctx.store, session.id, "agent_spawn");
      // 工具确实被模型调用了（不是「未注册」——那会是另一种错误）
      expect(parts).toHaveLength(1);
      expect(parts[0]!.state.status).toBe("error");
      expect((parts[0]!.state as { error?: string }).error).toContain("SUBAGENTS_UNSUPPORTED");

      // 根因钉住：runtimeFor 确实构造并传出了协调器（否则 agent_spawn 不会注册），
      // 但 vendored 包 createServer 构造 SessionRunner 时丢弃——生产装配中为 undefined。
      const deps = (ctx.runtime.runner as unknown as { deps?: { subagentCoordinator?: unknown } }).deps;
      expect(deps?.subagentCoordinator).toBeUndefined();

      // 协调器从未被触达：无 SubagentRecord
      expect(await ctx.store.subagents!.listSubagents({ parentSessionId: session.id })).toHaveLength(0);
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it("F02：真实 runAttempt 在 401（不可重试）下返回 failed，而 runChild 对同一调用固定 completed", async () => {
    const ctx = await assembleProductionRuntime(() => ({ status: 401 }));
    try {
      const { createFrameworkSession } = await import("@zmzai/agent-framework");
      const parent = await createFrameworkSession({
        store: ctx.store,
        userId: "u-t01",
        workspaceId: "ws-t01",
        model: { providerId: "openai", modelId: "test-model" },
      });
      // 生产 runChild 执行的正是协调器登记的子会话（parentId 挂父会话）。
      const child = await createFrameworkSession({
        store: ctx.store,
        userId: "u-t01",
        workspaceId: "ws-t01",
        parentId: parent.id,
        agent: "explorer",
        model: { providerId: "openai", modelId: "test-model" },
        prompt: "子任务",
      });

      // 复刻 lib/runtime.ts runChild 的两步调用形态（同一条 store、同一个 runner）：
      const childSession = await ctx.store.getSession(child.id);
      expect(childSession).not.toBeNull();
      const outcome = await ctx.runtime.runner.runAttempt(childSession!, { text: "子任务执行", agent: childSession!.agent });

      // 真实失败：401 不可重试，单次请求落 state failed，errorMessage 带状态码。
      expect(outcome.state).toBe("failed");
      expect(outcome.errorMessage ?? "").toContain("401");

      // 矛盾：生产 runChild（lib/runtime.ts:336-341）await 同一 runAttempt 后丢弃
      // outcome、无条件 return "completed"——子失败被上报为完成。协调记录因此落
      // completed，父级验收拿到的也是伪成功。本断言钉住缺陷；T02 接通协调器、
      // T03 传播真实 outcome 后，本用例改为经真实协调器 spawn 执行并断言 failed。
      expect(outcome.settled).toBe(false);
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);
});
