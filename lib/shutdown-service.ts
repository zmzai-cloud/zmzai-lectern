import { gracefulShutdown } from './runtime.js';

/** 优雅收尾服务（会话稳定性 P2；P0 2026-11-07 Host 迁移）：中止所有 running 会话
 *  （正常收尾链：tool parts 归 error、事件落库、lease 清除）+ checkpoint 已打开的
 *  SQLite 库。必须在**运行所在进程**执行：armed 下 run 在 Host，此前 Electron 的
 *  before-quit 只打到 Next 进程（空操作），Host 随后被直接结束，运行中任务只能
 *  靠下次启动的租约恢复兜底。挂载路径：进程内 /api/shutdown/graceful（legacy）
 *  与 Host /v1/graceful-shutdown（armed，网关代理）。 */
export async function handleGracefulShutdown(_request: Request): Promise<Response> {
  const { aborted, checkpointed } = await gracefulShutdown();
  return Response.json({ ok: true, aborted, checkpointed });
}
