import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createFixtureRuntime } from "./runtime.js";
import { startHostServer } from "./server.js";
import type { RealRuntimeFace } from "./server.js";

/** Host 进程入口（M2a dev 拓扑）。
 *  env: LECTERN_HOST_DATA=<数据目录>（M2a 为 fixture 目录，绝不允许指向生产数据）。
 *  stdout 只输出不含 token 的启动信息——token 只经 host.json 文件通道交给 Next。 */

const dataDir = process.env.LECTERN_HOST_DATA;
if (!dataDir) {
  console.error("[host] LECTERN_HOST_DATA 未设置；M2a 需指向 fixture 数据目录");
  process.exit(1);
}
// PTY 诊断开关（0.10.2 打包排查用）：LECTERN_HOST_PTY_DIAG=1 时在真实 Host
// 进程里完整走一遍 node-pty 解析 + spawn（裸解析与显式路径两种模式），把每步
// 结果/错误栈打到 stderr（main.cjs 合流进 <userData>/logs/web.log）。正常发布
// 不带该 env，零开销。
if (process.env.LECTERN_HOST_PTY_DIAG === "1") {
  await (async () => {
    const { createRequire } = await import("node:module");
    const { join } = await import("node:path");
    const attempt = (label: string, req: NodeJS.Require): number => {
      try {
        const pty = req("node-pty");
        const term = pty.spawn("/bin/echo", ["diag-ok"], { name: "xterm", cols: 20, rows: 5, cwd: dataDir });
        return term.pid ?? -1;
      } catch (error) {
        console.error(`[pty-diag:${label}] FAILED:`, error instanceof Error ? (error.stack ?? error.message) : String(error));
        return -1;
      }
    };
    console.error("[pty-diag] ZMZAI_PTY_MODULE_PATH =", process.env.ZMZAI_PTY_MODULE_PATH ?? "(unset)");
    attempt("bare", createRequire(import.meta.url));
    if (process.env.ZMZAI_PTY_MODULE_PATH) {
      attempt("explicit", createRequire(join(process.env.ZMZAI_PTY_MODULE_PATH, "package.json")));
    }
    process.exit(45);
  })();
}
mkdirSync(dataDir, { recursive: true });

// host.lock 互斥（spec §5.1）：活锁（进程在且 health 可达）拒绝启动；
// 探测必须先于 startHostServer——否则第二实例会绑端口并覆盖 host.json，
// 污染第一实例的握手文件（M2c-S13 冒烟抓到的顺序 bug）。
import { probeLiveLock } from "./server.js";
const lockPath = join(dataDir, "host.lock");
const live = await probeLiveLock(lockPath);
if (live.alive) {
  console.error(JSON.stringify({ ok: false, error: "HOST_LOCKED", detail: live.detail }));
  process.exit(1);
}

const runtime = createFixtureRuntime({
  dataDir,
  workspaceRoot: process.env.LECTERN_HOST_WORKSPACE ?? join(dataDir, "workspace"),
  toolDelayMs: Number(process.env.LECTERN_HOST_TOOL_DELAY_MS ?? "0"),
});

// B1：真实 runtime 装配（env 必须先于 assembly 导入——dataDir 是模块加载期常量）
process.env.LECTERN_DATA_DIR ??= dataDir;
process.env.LECTERN_WORKSPACE ??= process.env.LECTERN_HOST_WORKSPACE ?? join(dataDir, "workspace");
let realRuntime: RealRuntimeFace | undefined;
try {
  const { setSessionCredentialProvider } = await import("./assembly.js");
  const { buildRealRuntimeFace } = await import("./real-runtime.js");
  const { credentialFor } = await import("./server.js");
  setSessionCredentialProvider(credentialFor);
  // T08（F05/PC12）：真实 runtime 面按会话归属/项目解析（见 real-runtime.ts）
  realRuntime = buildRealRuntimeFace({ credentialFor });
} catch (error) {
  console.error("[host] 真实 runtime 装配失败（只读端点降级）:", error instanceof Error ? error.message : String(error));
}

const host = await startHostServer({ dataDir, runtime, ...(realRuntime ? { realRuntime } : {}) });

// 本实例获得数据目录：写锁（token 供后续实例探测本实例健康），退出时删除
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
writeFileSync(lockPath, JSON.stringify({ pid: process.pid, hostInstanceId: host.hostInstanceId, port: host.port, token: host.token, startedAt: new Date().toISOString() }));
const removeLock = () => { try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch { /* 尽力而为 */ } };


let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  void signal;
  // 有序停止（spec §5.2）：close() 停止接收新命令；已建 HTTP keep-alive 连接
  // 由 close 强制断开。任务树/终端/租约的收尾在进程退出钩子里尽力完成——
  // SQLite 侧崩溃恢复（registerLeaseRecovery）兜底中断现场。
  void (async () => {
    try {
      if (realRuntime) {
        const { terminalManager } = await import("../../lib/runtime.js");
        terminalManager().disposeAll();
      }
    } catch { /* 尽力而为 */ }
    removeLock();
    await host.close().catch(() => undefined);
    process.exit(0);
  })();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("exit", removeLock);
