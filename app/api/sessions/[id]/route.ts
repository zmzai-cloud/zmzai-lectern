import { hostGateway } from "@/lib/host-gateway";
import { handleSessionMutation } from "@/lib/session-mutation-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** PATCH/DELETE /api/sessions/[id] — 重命名/置顶/归档/权限模式 与 删除。
 *  armed：网关代理 Host（/v1/sessions/:id）；启动锁定 legacy：同一服务进程内执行
 *  （lib/session-mutation-service，归属按会话持久归属解析）。 */
export async function PATCH(request: Request, _context?: unknown) {
  return (await hostGateway(request)) ?? handleSessionMutation(request);
}

export async function DELETE(request: Request, _context?: unknown) {
  return (await hostGateway(request)) ?? handleSessionMutation(request);
}
