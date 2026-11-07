import { hostGateway } from "@/lib/host-gateway";
import { handleGracefulShutdown } from "@/lib/shutdown-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 优雅收尾（会话稳定性 P2）：Electron 主进程 before-quit 时经 HTTP 调用，中止所有
 *  running 会话（正常收尾链）+ checkpoint 已打开 SQLite 库，再杀子进程。
 *  armed：网关代理 Host（run 在 Host 执行，收尾必须在那里做）；legacy：进程内执行。 */
export async function POST(request: Request) {
  return (await hostGateway(request)) ?? handleGracefulShutdown(request);
}
