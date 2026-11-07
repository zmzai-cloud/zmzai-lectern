import { hostGateway } from "@/lib/host-gateway";
import { handleSessionGlobalSearch } from "@/lib/session-search-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 会话全文搜索（跨项目子串匹配，每会话首个命中，上限 30）。
 *  armed：网关代理 Host（/v1/session-search）；legacy：同一服务进程内执行。 */
export async function GET(request: Request) {
  return (await hostGateway(request)) ?? handleSessionGlobalSearch(request);
}
