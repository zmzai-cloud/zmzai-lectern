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
    attachmentUpload: async (sessionId, input) => {
      const { attachmentScopeFor } = await import("../../lib/attachments/scope.js");
      const scope = attachmentScopeFor(sessionId);
      const kind = /^image\//.test(input.mediaType) ? "image" : input.mediaType === "text/plain" || input.mediaType === "text/markdown" ? "text" : "document";
      return scope.store.put({ ...input, kind, sessionId: scope.sessionId } as never) as unknown;
    },
    attachmentReceipt: async (sessionId, attachmentId) => {
      const { attachmentScopeFor } = await import("../../lib/attachments/scope.js");
      const scope = attachmentScopeFor(sessionId);
      const record = scope.store.getScoped(attachmentId, scope.sessionId);
      if (!record) return { kind: "not_found" };
      return { kind: "receipt", attachment: record, availability: scope.store.blobExists(record.id) };
    },
    attachmentRaw: async (sessionId, attachmentId, download) => {
      const { attachmentScopeFor } = await import("../../lib/attachments/scope.js");
      const scope = attachmentScopeFor(sessionId);
      const record = scope.store.getScoped(attachmentId, scope.sessionId);
      if (!record) return { kind: "not_found" as const, message: "附件不存在或不属于该会话", status: 404 };
      const opened = scope.store.open(record.id);
      if (!opened) return { kind: "gone" as const, message: "附件文件已不可用", status: 410 };
      const inline = /^(text\/plain|text\/markdown|image\/png|image\/jpeg|image\/webp|application\/pdf)$/i.test(record.mediaType);
      return { kind: "raw" as const, mediaType: record.mediaType, size: record.size, filename: record.filename, disposition: download || !inline ? "attachment" : "inline", stream: opened.stream };
    },
    terminalList: async () => {
      const { terminalManager } = await import("../../lib/runtime.js");
      return terminalManager().list();
    },
    terminalCreate: async (cwd, cols, rows) => {
      const { terminalManager, defaultWorkspaceRoot } = await import("../../lib/runtime.js");
      return terminalManager().start({ command: process.env.SHELL ?? "bash", cwd: cwd || defaultWorkspaceRoot, ...(cols ? { cols } : {}), ...(rows ? { rows } : {}) });
    },
    terminalOp: async (id, op, payload) => {
      const { terminalManager } = await import("../../lib/runtime.js");
      const mgr = terminalManager();
      if (op === "write") return { ok: mgr.write(id, String((payload as { data?: string } | undefined)?.data ?? "")) };
      if (op === "resize") { mgr.resize(id, Math.floor(Number((payload as { cols?: number } | undefined)?.cols ?? 80)), Math.floor(Number((payload as { rows?: number } | undefined)?.rows ?? 24))); return { ok: true }; }
      if (op === "kill") { mgr.kill(id); return { ok: true }; }
      if (op === "read") return mgr.read(id);
      // readAll = 大游标 read（ring 全量）
      return mgr.read(id, 0);
    },
    mcpStatus: async () => {
      const { mcpStatusFor, defaultWorkspaceRoot } = await import("../../lib/runtime.js");
      const state = mcpStatusFor(defaultWorkspaceRoot);
      return { statuses: state.statuses, configErrors: state.configErrors, sources: state.sources };
    },
    mcpRescan: async () => {
      const { mcpRescan, defaultWorkspaceRoot } = await import("../../lib/runtime.js");
      const state = await mcpRescan(defaultWorkspaceRoot);
      return { statuses: state.statuses, configErrors: state.configErrors, sources: state.sources };
    },
    worktreeStatus: async (sessionId) => {
      const { workspaceRootForSession } = await import("../../lib/runtime.js");
      const { worktreeForSession, worktreeCommits } = await import("../../lib/worktree.js");
      workspaceRootForSession(sessionId);
      const wt = worktreeForSession(sessionId);
      if (!wt) return { enabled: false };
      return { enabled: true, path: wt.path, branch: wt.branch, commits: await worktreeCommits(sessionId) };
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
