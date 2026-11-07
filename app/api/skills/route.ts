import { hostGateway } from "@/lib/host-gateway";
import { handleSkills } from "@/lib/skills-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Lists metadata only; bodies require an explicit selected id.
 *  armed：网关代理 Host（/v1/skills）；legacy：同一服务进程内执行。 */
export async function GET(request: Request) {
  return (await hostGateway(request)) ?? handleSkills(request);
}
