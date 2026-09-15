import { withWorkflowErrors } from "@/lib/workflow-error";
import { NextResponse } from "next/server";

import { capsFor } from "@/lib/model-caps";
import { sessionRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type UsageInfo = {
  used: number;
  contextWindow: number;
  input: number;
  output: number;
  cacheRead: number;
  steps: number;
};

type TokenShape = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

/** 兼容两种事件形状（tokens 在事件本体或 data 里）。 */
function tokensOf(event: { type?: string; tokens?: TokenShape; data?: unknown }): TokenShape | null {
  if (event.type !== "step-finish") return null;
  if (event.tokens) return event.tokens;
  const data = event.data as { tokens?: TokenShape } | undefined;
  return data?.tokens ?? null;
}

/** 该会话的上下文窗口：env 显式覆盖 → 模型目录真实值 → 128k 默认。
 *  旧实现恒取 env/128k，导致模型选择器显示「· 200k」而占用条按 128k 算——
 *  百分比失真。env 优先保留在手，便于压测/兜底时人工统一压低。 */
async function contextWindowFor(sessionId: string, runtime: ReturnType<typeof sessionRuntime>): Promise<number> {
  const override = Number(process.env.LECTERN_CONTEXT_WINDOW ?? process.env.HARNESS_CONTEXT_WINDOW);
  if (Number.isFinite(override) && override > 0) return override;
  try {
    const session = await runtime.store.getSession(sessionId);
    const real = capsFor(session?.model?.modelId)?.contextWindow;
    if (typeof real === "number" && real > 0) return real;
  } catch {
    // 会话不存在 / store 不可读：回落默认，不影响占用条返回
  }
  return 128_000;
}

/** 会话上下文用量（composer 的上下文条数据源）。
 *  语义：以最近一次 step-finish 为准——LLM 每次请求的 input 即全量上下文，
 *  input + cacheRead + output ≈ 当前窗口占用。事件日志在内存（重启归零，UI 显示 0%）。 */
async function handleGET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runtime = sessionRuntime(id);
  const contextWindow = await contextWindowFor(id, runtime);
  try {
    const events = await runtime.eventLog.read(id, 0, 5000);
    let last: TokenShape | null = null;
    let steps = 0;
    for (const event of events as Array<{ type?: string; tokens?: TokenShape; data?: unknown }>) {
      const tokens = tokensOf(event);
      if (tokens) {
        last = tokens;
        steps += 1;
      }
    }
    if (!last) {
      return NextResponse.json({ used: 0, contextWindow, input: 0, output: 0, cacheRead: 0, steps: 0 } satisfies UsageInfo);
    }
    const input = last.input ?? 0;
    const output = last.output ?? 0;
    const cacheRead = last.cacheRead ?? 0;
    return NextResponse.json({
      used: input + output + cacheRead,
      contextWindow,
      input,
      output,
      cacheRead,
      steps,
    } satisfies UsageInfo);
  } catch {
    return NextResponse.json({ used: 0, contextWindow, input: 0, output: 0, cacheRead: 0, steps: 0 } satisfies UsageInfo);
  }
}

export const GET = withWorkflowErrors(handleGET);
