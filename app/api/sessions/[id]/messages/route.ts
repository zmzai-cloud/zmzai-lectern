import { hostGateway } from "@/lib/host-gateway";
import { handleSessionRead } from "@/lib/session-read-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 跨会话恢复：读取某会话已持久化的转录（view=window 稳定游标快照；tail/skip 兼容旧客户端）。
 *  armed：网关代理 Host（/v1/sessions/:id/messages）；legacy：同一服务进程内执行。 */
export async function GET(request: Request, _context?: unknown) {
  return (await hostGateway(request)) ?? handleSessionRead(request);
}
