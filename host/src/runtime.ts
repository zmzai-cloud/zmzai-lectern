import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AgentRegistry,
  SessionRunner,
  createFrameworkSession,
  createSqliteEventLog,
  createSqliteSessionStore,
  type ToolDef,
  builtinTools,
} from "@zmzai/agent-framework";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

/** M2a fixture runtime：Host 内的最小执行链（发送 → 工具 → 持久化）。
 *
 *  - scripted 模型（faux）：每个 prompt 消耗三轮——probe 工具调用 →
 *    task_deliver 交付声明 → 收尾文本（一次 Attempt 内完成并 delivered，
 *    语义与 framework FIFO 用例同构，避免 Completion Gate 打回续跑）
 *  - probe 工具是可观测的副作用探针：写 fixture 工作区 probe.log，可注入
 *    延迟制造「工具执行中」窗口（A02 杀 Next 的场景依赖它）
 *  - 持久化走 fixture 数据目录的 SQLite（store + eventLog）
 *
 *  这是 M2a 专用装配；M2b 起 Host 改用 lib/runtime.ts 的完整装配。 */

export type FixtureRuntime = {
  runner: SessionRunner;
  eventLog: ReturnType<typeof createSqliteEventLog>;
  probePath: string;
  createSession(): Promise<string>;
};

function probeTool(probePath: string, toolDelayMs: number): ToolDef {
  return {
    id: "probe",
    label: "Probe",
    description: "M2a 探针：写一行到 probe.log（可配置延迟，用于制造执行中窗口）",
    parameters: z.object({ text: z.string().min(1) }),
    permission: () => null,
    contract: { effect: ["workspace"], retrySafety: "never" },
    execute: async (args) => {
      if (toolDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, toolDelayMs));
      appendFileSync(probePath, `${args.text}\n`);
      return { title: "probe", output: `已写入 ${probePath}` };
    },
  };
}

export function createFixtureRuntime(opts: { dataDir: string; workspaceRoot: string; toolDelayMs?: number }): FixtureRuntime {
  mkdirSync(opts.workspaceRoot, { recursive: true });
  const probePath = join(opts.workspaceRoot, "probe.log");
  const toolDelayMs = opts.toolDelayMs ?? 0;

  const store = createSqliteSessionStore({ dataDir: opts.dataDir });
  const eventLog = createSqliteEventLog({ dataDir: opts.dataDir });

  // 脚本按「每 prompt 三轮」循环供给（400 prompts 上限，perf 基线够用）
  const turns = Array.from({ length: 400 * 3 }, (_, i) => {
    const phase = i % 3;
    if (phase === 0) return fauxAssistantMessage([fauxToolCall("probe", { text: "m2a-probe" })]);
    if (phase === 1) return fauxAssistantMessage([fauxToolCall("task_deliver", { summary: "m2a 交付", verification: ["probe.log 已写入"] })]);
    return fauxAssistantMessage("m2a done");
  });
  const faux = createFauxCore({ models: [{ id: "test-model" }] });
  faux.setResponses(turns);

  const workspace = {
    list: async () => [] as { path: string; bytes: number }[],
    read: async () => null,
    write: async (input: { path: string; content: string }) => {
      appendFileSync(join(opts.workspaceRoot, input.path), input.content);
      return { revisionId: "rev", diff: "" };
    },
    edit: async () => {
      throw new Error("M2a fixture 不支持 edit");
    },
  };

  const runner = new SessionRunner({
    store,
    registry: new AgentRegistry(),
    streamFnFor: () => faux.streamSimple as never,
    modelFor: () => faux.getModel() as never,
    eventLog,
    workspaceFor: () => workspace as never,
    // builtinTools 必须保留：task_deliver/task_block 在默认表里，替换掉它们
    // 会让交付声明永远缺席（Completion Gate 打回续跑直到 no_progress 阻塞）。
    tools: [probeTool(probePath, toolDelayMs), ...builtinTools],
    subagentDepth: 1,
  });

  return {
    runner,
    eventLog,
    probePath,
    createSession: async () => {
      const session = await createFrameworkSession({
        store,
        userId: "m2a",
        workspaceId: "m2a-ws",
        model: { providerId: "faux", modelId: "test-model" },
        prompt: "m2a fixture session",
      });
      return session.id;
    },
  };
}
