import { hostGateway } from "@/lib/host-gateway";
import { handlePlugins } from "@/lib/plugins-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET 已安装插件清单（全局 + 项目级）；POST 安装（{ sourcePath }）/卸载
 *  （{ action:"uninstall", name }），完成后重扫该项目 MCP。armed：网关在入口固定
 *  活动项目后代理 Host（/v1/plugins）；legacy：同一服务进程内执行。 */
export async function GET(request: Request) {
  return (await hostGateway(request)) ?? handlePlugins(request);
}

export async function POST(request: Request) {
  return (await hostGateway(request)) ?? handlePlugins(request);
}
