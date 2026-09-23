import type {
  AgentInfo,
  AttachmentReceipt,
  AuthStatus,
  CommandRunView,
  DeliveryAttempt,
  DeliveryOverview,
  FailoverEndpointView,
  FailoverEventView,
  FileView,
  GitDiff,
  LecternEvent,
  KeyStatus,
  McpStatuses,
  ModelRef,
  ModelsState,
  PluginInfo,
  PermissionSettings,
  Project,
  RelayKeyInfo,
  ProjectsState,
  SessionInfo,
  SessionListItem,
  SessionIsolation,
  SkillOption,
  TerminalChunk,
  TerminalListResult,
  TerminalSession,
  ThinkingEffort,
  TranscriptMessage,
  TreeNode,
  UsageInfo,
  PromptDisposition,
  TaskRecordView,
} from "./types.js";
import type { PermissionMode } from "./permission-mode.js";

/**
 * 浏览器端 API 客户端：Web 与 Electron 共用同一套页面、同一套 HTTP 接口。
 * 替代旧版 window.harness（IPC），同构后 UI 不再感知宿主差异。
 */
/** SSE 连接状态：connected 正常 / reconnecting 退避重连中 / offline 连续失败待手动。 */
export type ConnectionState = "connected" | "reconnecting" | "offline";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    // 业务错误走 400+文案；裸 5xx（body 非 JSON）= 服务端未捕获异常，指到日志
    if (!body?.error && res.status >= 500) {
      throw new Error(`服务异常（${res.status}）：服务端未捕获错误，详情见运行日志（账户菜单 → 打开日志文件夹）`);
    }
    throw Object.assign(new Error(body?.error ?? `请求失败（${res.status}）`), { status: res.status });
  }
  return res.json() as Promise<T>;
}

const post = (path: string, body?: unknown) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const send = (method: string, path: string, body?: unknown) =>
  fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** 上传失败的统一错误形状：带上传接口返回的 code，便于 UI 决定是否可重试（规格 §14）。 */
export type UploadFailure = Error & { status?: number; code?: string };

/**
 * 单文件上传走 XHR 而不是 fetch：`fetch` 至今没有上传进度事件，而附件卡必须显示
 * 上传进度（规格 §7.4）。这里只用到 `upload.onprogress` 与 `abort()` 两个能力。
 */
function uploadFile(
  sessionId: string,
  file: File,
  options: { signal?: AbortSignal; onProgress?: (ratio: number) => void } = {},
): Promise<AttachmentReceipt> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/sessions/${encodeURIComponent(sessionId)}/attachments`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      // 注意：这里必须用具名类型而不是 `as typeof parsed`——后者会取到赋值点已被
      // 收窄成 null 的类型，把整个响应体变成 never，编译期就再也读不出字段。
      type UploadResponse = { attachment?: AttachmentReceipt; error?: string; code?: string };
      let parsed: UploadResponse | null = null;
      try {
        parsed = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        parsed = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && parsed?.attachment) {
        resolve(parsed.attachment);
        return;
      }
      reject(Object.assign(new Error(parsed?.error ?? `上传失败（${xhr.status}）`), { status: xhr.status, code: parsed?.code ?? "server" }));
    };
    xhr.ontimeout = () => reject(Object.assign(new Error("上传超时"), { code: "network" }));
    xhr.onabort = () => reject(Object.assign(new Error("上传已取消"), { code: "aborted" }));
    const abort = () => xhr.abort();
    options.signal?.addEventListener("abort", abort);
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    xhr.onloadend = cleanup;
    xhr.onerror = () => {
      cleanup();
      reject(Object.assign(new Error("网络中断，上传失败"), { code: "network" }));
    };
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

export const client = {
  authStatus: () => fetch("/api/auth/status").then((r) => j<AuthStatus>(r)),

  authLogout: () => post("/api/auth/logout").then((r) => j<{ ok: boolean }>(r)),

  login: (email: string, password: string) =>
    post("/api/auth/login", { email, password }).then((r) => j<{ error?: string }>(r)),

  listAgents: () => fetch("/api/agents").then((r) => j<AgentInfo[]>(r)),

  /** 会话列表：all=true 跨项目聚合（附带 projectId/projectName 归属，按更新时间排序）。 */
  listSessions: (all = false) =>
    fetch(all ? "/api/sessions?all=1" : "/api/sessions").then((r) => j<SessionListItem[]>(r)),

  /** 会话全文搜索（消息文本 + 工具摘要），每会话取首个命中。 */
  searchSessions: (q: string) =>
    fetch(`/api/sessions/search?q=${encodeURIComponent(q)}`)
      .then((r) => j<{ query: string; results: { projectId: string; projectName: string; sessionId: string; title: string; snippet: string }[] }>(r)),

  createSession: (agent?: string, model?: ModelRef, isolate?: boolean, requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`) =>
    post("/api/sessions", { agent, model, isolate, requestId }).then((r) => j<SessionListItem>(r)),

  /** 会话 worktree 隔离状态（隔离副本会话 → { enabled: true, path, branch }）。 */
  worktreeStatus: (sessionId: string) =>
    fetch(`/api/sessions/${sessionId}/worktree`).then((r) => j<SessionIsolation & { commits?: number }>(r)),

  /** worktree 合并回主工作区（merge）或丢弃隔离副本（discard）。 */
  worktreeAction: (sessionId: string, action: "merge" | "discard") =>
    post(`/api/sessions/${sessionId}/worktree`, { action }).then((r) =>
      j<{ ok: boolean; output?: string; conflicts?: string[]; error?: string }>(r),
    ),

  renameSession: (sessionId: string, title: string) =>
    send("PATCH", `/api/sessions/${sessionId}`, { title }).then((r) => j<{ ok?: boolean; error?: string }>(r)),

  /** 置顶/取消置顶（N6）：置顶会话排列表最前。 */
  setSessionPinned: (sessionId: string, pinned: boolean) =>
    send("PATCH", `/api/sessions/${sessionId}`, { pinned }).then((r) => j<{ ok?: boolean; error?: string }>(r)),

  /** 归档/取消归档（N6）：归档会话从默认列表隐藏。 */
  setSessionArchived: (sessionId: string, archived: boolean) =>
    send("PATCH", `/api/sessions/${sessionId}`, { archived }).then((r) => j<{ ok?: boolean; error?: string }>(r)),

  /** 会话级权限模式（Codex 基准 ④）：default/full/ask/readonly，落 session.permission 规则。 */
  setPermissionMode: (sessionId: string, mode: PermissionMode) =>
    send("PATCH", `/api/sessions/${sessionId}`, { permissionMode: mode }).then((r) => j<{ ok?: boolean; error?: string }>(r)),

  deleteSession: (sessionId: string) =>
    send("DELETE", `/api/sessions/${sessionId}`).then((r) => j<{ ok?: boolean; error?: string }>(r)),

  /** 稳定消息窗口：游标绑定 session + messageSeq + historyRevision。 */
  getReadState: (sessionId: string, signal?: AbortSignal) => fetch(`/api/sessions/${encodeURIComponent(sessionId)}/read-state`, { signal }).then(r => j<import("./types.js").ReadState>(r)),
  markRead: (sessionId: string, lastReadMessageSeq: number, historyRevision: number, signal?: AbortSignal) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/read-state`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lastReadMessageSeq, historyRevision }), signal }).then(r => j<import("./types.js").ReadState>(r)),
  searchSessionMessages: (sessionId: string, query: string, cursor: string | null, signal?: AbortSignal) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/search?q=${encodeURIComponent(query)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal })
      .then(r => j<{ results: import("./types.js").MessageSearchHit[]; nextCursor: string | null }>(r)),

  getMessageContext: (sessionId: string, target: { around: string } | { before: string } | { after: string }, signal?: AbortSignal) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages?view=window&limit=50&${new URLSearchParams(target)}`, { signal })
      .then(r => j<import("./session-history.js").HistoryPage & { afterCursor: string | null; hasMoreAfter: boolean }>(r)),

  getMessagesPage: (sessionId: string, before: string | null, limit = 50, signal?: AbortSignal) =>
    fetch(`/api/sessions/${sessionId}/messages?view=window&limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`, { signal })
      .then((r) => j<import("./session-history.js").HistoryPage>(r)),

  /**
   * 发送提示词。附件只传 **id**（规格 2 §9.1）：文件内容早已落在附件存储里，
   * 不再随 prompt JSON 传 base64——旧做法会让 1MB 文件变成 1.33MB 文本写进事件与消息 part。
   * 参数改为对象是刻意的：原先是 10 个位置参数，加一个字段就要动所有调用点。
   */
  prompt: (
    sessionId: string,
    input: {
      text: string;
      agent?: string;
      model?: ModelRef;
      effort?: ThinkingEffort;
      skillId?: string;
      references?: string[];
      attachmentIds?: string[];
      requestId?: string;
    },
  ) => {
    const requestId = input.requestId ?? globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // disposition 描述这条消息与任务的关系（规格 3 §12）：开新任务 / 并入当前
    // 任务 / 恢复等待中的任务 / 排队。UI 只用它做提示与队列态，不再用它推任务状态。
    return post(`/api/sessions/${sessionId}/prompt`, { ...input, requestId }).then((r) =>
      j<{ ok: boolean; requestId: string; runId: string; userMessageId: string; disposition?: PromptDisposition; taskId?: string }>(r),
    );
  },

  // ===== 持续任务（规格 3 §13.2）=====

  /** 读当前任务：活跃优先，无活跃时回退最近一个终态任务。 */
  getTask: (sessionId: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/task`).then((r) =>
      j<{ task: TaskRecordView | null; supported: boolean }>(r),
    ),

  /** 用户核对完后放行任务（§13.2 的 `resume`）。
   *  **不发消息**——这是同一条指令的继续，不是新的一轮对话（§11.2）。 */
  resumeTask: (sessionId: string) =>
    post(`/api/sessions/${encodeURIComponent(sessionId)}/task`, { action: "resume" }).then((r) =>
      j<{ ok: boolean; resumed: boolean }>(r),
    ),

  // ===== 附件（规格 2 §9.1）=====

  /** 上传单个附件（multipart）。sessionId 传 `__draft__` 表示尚未建会话。 */
  uploadAttachment: (sessionId: string, file: File, options?: { signal?: AbortSignal; onProgress?: (ratio: number) => void }) =>
    uploadFile(sessionId, file, options),

  listAttachments: (sessionId: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`).then((r) =>
      j<{ attachments: AttachmentReceipt[]; scope: "session" | "draft" }>(r),
    ),

  getAttachment: (sessionId: string, attachmentId: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`).then((r) =>
      j<{ attachment: AttachmentReceipt; availability: boolean }>(r),
    ),

  deleteAttachment: (sessionId: string, attachmentId: string) =>
    send("DELETE", `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`).then((r) =>
      j<{ ok: boolean }>(r),
    ),

  /** 原始文件 URL。默认 inline（图片/PDF 就地预览），`download` 强制下载。 */
  attachmentUrl: (sessionId: string, attachmentId: string, options?: { download?: boolean }) =>
    `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}?raw=1${options?.download ? "&download=1" : ""}`,

  replyPermission: (
    sessionId: string,
    requestId: string,
    reply: "once" | "always" | "reject",
    feedback?: string,
    audit?: { source: "manual" | "auto" | "fine-grained"; permission?: string; summary?: string },
  ) =>
    post(`/api/sessions/${sessionId}/permission`, { requestId, reply, feedback, ...audit }).then((r) => j<{ ok: boolean }>(r)),

  abort: (sessionId: string) =>
    post(`/api/sessions/${sessionId}/abort`).then((r) => j<{ ok: boolean }>(r)),

  // ===== 文件系统 / Git / 终端（右侧工作台面板与 ⌘P 快开共用）=====

  fsTree: (path: string, sessionId?: string | null, signal?: AbortSignal) =>
    fetch(`/api/fs/tree?path=${encodeURIComponent(path)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`, { signal }).then((r) =>
      j<{ path: string; nodes: TreeNode[] }>(r),
    ),

  fsFile: (path: string, sessionId?: string | null) =>
    fetch(`/api/fs/file?path=${encodeURIComponent(path)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`).then((r) =>
      j<FileView>(r),
    ),

  fsSave: (path: string, content: string, sessionId?: string | null) =>
    send("PUT", "/api/fs/file", { path, content, sessionId }).then((r) => j<{ ok: boolean; size: number }>(r)),

  fsSearch: (q: string, sessionId?: string | null) =>
    fetch(`/api/fs/search?q=${encodeURIComponent(q)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`).then((r) =>
      j<{ query: string; results: { path: string; type: "dir" | "file" }[] }>(r),
    ),

  terminalList: (sessionId?: string | null) => fetch(`/api/terminal${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`).then((r) => j<TerminalListResult>(r)),

  terminalStart: (command: string, sessionId?: string | null) => post("/api/terminal", { command, sessionId }).then((r) => j<TerminalSession>(r)),

  /** 起一条交互式 shell 会话；不传 shell 时跟随系统默认（zsh/bash/fish/pwsh…）。 */
  terminalStartShell: (shell?: string, sessionId?: string | null, size?: { cols: number; rows: number }) =>
    post("/api/terminal", {
      interactive: true,
      ...(shell ? { shell } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(size ?? {}),
    }).then(
      (r) => j<TerminalSession>(r),
    ),

  terminalRead: (id: string, cursor: number) =>
    fetch(`/api/terminal/${id}/read?cursor=${cursor}`).then((r) => j<TerminalChunk>(r)),

  terminalInput: (id: string, data: string) =>
    post(`/api/terminal/${id}/input`, { data }).then((r) => j<{ ok: boolean }>(r)),
  terminalResize: (id: string, cols: number, rows: number) =>
    post(`/api/terminal/${id}/resize`, { cols, rows }).then((r) => j<{ ok: boolean }>(r)),

  terminalKill: (id: string) =>
    fetch(`/api/terminal/${id}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),

  // ===== 工作台（多项目 / 模型 / Skill / 上下文 / 审查 / key）=====

  listProjects: () => fetch("/api/projects").then((r) => j<ProjectsState>(r)),

  addProject: (path: string) => post("/api/projects", { path }).then((r) => j<{ project: Project }>(r)),

  switchProject: (id: string) => send("PUT", "/api/projects", { id }).then((r) => j<{ project: Project }>(r)),

  listModels: () => fetch("/api/models").then((r) => j<ModelsState>(r)),

  listSkills: (sessionId?: string | null) => fetch(`/api/skills${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`).then((r) => j<{ skills: SkillOption[] }>(r)),

  getSkill: (id: string) =>
    fetch(`/api/skills?id=${encodeURIComponent(id)}`).then((r) => j<{ skill: SkillOption }>(r)),

  usage: (sessionId: string) =>
    fetch(`/api/sessions/${sessionId}/usage`).then((r) => j<UsageInfo>(r)),

  compact: (sessionId: string) =>
    post(`/api/sessions/${sessionId}/compact`).then((r) => j<{ ok: boolean; reason?: string }>(r)),

  /** 回溯重发：删除目标用户消息及其后的全部消息，以（可编辑后的）文本重跑。 */
  rewind: (sessionId: string, messageId: string, text?: string) =>
    post(`/api/sessions/${sessionId}/rewind`, { messageId, ...(text != null ? { text } : {}) }).then((r) => j<{ ok: boolean }>(r)),

  gitDiff: (path?: string, sessionId?: string | null) => {
    const query = new URLSearchParams();
    if (path) query.set("path", path);
    if (sessionId) query.set("sessionId", sessionId);
    return fetch(`/api/git/diff${query.size ? `?${query}` : ""}`).then((r) => j<GitDiff>(r));
  },

  checkpoints: (sessionId?: string | null) =>
    fetch(`/api/git/checkpoint${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`).then((r) =>
      j<{ points: { hash: string; time: string; subject: string; checkpoint: boolean }[] }>(r),
    ),

  checkpointCreate: (label: string, sessionId?: string | null) =>
    post("/api/git/checkpoint", { label, sessionId }).then((r) => j<{ ok: boolean; skipped?: boolean; reason?: string; hash?: string }>(r)),

  checkpointRestore: (hash: string, sessionId?: string | null) =>
    send("PUT", "/api/git/checkpoint", { hash, sessionId }).then((r) => j<{ ok: boolean }>(r)),

  // ===== 本地可信交付（P0）=====

  deliveryOverview: (sessionId: string) =>
    fetch(`/api/deliveries?sessionId=${encodeURIComponent(sessionId)}`).then((r) => j<DeliveryOverview>(r)),

  deliveryAction: (sessionId: string, action: string, payload?: Record<string, unknown>) =>
    post("/api/deliveries/attempt", { sessionId, action, ...payload }).then((r) =>
      j<{ ok: boolean; attempt?: DeliveryAttempt; runs?: CommandRunView[]; valid?: boolean | null; merge?: { mergeCommitSha: string; baseRef: string }; error?: string; detail?: string }>(r),
    ),

  /** V1-S6：浏览器验证面（plan/runs/run 与截图引用）。 */
  browserQa: <T>(sessionId: string, action: "plan" | "runs" | "run", payload?: Record<string, unknown>) =>
    post("/api/deliveries/browser-qa", { sessionId, action, ...payload }).then((r) => j<T>(r)),

  keyStatus: () => fetch("/api/settings/key").then((r) => j<KeyStatus>(r)),

  keySave: (key: string, ollamaUrl?: string | null) =>
    send("PUT", "/api/settings/key", { key, ollamaUrl }).then((r) => j<KeyStatus>(r)),

  keySaveOllama: (ollamaUrl: string | null) =>
    send("PUT", "/api/settings/key", { ollamaUrl }).then((r) => j<KeyStatus>(r)),

  keySaveRelay: (relayUrl: string | null) =>
    send("PUT", "/api/settings/key", { relayUrl }).then((r) => j<KeyStatus>(r)),

  keyClear: () => fetch("/api/settings/key", { method: "DELETE" }).then((r) => j<KeyStatus>(r)),

  /** 降级端点（设置 → 模型与凭据 → 降级端点）：读 / 整体替换。 */
  failoverGet: () =>
    fetch("/api/settings/failover").then((r) =>
      j<{ endpoints: FailoverEndpointView[]; failover: FailoverEventView[] }>(r),
    ),
  failoverSave: (endpoints: { baseUrl: string; modelId?: string | null; apiKey?: string | null; apiKeyMasked?: string | null }[]) =>
    send("PUT", "/api/settings/failover", { endpoints }).then((r) =>
      j<{ endpoints: FailoverEndpointView[]; failover: FailoverEventView[] }>(r),
    ),

  mcpStatus: () => fetch("/api/mcp").then((r) => j<McpStatuses>(r)),

  mcpRescan: () => post("/api/mcp").then((r) => j<McpStatuses>(r)),

  pluginsList: () => fetch("/api/plugins").then((r) => j<{ plugins: PluginInfo[] }>(r)),

  pluginInstall: (sourcePath: string) =>
    post("/api/plugins", { sourcePath }).then((r) => j<{ ok: boolean; plugin?: PluginInfo; error?: string }>(r)),

  pluginUninstall: (name: string) =>
    post("/api/plugins", { action: "uninstall", name }).then((r) => j<{ ok: boolean; error?: string }>(r)),

  keyRotate: () => post("/api/settings/key").then((r) => j<KeyStatus & { rotated: boolean; keyMigrated: boolean }>(r)),

  /** 权限自动执行配置（设置 → 通用 → 权限）：读 / 部分更新（保存即生效）。 */
  permissionsGet: () =>
    fetch("/api/settings/permissions").then((r) => j<{ permissions: PermissionSettings }>(r)).then((r) => r.permissions),
  permissionsSave: (patch: PermissionSettings) =>
    send("PUT", "/api/settings/permissions", { permissions: patch })
      .then((r) => j<{ permissions: PermissionSettings }>(r))
      .then((r) => r.permissions),

  /** 权限审计日志（最近决定记录）。 */
  auditList: (permission?: string) =>
    fetch(`/api/settings/audit${permission ? `?permission=${encodeURIComponent(permission)}` : ""}`)
      .then((r) => j<{ rows: { at: string; sessionId: string; permission: string; summary: string; decision: string; source: string }[] }>(r))
      .then((r) => r.rows),

  /** relay 账号联动：key 列表 / 一键签发并绑定（明文只在 relay 响应中转一次）。 */
  relayKeys: () => fetch("/api/settings/keys").then((r) => j<RelayKeyInfo>(r)),

  relayKeyIssue: () => post("/api/settings/keys").then((r) => j<KeyStatus & { prefix?: string | null; error?: string }>(r)),

  /** 订阅某会话事件流（SSE）。断线自动重连：放弃 EventSource 的原生无参重连
   *  （会丢 since 游标），改为手动重建并携带 since=<lastSeq> 断点续传，
   *  指数退避 1s/2s/4s/8s（上限 15s）；连续失败 3 次置 offline。
   *  onState 供 UI 展示连接状态（可选，不传则静默重连）。
   *  返回取消函数。 */
  subscribe: (
    sessionId: string,
    cb: (ev: LecternEvent) => void,
    onState?: (state: ConnectionState) => void,
    initialSeq = 0,
  ) => {
    let es: EventSource | null = null;
    let lastSeq = initialSeq;
    let attempt = 0;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const reconnect = (source: EventSource) => {
      if (closed || es !== source) return;
      source.close();
      es = null;
      attempt += 1;
      onState?.(attempt >= 3 ? "offline" : "reconnecting");
      const delay = Math.min(15_000, 1_000 * 2 ** Math.min(attempt - 1, 4));
      retryTimer = setTimeout(connect, delay);
    };
    const connect = () => {
      if (closed) return;
      retryTimer = null;
      const url = `/api/sessions/${sessionId}/events${lastSeq > 0 ? `?since=${lastSeq}` : ""}`;
      const source = new EventSource(url);
      es = source;
      source.onopen = () => {
        if (closed || es !== source) return;
        onState?.("connected");
      };
      source.onmessage = (e) => {
        if (closed || es !== source) return;
        try {
          const ev = JSON.parse(e.data) as LecternEvent & { seq: number; sessionId: string };
          if (!ev || ev.sessionId !== sessionId || !Number.isSafeInteger(ev.seq) || ev.seq < 1
            || typeof ev.type !== "string" || !ev.data || typeof ev.data !== "object") {
            reconnect(source);
            return;
          }
          if (ev.seq <= lastSeq) return;
          // Do not acknowledge a gap: replay from the last successfully applied event.
          if (ev.seq !== lastSeq + 1) {
            reconnect(source);
            return;
          }
          cb(ev);
          lastSeq = ev.seq;
          attempt = 0;
        } catch {
          reconnect(source);
        }
      };
      source.onerror = () => reconnect(source);
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  },
};
