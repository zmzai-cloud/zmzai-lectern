import { hostGateway } from "@/lib/host-gateway";
import { handlePreview } from "@/lib/preview-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 工作区成果文件服务（真实 URL 预览，相对资源同路由解析；sessionId 在路径内，
 *  后续资源请求命中同一隔离 worktree）。armed：网关代理 Host（/v1/preview/...）；
 *  legacy：同一服务进程内执行。 */
export async function GET(request: Request, _context?: unknown) {
  return (await hostGateway(request)) ?? handlePreview(request);
}
