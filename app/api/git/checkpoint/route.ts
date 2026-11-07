import { hostGateway } from "@/lib/host-gateway";
import { handleGitRequest } from "@/lib/git-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET 列检查点 / POST 打快照 / PUT 硬回滚（UI 侧二次确认）。
 *  armed：网关代理 Host（/v1/git/checkpoint）；legacy：同一服务进程内执行。 */
export async function GET(request: Request) {
  return (await hostGateway(request)) ?? handleGitRequest(request);
}

export async function POST(request: Request) {
  return (await hostGateway(request)) ?? handleGitRequest(request);
}

export async function PUT(request: Request) {
  return (await hostGateway(request)) ?? handleGitRequest(request);
}
