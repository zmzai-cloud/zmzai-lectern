import { hostGateway } from "@/lib/host-gateway";
import { handleSessionEvents } from "@/lib/session-events-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * SSE 事件流：UI 的 window.lecternNative.subscribe 同构替代（EventSource）。
 * 断线续传 `?since=<seq>`；每帧 `id: <seq>`；15s 注释帧保活。
 *
 * armed：网关代理 Host（/v1/events，按会话持久归属取事件日志——run 在 Host 执行，
 * live 扇出只在 Host 进程触发，经 Host 订阅才有实时推送）；legacy：同一服务进程内执行。
 */
export async function GET(request: Request, _context?: unknown) {
  return (await hostGateway(request)) ?? handleSessionEvents(request);
}
