import { hostGateway } from "@/lib/host-gateway";
import { handleDeliveryAttempt } from "@/lib/delivery-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/deliveries/attempt — body { sessionId, action: begin|verify|finish|accept|
 *  discard|cancel|commands|check }；owner 从 sessionId 推导。armed：网关代理 Host
 *  （/v1/delivery-attempt）；legacy：同一服务进程内执行。 */
export async function POST(request: Request) {
  return (await hostGateway(request)) ?? handleDeliveryAttempt(request);
}
