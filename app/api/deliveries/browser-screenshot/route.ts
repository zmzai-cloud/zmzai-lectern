import { hostGateway } from "@/lib/host-gateway";
import { handleBrowserScreenshot } from "@/lib/browser-screenshot-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/deliveries/browser-screenshot?ref=browser-screenshots/<file>.png — 浏览器
 *  验证截图证据（V1-S6，路径守卫防穿越）。armed：网关代理 Host（/v1/browser-screenshot）；
 *  legacy：同一服务进程内执行。 */
export async function GET(request: Request) {
  return (await hostGateway(request)) ?? handleBrowserScreenshot(request);
}
