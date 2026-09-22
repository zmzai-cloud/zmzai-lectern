import { mkdirSync } from "node:fs";
import { startHostServer } from "./server.js";

/** Host 进程入口（M2a dev 拓扑）。
 *  env: LECTERN_HOST_DATA=<数据目录>（M2a 为 fixture 目录，绝不允许指向生产数据）。
 *  stdout 只输出不含 token 的启动信息——token 只经 host.json 文件通道交给 Next。 */

const dataDir = process.env.LECTERN_HOST_DATA;
if (!dataDir) {
  console.error("[host] LECTERN_HOST_DATA 未设置；M2a 需指向 fixture 数据目录");
  process.exit(1);
}
mkdirSync(dataDir, { recursive: true });

const host = await startHostServer({ dataDir });
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
