import { hostGateway } from "@/lib/host-gateway";
import { handleFsRequest } from "@/lib/fs-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/fs/tree?path= — 工作区目录一层内容（懒加载目录树）。
 *  armed：网关代理 Host（/v1/fs/tree）；legacy：同一服务进程内执行。 */
export async function GET(request: Request) {
  return (await hostGateway(request)) ?? handleFsRequest(request);
}
