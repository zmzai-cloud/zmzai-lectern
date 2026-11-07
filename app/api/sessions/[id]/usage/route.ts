import { hostGateway } from "@/lib/host-gateway";
import { handleSessionRead } from "@/lib/session-read-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 会话上下文用量（composer 的上下文条数据源，以最近一次 step-finish 为准）。
 *  armed：网关代理 Host（/v1/sessions/:id/usage）；legacy：同一服务进程内执行。 */
export async function GET(request: Request, _context?: unknown) {
  return (await hostGateway(request)) ?? handleSessionRead(request);
}
