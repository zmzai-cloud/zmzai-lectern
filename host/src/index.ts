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
mkdirSync(dataDir, { recursive: true });

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
  const { runtimeFor, defaultWorkspaceRoot, setSessionCredentialProvider } = await import("./assembly.js");
  const { credentialFor } = await import("./server.js");
  setSessionCredentialProvider(credentialFor);
  const rt = runtimeFor(defaultWorkspaceRoot);
  const store = rt.store;
  realRuntime = {
    listSessions: (filter) => store.listSessions(filter),
    abort: (sessionId) => rt.runner.abort(sessionId),
    resumeTask: (sessionId) => rt.runner.resumeTask(sessionId),
    compact: (sessionId) => rt.runner.compactSession(sessionId),
    rewind: async (sessionId, messageId, text) => {
      const { executeRewind } = await import("../../lib/rewind-flow.js");
      const { credentialFor } = await import("./server.js");
      try {
        const outcome = await executeRewind({
          sessionId,
          messageId,
          ...(text ? { text } : {}),
          cookieHeader: credentialFor(sessionId) ?? null,
          runtime: rt as never,
        });
        return outcome.ok ? { ok: true } : { ok: false, status: outcome.status, error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}) };
      } catch (error) {
        return { ok: false, status: 500, error: error instanceof Error ? error.message : String(error) };
      }
    },
    markRead: (sessionId, messageSeq, revision) => {
      const fn = store.markRead;
      if (!fn) return Promise.reject(new Error("NOT_IMPLEMENTED"));
      return fn.call(store, sessionId, messageSeq, revision);
    },
    replyPermission: (sessionId, requestId, reply, feedback) => rt.runner.replyPermission(sessionId, requestId, reply as never, feedback),
    messages: async (sessionId) => {
      const session = await store.getSession(sessionId);
      if (!session) throw new Error("SESSION_NOT_FOUND");
      return store.getMessages(sessionId);
    },
    search: (sessionId, query, limit) => {
      const fn = store.searchMessages;
      if (!fn) throw new Error("NOT_IMPLEMENTED");
      return fn.call(store, sessionId, { query, limit });
    },
    readState: (sessionId) => {
      const fn = store.getReadState;
      if (!fn) throw new Error("NOT_IMPLEMENTED");
      return fn.call(store, sessionId);
    },
    usage: async (sessionId) => {
      const session = await store.getSession(sessionId);
      if (!session) throw new Error("SESSION_NOT_FOUND");
      const entries = await store.getMessages(sessionId);
      let input = 0, output = 0, messages = 0;
      for (const { info } of entries) {
        messages += 1;
        const tokens = (info as { tokens?: { input?: number; output?: number } }).tokens;
        input += tokens?.input ?? 0;
        output += tokens?.output ?? 0;
      }
      return { messages, tokens: { input, output, total: input + output } };
    },
  };
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
