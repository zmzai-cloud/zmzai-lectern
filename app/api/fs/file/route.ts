import { hostGateway } from "@/lib/host-gateway";
import { handleFsRequest } from "@/lib/fs-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/fs/file?path= — 工作区文件文本预览（限 512KB，二进制以 binary:true 表达）；
 *  PUT — 编辑器保存回写。armed：网关代理 Host（/v1/fs/file）；legacy：同一服务进程内执行。 */
export async function GET(request: Request) {
  return (await hostGateway(request)) ?? handleFsRequest(request);
}

export async function PUT(request: Request) {
  return (await hostGateway(request)) ?? handleFsRequest(request);
}
