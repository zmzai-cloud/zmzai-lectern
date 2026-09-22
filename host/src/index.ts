import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createFixtureRuntime } from "./runtime.js";
import { startHostServer } from "./server.js";
import type { SessionInfo } from "@zmzai/agent-framework";

/** Host 进程入口（M2a dev 拓扑）。
 *  env: LECTERN_HOST_DATA=<数据目录>（M2a 为 fixture 目录，绝不允许指向生产数据）。
 *  stdout 只输出不含 token 的启动信息——token 只经 host.json 文件通道交给 Next。 */

const dataDir = process.env.LECTERN_HOST_DATA;
if (!dataDir) {
  console.error("[host] LECTERN_HOST_DATA 未设置；M2a 需指向 fixture 数据目录");
  process.exit(1);
}
mkdirSync(dataDir, { recursive: true });

const runtime = createFixtureRuntime({
  dataDir,
  workspaceRoot: process.env.LECTERN_HOST_WORKSPACE ?? join(dataDir, "workspace"),
  toolDelayMs: Number(process.env.LECTERN_HOST_TOOL_DELAY_MS ?? "0"),
});

// B1：真实 runtime 装配（env 必须先于 assembly 导入——dataDir 是模块加载期常量）
process.env.LECTERN_DATA_DIR ??= dataDir;
process.env.LECTERN_WORKSPACE ??= process.env.LECTERN_HOST_WORKSPACE ?? join(dataDir, "workspace");
let realRuntime: { listSessions(filter: { userId: string; workspaceId?: string }): Promise<SessionInfo[]> } | undefined;
try {
  const { runtimeFor, defaultWorkspaceRoot } = await import("./assembly.js");
  const rt = runtimeFor(defaultWorkspaceRoot);
  realRuntime = { listSessions: (filter) => rt.store.listSessions(filter) };
} catch (error) {
  console.error("[host] 真实 runtime 装配失败（只读端点降级）:", error instanceof Error ? error.message : String(error));
}

const host = await startHostServer({ dataDir, runtime, ...(realRuntime ? { realRuntime } : {}) });
console.log(JSON.stringify({ ok: true, port: host.port, hostInstanceId: host.hostInstanceId, hostJson: host.hostJsonPath }));

const shutdown = (signal: string) => {
  void host.close().then(
    () => process.exit(0),
    () => process.exit(0),
  );
  void signal;
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
