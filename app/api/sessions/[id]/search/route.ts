import { hostGateway } from "@/lib/host-gateway";
import { handleSessionRead } from "@/lib/session-read-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 会话内全文搜索（游标绑定 sessionId/query/revision）。
 *  armed：网关代理 Host（/v1/sessions/:id/search）；legacy：同一服务进程内执行。 */
export async function GET(request: Request, _context?: unknown) {
  return (await hostGateway(request)) ?? handleSessionRead(request);
}
