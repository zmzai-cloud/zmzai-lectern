/** Host 真实 runtime 面（T08 / F05 / PC12，spec 2026-09-28 §4.3）：
 *  会话操作按持久归属解析（sessionRuntime → resolveSessionOwner：重复会话 id
 *  CONFLICT、缺失挂载 RECOVERY_REQUIRED、绝不回落当前项目）；列表全项目聚合
 *  （轻量 projectStore），显式 projectId 时未知项目抛错不返回空成功；MCP 按
 *  项目解析。prompt 命令面走真实 runtime（此前是 M2a fixture 假模型的隐藏
 *  缺口）。从 index.ts 抽出为独立工厂：多项目归属是可测契约。
 *
 *  【env 前置】lib/runtime-constants 在模块加载期读 LECTERN_DATA_DIR——
 *  测试须先设 env 再动态 import 本模块（见 real-runtime.test.ts）。 */
import type { RealRuntimeFace } from "./server.js";
import { sessionRuntime, terminalManager, defaultWorkspaceRoot, workspaceRootForSession } from "../../lib/runtime.js";
import { listProjects, projectStore, registeredProjects } from "../../lib/projects.js";

export function buildRealRuntimeFace(opts: { credentialFor: (sessionId: string) => string | null | undefined }): RealRuntimeFace {
  /** 按会话归属解析 runtime；归属错误原样抛给 server 层映射 HTTP。 */
  const rtOf = (sessionId: string) => sessionRuntime(sessionId);
  const storeOf = (sessionId: string) => rtOf(sessionId).store;
  /** projectId → 项目路径；未知项目抛错（显式归属请求不得静默换项目）。 */
  const projectPathOf = (projectId: string): string => {
    const project = registeredProjects().find((proj) => proj.id === projectId);
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    return project.path;
  };
  return {
  createSession: async (request) => {
    const { handleSessionCreate } = await import("../../lib/session-create-service.js");
    return handleSessionCreate(request);
  },
  browserQa: async (request) => {
    const { handleBrowserQa } = await import("../../lib/browser-qa-service.js");
    return handleBrowserQa(request);
  },
  computerUse: async (request) => {
    const { handleComputerUse } = await import("../../lib/computer-use-service.js");
    return handleComputerUse(request);
  },
  // P0 2026-11-07（route-ownership-matrix）：直通服务族——与 Next legacy 壳
  // 共用同一服务模块，归属在服务内按 sessionId / 网关固定的 projectId 解析
  sessionMutation: async (request) => {
    const { handleSessionMutation } = await import("../../lib/session-mutation-service.js");
    return handleSessionMutation(request);
  },
  fs: async (request) => {
    const { handleFsRequest } = await import("../../lib/fs-service.js");
    return handleFsRequest(request);
  },
  git: async (request) => {
    const { handleGitRequest } = await import("../../lib/git-service.js");
    return handleGitRequest(request);
  },
  deliveryOverview: async (request) => {
    const { handleDeliveryOverview } = await import("../../lib/delivery-service.js");
    return handleDeliveryOverview(request);
  },
  deliveryAttempt: async (request) => {
    const { handleDeliveryAttempt } = await import("../../lib/delivery-service.js");
    return handleDeliveryAttempt(request);
  },
  browserScreenshot: async (request) => {
    const { handleBrowserScreenshot } = await import("../../lib/browser-screenshot-service.js");
    return handleBrowserScreenshot(request);
  },
  preview: async (request) => {
    const { handlePreview } = await import("../../lib/preview-service.js");
    return handlePreview(request);
  },
  plugins: async (request) => {
    const { handlePlugins } = await import("../../lib/plugins-service.js");
    return handlePlugins(request);
  },
  repomap: async (request) => {
    const { handleRepomap } = await import("../../lib/repomap-service.js");
    return handleRepomap(request);
  },
  skills: async (request) => {
    const { handleSkills } = await import("../../lib/skills-service.js");
    return handleSkills(request);
  },
  // 会话读面/事件流/全局搜索：与 Next 壳同一服务、同一 UI 契约（旧读面按早期冒烟
  // 形状实现，形状与 UI 不符；events 旧实现读 fixture 日志）
  sessionRead: async (request) => {
    const { handleSessionRead } = await import("../../lib/session-read-service.js");
    return handleSessionRead(request);
  },
  sessionEvents: async (request) => {
    const { handleSessionEvents } = await import("../../lib/session-events-service.js");
    return handleSessionEvents(request);
  },
  sessionGlobalSearch: async (request) => {
    const { handleSessionGlobalSearch } = await import("../../lib/session-search-service.js");
    return handleSessionGlobalSearch(request);
  },
  // 优雅收尾在 run 所在进程执行（armed 下即 Host）
  gracefulShutdown: async (request) => {
    const { handleGracefulShutdown } = await import("../../lib/shutdown-service.js");
    return handleGracefulShutdown(request);
  },
  // T07（PC10）：命令回执查询——只读 findPrompt，found=true 即已登记
  commandReceipt: async (sessionId: string, requestId: string) => {
    const prior = await storeOf(sessionId).workflow?.findPrompt(sessionId, requestId).catch(() => null);
    if (!prior) return { found: false as const };
    return { found: true as const, receipt: prior.receipt, input: prior.input };
  },
  // T08：prompt 走真实 runtime（此前命令面是 M2a fixture 假模型——F05 的
  // 隐藏缺口：生产 prompt 经 Host 会拿到脚本假响应）
  // 2026-11-12 标题事故：armed 网关下 UI 的 prompt 全部经这里受理，Next 路由
  // （app/api/sessions/[id]/prompt）在打包应用里是死代码——路由里的自动标题
  // /附件解析/skill 解析三块 parity 逻辑从未跑过（侧栏会话永远停留「新会话」）。
  // 这里补齐同套语义；错误用大写码抛出，server 层正则映射回 workflow 契约。
  prompt: async (sessionId: string, input: Record<string, unknown>) => {
    const rt = rtOf(sessionId);
    const text = typeof input.text === "string" ? input.text.trim() : "";

    // 附件 id → 描述符（Next 路由同规则：归属校验 + 就绪检查；失败不进 runner）
    const { attachmentScopeFor, resolveAttachmentRefs } = await import("../../lib/attachments/scope.js");
    const { MAX_ATTACHMENT_REFS } = await import("@zmzai/agent-framework");
    const rawIds = Array.isArray(input.attachmentIds) ? input.attachmentIds.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
    const attachmentIds = [...new Set(rawIds)].slice(0, MAX_ATTACHMENT_REFS);
    const scope = attachmentScopeFor(sessionId);
    const resolved = resolveAttachmentRefs(scope, attachmentIds);
    if (resolved.missing.length > 0) throw new Error("ATTACHMENT_NOT_FOUND");
    if (resolved.notReady.length > 0) throw new Error("ATTACHMENT_NOT_READY");

    // skillId → 描述符（不存在的 skill 明确报错，而非静默忽略）
    let selected: { id: string; name: string; digest: string } | null = null;
    if (typeof input.skillId === "string" && input.skillId) {
      const { loadSkill } = await import("../../lib/skills.js");
      selected = loadSkill(workspaceRootForSession(sessionId), input.skillId);
      if (!selected) throw new Error("SKILL_NOT_FOUND");
    }

    // 自动标题 ①占位：首条消息摘要立即生效（不再叫「新会话」）；②AI 摘要标题
    // 在 prompt 受理后异步覆盖（仅当标题仍是占位——用户手动改名则不覆盖）
    let autoTitleSeed: string | null = null;
    try {
      const ses = await rt.store.getSession(sessionId);
      if (ses && (!ses.title || ses.title === "新会话")) {
        const images = Array.isArray(input.images) ? (input.images as unknown[]) : [];
        const seed = text
          || (resolved.refs.length ? String((resolved.refs[0] as { name?: string }).name ?? "") : "")
          || (images.length ? "[图片消息]" : "");
        if (seed) {
          autoTitleSeed = seed.replace(/\s+/g, " ").slice(0, 30);
          await rt.store.updateSession(sessionId, { title: autoTitleSeed });
        }
      }
    } catch {
      /* 占位标题失败不阻塞发送 */
    }

    // 记忆召回预取（2026-11-13 装配优化）：与 workflow/建档/工具装配并行发起，
    // runLoop 的 memoryContextFor 直接触发 root-goal 缓存命中——冷会话的
    // 1-2s 召回网络往返从装配关键路径上消失。失败无副作用（真实调用照常走）。
    if (text) {
      try {
        const { resolveSessionOwner } = await import("../../lib/session-owner.js");
        const { recallSection } = await import("../../lib/memory/service.js");
        void recallSection(resolveSessionOwner(sessionId).project, sessionId, text).catch(() => undefined);
      } catch { /* 预取失败不影响主链路 */ }
    }

    const runnerInput: Record<string, unknown> = { ...input };
    delete runnerInput.attachmentIds;
    delete runnerInput.skillId;
    if (resolved.refs.length > 0) runnerInput.attachmentRefs = resolved.refs;
    if (selected) runnerInput.skill = { id: selected.id, name: selected.name, digest: selected.digest };
    const receipt = (await rt.runner.prompt(sessionId, runnerInput as never)) as { userMessageId?: string } | null;

    // 附件从「草稿」绑定成「已发送历史」（失败不阻塞——消息已落地）
    if (receipt?.userMessageId) {
      for (const ref of resolved.refs) {
        try { scope.store.bind((ref as { id: string }).id, receipt.userMessageId, sessionId); } catch { /* 绑定失败走草稿 TTL */ }
      }
    }

    // AI 摘要标题②：后台 one-shot 补全不阻塞回执。Host 进程没有请求级 ALS，
    // 凭据经 credentialRef 包 withSessionCredential（provider 请求时动态读
    // currentCookieHeader，ALS 随 async 链路跨 await 存活）。
    // 【等主 run 结束再发】（2026-11-13 断流排查）：此前标题生成与主对话流
    // 并发开两条 SSE 穿 CDN——实测互相干扰断流（02:23-02:25 时间线：标题调用
    // 与主调用同刻各断 1-2 次）。isSessionActive 轮询等主 run 收尾，标题晚
    // 10-30s 无感（侧栏本就 10s 轮询刷新）。
    if (autoTitleSeed && text) {
      const { generateSessionTitle } = await import("../../lib/session-title.js");
      const { withSessionCredential } = await import("../../lib/request-cookie.js");
      const { credentialFor } = await import("./server.js");
      const frameworkRef = await import("@zmzai/agent-framework");
      const model = input.model && typeof input.model === "object" ? (input.model as never) : undefined;
      const fireWhenIdle = async (): Promise<string | null> => {
        const deadline = Date.now() + 10 * 60_000;
        // 两段式（修竞态）：prompt 受理时 runLoop 可能尚未注册 active——直接等
        // idle 会立刻通过，标题又与主对话并发。先等 active=true（最多 10s 兜底：
        // runLoop 启动失败/极短命），再等 active=false。
        let becameActive = false;
        while (Date.now() < deadline) {
          if (frameworkRef.isSessionActive(sessionId)) { becameActive = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (becameActive) {
          while (Date.now() < deadline && frameworkRef.isSessionActive(sessionId)) {
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          }
        }
        return withSessionCredential(credentialFor(sessionId), () => generateSessionTitle(rt as never, sessionId, text, model));
      };
      void fireWhenIdle()
        .then((title) => (title
          ? rt.store.getSession(sessionId).then((ses) => (ses && ses.title === autoTitleSeed ? rt.store.updateSession(sessionId, { title }) : undefined))
          : undefined))
        .catch(() => undefined);
    }
    return receipt;
  },
  // T08：会话列表全项目聚合（轻量 projectStore，不起 runtime/MCP）；
  // 显式 projectId 时只查该项目，未知 projectId 抛错（不静默空列表）
  // T08/T09：会话列表——显式 projectId 只查该项目（未知抛错不空成功）；
  // 无 projectId 全项目聚合（轻量 projectStore，不起 runtime/MCP）。返回
  // UI 的 SessionListItem 完整契约（readState/running/awaitingPermission/
  // messageCount/task/projectId/projectName）——running 态在 Host 进程的
  // activeRuns 里才是真相源（armed 下执行在 Host；Next 进程看不到）。
  listSessions: async (filter: { userId: string; workspaceId?: string; projectId?: string }) => {
    const framework = await import("@zmzai/agent-framework");
    const { toTaskView } = await import("../../lib/task-presentation.js");
    let projects: Awaited<ReturnType<typeof listProjects>>;
    if (filter.projectId) {
      const found = registeredProjects().find((proj) => proj.id === filter.projectId);
      if (!found) throw new Error("PROJECT_NOT_FOUND");
      projects = [found];
    } else {
      projects = listProjects();
    }
    const taskViewFor = async (store: { task?: { getActiveTask(id: string): Promise<unknown>; getLatestTask(id: string): Promise<unknown> } }, sessionId: string) => {
      if (!store.task) return null;
      const record = ((await store.task.getActiveTask(sessionId).catch(() => null)) ?? (await store.task.getLatestTask(sessionId).catch(() => null))) as Parameters<typeof toTaskView>[0] | null;
      return record ? toTaskView(record) : null;
    };
    const merged: Record<string, unknown>[] = [];
    for (const project of projects) {
      try {
        const store = projectStore(project.id);
        const sessions = await store.listSessions({ userId: filter.userId, ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}) });
        const counts = typeof (store as unknown as { countMessagesBySession?: () => Promise<Map<string, number>> }).countMessagesBySession === "function"
          ? await (store as unknown as { countMessagesBySession: () => Promise<Map<string, number>> }).countMessagesBySession()
          : new Map<string, number>();
        for (const s of sessions) {
          merged.push({
            ...s,
            readState: await store.getReadState?.(s.id),
            running: framework.isSessionActive(s.id),
            awaitingPermission: framework.isSessionAwaitingPermission(s.id),
            messageCount: counts.get(s.id) ?? 0,
            task: await taskViewFor(store, s.id),
            projectId: project.id,
            projectName: project.name,
          });
        }
      } catch {
        // 项目库不可读/尚未初始化：该项目无会话是事实，跳过；不掩盖其它项目
      }
    }
    merged.sort((a, b) => String((b as { time?: { updated?: string } }).time?.updated ?? "").localeCompare(String((a as { time?: { updated?: string } }).time?.updated ?? "")));
    return merged;
  },
  abort: (sessionId) => rtOf(sessionId).runner.abort(sessionId),
  resumeTask: (sessionId) => rtOf(sessionId).runner.resumeTask(sessionId),
  compact: (sessionId) => rtOf(sessionId).runner.compactSession(sessionId),
  rewind: async (sessionId, messageId, text) => {
    const { executeRewind } = await import("../../lib/rewind-flow.js");
    const { credentialFor } = await import("./server.js");
    try {
      const outcome = await executeRewind({
        sessionId,
        messageId,
        ...(text ? { text } : {}),
        cookieHeader: credentialFor(sessionId) ?? null,
        runtime: rtOf(sessionId) as never,
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
  terminalCreate: async (cwd, cols, rows, command, sessionId) => {
    const { terminalManager, defaultWorkspaceRoot, workspaceRootForSession } = await import("../../lib/runtime.js");
    // command 模式（进程内 /api/terminal 契约：跑命令进程至退出）；缺省交互
    // shell（M2b B4 面板场景）。cwd 解析与会话对齐：sessionId 优先解析到会话
    // 工作区（armed 下进程内不再代解析——0.10.1 packaged-smoke 第二层暴露）
    const effectiveCwd = cwd || (sessionId ? workspaceRootForSession(sessionId) : defaultWorkspaceRoot);
    return terminalManager().start({
      command: command ?? (process.env.SHELL || "bash"),
      cwd: effectiveCwd,
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
  // T08：MCP 状态按项目解析——显式 projectId 用该项目；缺省用默认项目
  // （UI 侧带 projectId 的完整收敛属 T09）。未知 projectId 抛错不空成功。
  mcpStatus: async (projectId?: string) => {
    const { mcpStatusFor, defaultWorkspaceRoot } = await import("../../lib/runtime.js");
    const state = mcpStatusFor(projectId ? projectPathOf(projectId) : defaultWorkspaceRoot);
    return { statuses: state.statuses, configErrors: state.configErrors, sources: state.sources };
  },
  mcpRescan: async (projectId?: string) => {
    const { mcpRescan, defaultWorkspaceRoot } = await import("../../lib/runtime.js");
    const state = await mcpRescan(projectId ? projectPathOf(projectId) : defaultWorkspaceRoot);
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
    const ownerStore = storeOf(sessionId);
    const fn = ownerStore.markRead;
    if (!fn) return Promise.reject(new Error("NOT_IMPLEMENTED"));
    return fn.call(ownerStore, sessionId, messageSeq, revision);
  },
  replyPermission: (sessionId, requestId, reply, feedback) => rtOf(sessionId).runner.replyPermission(sessionId, requestId, reply as never, feedback),
  messages: async (sessionId) => {
    const ownerStore = storeOf(sessionId);
    const session = await ownerStore.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");
    return ownerStore.getMessages(sessionId);
  },
  search: (sessionId, query, limit) => {
    const ownerStore = storeOf(sessionId);
    const fn = ownerStore.searchMessages;
    if (!fn) throw new Error("NOT_IMPLEMENTED");
    return fn.call(ownerStore, sessionId, { query, limit });
  },
  readState: (sessionId) => {
    const ownerStore = storeOf(sessionId);
    const fn = ownerStore.getReadState;
    if (!fn) throw new Error("NOT_IMPLEMENTED");
    return fn.call(ownerStore, sessionId);
  },
  usage: async (sessionId) => {
    const ownerStore = storeOf(sessionId);
    const session = await ownerStore.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");
    const entries = await ownerStore.getMessages(sessionId);
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
}
