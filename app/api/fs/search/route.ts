import { hostGateway } from "@/lib/host-gateway";
import { handleFsRequest } from "@/lib/fs-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/fs/search?q= — 递归文件名搜索（⌘P 文件快开）。
 *  armed：网关代理 Host（/v1/fs/search）；legacy：同一服务进程内执行。 */
export async function GET(request: Request) {
  return (await hostGateway(request)) ?? handleFsRequest(request);
}
