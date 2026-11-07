import { withWorkflowErrors, WorkflowError } from './workflow-error.js';
import { subscribeEventLog } from '@zmzai/agent-framework';

import { sessionRuntime } from './runtime.js';

/** 会话事件流服务（SSE；P0 2026-11-07 Host 迁移，route-ownership-matrix）。
 *
 *  断线续传：?since=<seq> 从该序号之后重放（subscribeEventLog 的 sinceSeq 重放 +
 *  live 合并）；每帧 `id: <seq>`；每 15s 注释帧保活。水位超过最新 seq 显式 409。
 *
 *  背景：subscribeEventLog 是「进程内 listener 实时扇出 + 1s SQLite 轮询兜底」。
 *  armed 下 run 在 Host 执行、通知只在 Host 进程触发；此前事件流仍由 Next 进程
 *  服务，订阅端没有 live listener，打包产物的流式输出退化为约 1 秒一批的轮询。
 *  Host 旧版 /v1/events 读的是 fixture runtime 的日志（非会话所属 runtime），
 *  因此也不能直接打开网关——收敛为本服务后按会话持久归属取事件日志。
 *
 *  挂载路径：进程内 /api/sessions/:id/events（legacy）与 Host /v1/events?sessionId=。 */

const HEARTBEAT_MS = 15_000;

function sessionIdOf(url: URL): string | null {
  const m = /^\/api\/sessions\/([^/]+)\/events$/.exec(url.pathname);
  if (m) return decodeURIComponent(m[1]!);
  if (url.pathname === '/v1/events') return url.searchParams.get('sessionId');
  return null;
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = sessionIdOf(url);
  if (!id) throw new WorkflowError('INVALID_INPUT', 'sessionId 必填', 400);
  const runtime = sessionRuntime(id);
  const encoder = new TextEncoder();

  const sinceRaw = Number(url.searchParams.get('since') ?? '0');
  const sinceSeq = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
  const latestSeq = await runtime.eventLog.count(id);
  if (sinceSeq > latestSeq) throw new WorkflowError('CONFLICT', '事件水位已失效，请重新加载会话快照', 409, true);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
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
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}

export const handleSessionEvents = withWorkflowErrors(handle);
