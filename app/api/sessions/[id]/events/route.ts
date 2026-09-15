import { withWorkflowErrors } from "@/lib/workflow-error";
import { type NextRequest } from "next/server";

import { subscribeEventLog } from "@zmzai/agent-framework";

import { sessionRuntime } from "@/lib/runtime";
import { WorkflowError } from "@/lib/workflow-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 15_000;

/**
 * SSE 事件流：UI 的 window.lecternNative.subscribe 同构替代（EventSource）。
 *
 * 断线续传：`?since=<seq>` 从该序号之后重放（subscribeEventLog 的 sinceSeq
 * 重放 + live 合并），客户端重连时带上最后收到的 seq 即可无缺口恢复。
 * 每帧写 `id: <seq>`；每 15s 发注释帧保活，防代理/系统休眠切断空闲连接
 * （注释帧不触发 EventSource.onmessage，纯保活）。
 */
async function handleGET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runtime = sessionRuntime(id);
  const encoder = new TextEncoder();

  const sinceRaw = Number(new URL(request.url).searchParams.get("since") ?? "0");
  const sinceSeq = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
  const latestSeq = await runtime.eventLog.count(id);
  if (sinceSeq > latestSeq) throw new WorkflowError("CONFLICT","事件水位已失效，请重新加载会话快照",409,true);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          /* stream 已关闭 */
        }
      }, HEARTBEAT_MS);
      try {
        for await (const ev of subscribeEventLog(runtime.eventLog, id, { signal: request.signal, sinceSeq })) {
          controller.enqueue(encoder.encode(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`));
        }
      } catch {
        /* 客户端断开等异常：直接结束流 */
      } finally {
        clearInterval(heartbeat);
      }
      try {
        controller.close();
      } catch {
        /* 已关闭则忽略 */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

export const GET = withWorkflowErrors(handleGET);
