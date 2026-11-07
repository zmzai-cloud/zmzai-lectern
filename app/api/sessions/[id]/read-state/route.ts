import { hostGateway } from "@/lib/host-gateway";
import { handleSessionRead } from "@/lib/session-read-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 已读状态：GET 读；PUT 写（lastReadMessageSeq + historyRevision，CAS 冲突 409）。
 *  armed：网关代理 Host（/v1/sessions/:id/read-state）；legacy：同一服务进程内执行。 */
export async function GET(request: Request, _context?: unknown) {
  return (await hostGateway(request)) ?? handleSessionRead(request);
}

export async function PUT(request: Request, _context?: unknown) {
  return (await hostGateway(request)) ?? handleSessionRead(request);
}
