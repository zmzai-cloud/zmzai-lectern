import type {
  AgentInfo,
  AuthStatus,
  CommandRunView,
  DeliveryAttempt,
  DeliveryOverview,
  FailoverEndpointView,
  FailoverEventView,
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
} from "./types";
import type { PermissionMode } from "./permission-mode";

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
    throw new Error(body?.error ?? `请求失败（${res.status}）`);
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
      .then((r) => j<{ query: string; results: { sessionId: string; title: string; snippet: string }[] }>(r)),

  createSession: (agent?: string, model?: ModelRef, isolate?: boolean) =>
    post("/api/sessions", { agent, model, isolate }).then((r) => j<SessionInfo>(r)),

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

  /** 消息转录尾部分页：skip = 已从尾部取走的条数。hasMore=false 表示已到最早。 */
  getMessagesPage: (sessionId: string, skip: number, limit = 50) =>
    fetch(`/api/sessions/${sessionId}/messages?tail=${limit}&skip=${skip}`)
      .then((r) => j<{ messages: TranscriptMessage[]; total: number; hasMore: boolean }>(r)),

  prompt: (
    sessionId: string,
    text: string,
    agent?: string,
    model?: ModelRef,
    images?: { url: string; mediaType: string }[],
    effort?: ThinkingEffort,
    skillId?: string,
    references?: string[],
  ) => post(`/api/sessions/${sessionId}/prompt`, { text, agent, model, images, effort, skillId, references }).then((r) => j<{ ok: boolean }>(r)),

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
      j<{ path: string; size: number; content: string }>(r),
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
  ) => {
    let es: EventSource | null = null;
    let lastSeq = 0;
    let attempt = 0;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      const url = `/api/sessions/${sessionId}/events${lastSeq > 0 ? `?since=${lastSeq}` : ""}`;
      es = new EventSource(url);
      es.onopen = () => {
        attempt = 0;
        onState?.("connected");
      };
      es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data) as LecternEvent & { seq?: number };
          if (typeof ev.seq === "number" && ev.seq > lastSeq) lastSeq = ev.seq;
          cb(ev);
        } catch {
          /* 忽略无法解析的帧 */
        }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (closed) return;
        attempt += 1;
        onState?.(attempt >= 3 ? "offline" : "reconnecting");
        const delay = Math.min(15_000, 1_000 * 2 ** Math.min(attempt - 1, 4));
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  },
};
