import { createRequire } from "node:module";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentFramework, Part, SqliteSessionStore } from "@zmzai/agent-framework";

/** T01→T02 / F01+F02 Lectern 层生产装配测试（production-chain-closure）。
 *
 *  安装包消费路径：vendored @zmzai/agent-framework + lib/runtime.ts 的真实
 *  createAgentRuntime 接线 + 真实 SQLite store/eventLog——除模型端点
 *  （scripted relay，OpenAI SSE 线格式）外零替身。
 *
 *  F01（T01 时钉住、T02 修复翻绿=PC01）：协调器曾在 vendored 包 createServer
 *  边界被静默丢弃（FrameworkDeps 无字段 + 条件 spread 豁免检查）→ agent_spawn
 *  抛 SUBAGENTS_UNSUPPORTED。0.12.0 起 FrameworkDeps 显式携带 subagentCoordinator
 *  并透传 SessionRunner；子会话创建走统一 ChildSessionFactory（父身份 store 解析、
 *  父权限 stamp、确定性子 id 幂等）。本用例断言真实生产装配全链：模型调
 *  agent_spawn → 子会话建立 → 协调记录落库 → runChild 真实执行。
 *
 *  F02（T01 时钉住、T03 修复翻绿=PC02）：lib/runtime.ts 的 runChild 曾忽略
 *  runAttempt 的真实 outcome、无条件 return "completed"。0.13.0 起 runChild
 *  传播结构化 outcome（失败/取消/副作用未知映射 failed/cancelled/blocked，
 *  finalText 作 summary、证据候选映射 evidenceRefs）；401（pi-ai SDK 不可重试
 *  档：仅 408/409/429/5xx 重试）下经真实协调器全链验证 failed 落记录。 */

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

/** 子代理协调记录轮询：pump 异步启动 runChild，终态经 store 落库。 */
async function waitForSubagentTerminal(store: SqliteSessionStore, childId: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const record = await store.subagents!.getSubagent(childId);
    if (record && (record.status === "completed" || record.status === "failed" || record.status === "cancelled")) return;
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("T02/PC01：Lectern 生产装配的子代理派生（vendored framework 0.12.0）", () => {
  it("F01 修复验收：agent_spawn 经真实 runtimeFor 全链建立子会话（协调器抵达 runner，统一工厂创建）", async () => {
    // explore 是框架内置 subagent 类型（registry builtin）；explorer 之类未注册名会被协调器拒绝
    const spawnArgs = { description: "并行探索A", prompt: "探索子目录并汇报", agent_type: "explore", mode: "read_only" };
    const ctx = await assembleProductionRuntime((count) =>
      count === 1
        ? { status: 200, sse: toolCallSse("agent_spawn", spawnArgs) }
        : { status: 200, sse: textSse("子代理执行完成（或父轮收尾）") });
    try {
      const { createFrameworkSession } = await import("@zmzai/agent-framework");
      const session = await createFrameworkSession({
        store: ctx.store,
        userId: "u-t01",
        workspaceId: "ws-t01",
        model: { providerId: "openai", modelId: "test-model" },
        // 预盖 task 权限：本用例考的是装配链路，不是权限门
        permission: [{ permission: "task", pattern: "*", action: "allow" }],
      });
      await ctx.runtime.runner.prompt(session.id, { requestId: "t02_pc01_lectern", text: "派一个子代理去探索" });

      const parts = await waitForToolParts(ctx.store, session.id, "agent_spawn");
      expect(parts).toHaveLength(1);
      expect(parts[0]!.state.status).toBe("completed");

      // 修复直接证据：runtimeFor 构造的协调器抵达 runner（不再被 createServer 边界丢弃）
      const deps = (ctx.runtime.runner as unknown as { deps?: { subagentCoordinator?: unknown } }).deps;
      expect(deps?.subagentCoordinator).toBeDefined();

      // 统一工厂真实创建子会话：SubagentRecord 落库、子会话挂父、身份继承父用户
      const records = await ctx.store.subagents!.listSubagents({ parentSessionId: session.id });
      expect(records).toHaveLength(1);
      expect(records[0]!.agentType).toBe("explore");
      const childSession = await ctx.store.getSession(records[0]!.childSessionId);
      expect(childSession).not.toBeNull();
      expect(childSession!.parentId).toBe(session.id);
      expect(childSession!.userId).toBe("u-t01");

      // runChild 真实执行：子会话收到模型响应（relay 收到子会话的 chat/completions 请求）
      await waitForSubagentTerminal(ctx.store, records[0]!.childId, 15_000);
      const finalRecord = await ctx.store.subagents!.getSubagent(records[0]!.childId);
      expect(finalRecord!.status).toBe("completed");
      expect(ctx.relay.requests.length).toBeGreaterThanOrEqual(2);
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it("F02 修复验收（T03）：401 下子 run 真实 failed 经协调器传播进记录（不再伪报 completed）", async () => {
    const ctx = await assembleProductionRuntime(() => ({ status: 401 }));
    try {
      const { createFrameworkSession } = await import("@zmzai/agent-framework");
      const parent = await createFrameworkSession({
        store: ctx.store,
        userId: "u-t01",
        workspaceId: "ws-t01",
        model: { providerId: "openai", modelId: "test-model" },
      });
      // 生产链路（T02 后协调器可触达）：spawn → 统一工厂建子会话 → runChild →
      // runAttempt（401 不可重试，单次请求失败）→ 结构化 outcome 传播进 SubagentRecord。
      const coordinator = (ctx.runtime.runner as unknown as { deps: { subagentCoordinator: import("@zmzai/agent-framework").SubagentCoordinator } }).deps.subagentCoordinator;
      expect(coordinator).toBeDefined();
      const record = await coordinator.spawn({ id: parent.id }, "task_f02", "task_f02", {
        description: "子任务",
        prompt: "子任务执行",
        subagentType: "explore",
        mode: "read_only",
      });
      await waitForSubagentTerminal(ctx.store, record.childId, 20_000);

      const final = await ctx.store.subagents!.getSubagent(record.childId);
      expect(final).not.toBeNull();
      // T01 时钉住的缺陷：runChild 无条件 return "completed" → 子失败被上报完成。
      // T03 修复后：真实 failed 落记录，错误原因（401）进 blockerReason 与 result。
      expect(final!.status).toBe("failed");
      expect(final!.result?.outcome).toBe("failed");
      expect(final!.blockerReason ?? "").toContain("401");
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);
});
