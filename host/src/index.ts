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
    terminalCreate: async (cwd, cols, rows, command) => {
      const { terminalManager, defaultWorkspaceRoot } = await import("../../lib/runtime.js");
      // command 模式（进程内 /api/terminal 契约：跑命令进程至退出）；
      // 缺省交互 shell（M2b B4 面板终端场景）——两语义经网关透传 body 区分
      return terminalManager().start({
        command: command ?? (process.env.SHELL || "bash"),
        cwd: cwd || defaultWorkspaceRoot,
        ...(cols ? { cols } : {}), ...(rows ? { rows } : {}),
      });
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
    worktreeAction: async (sessionId, action) => {
      // W1-S27 写路径收敛：与 Next 路由共用同一动作层（交付门+整合序列+删序查返回码）
      const { mergeSessionWorkspace, discardSessionWorkspace } = await import("../../lib/workspace-actions.js");
      return action === "merge" ? mergeSessionWorkspace(sessionId) : discardSessionWorkspace(sessionId);
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
