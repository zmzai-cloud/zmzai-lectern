import { hostGateway } from "@/lib/host-gateway";
import { handleRepomap } from "@/lib/repomap-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/repomap?focus=&paths=&tokenBudget= — 项目地图（与 agent 的 repo_map
 *  工具同源同缓存）。armed：网关在入口固定活动项目后代理 Host（/v1/repomap）；
 *  legacy：同一服务进程内执行。 */
export async function GET(request: Request) {
  return (await hostGateway(request)) ?? handleRepomap(request);
}
