import { hostGateway } from "@/lib/host-gateway";
import { handleGitRequest } from "@/lib/git-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/git/diff — 工作区未提交变更 diff（审查 Tab 数据源，非 git 仓库 available:false）。
 *  armed：网关代理 Host（/v1/git/diff）；legacy：同一服务进程内执行。 */
export async function GET(request: Request) {
  return (await hostGateway(request)) ?? handleGitRequest(request);
}
