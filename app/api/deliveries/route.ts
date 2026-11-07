import { hostGateway } from "@/lib/host-gateway";
import { handleDeliveryOverview } from "@/lib/delivery-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/deliveries?sessionId= — 交付概览（delivery + active attempt + 命令记录）。
 *  owner 由 sessionId 服务端推导。armed：网关代理 Host（/v1/delivery-overview）；
 *  legacy：同一服务进程内执行。 */
export async function GET(request: Request) {
  return (await hostGateway(request)) ?? handleDeliveryOverview(request);
}
