// 与 @zmzai/agent-framework 事件契约对应的本地类型（UI 层不直接依赖引擎包）

export type ModelRef = { providerId: string; modelId: string };

export type AgentInfo = {
  name: string;
  description?: string;
  mode: "primary" | "subagent" | "all";
  model?: ModelRef;
  steps?: number;
  permission: unknown[];
};

export type SessionInfo = {
  id: string;
  title: string;
  agent: string;
  model: ModelRef;
  time: { created: string; updated?: string };
  /** 运行态（GET /api/sessions 附带，来自 runner activeRuns）。 */
  running?: boolean;
  /** HITL 待确认：run 挂起等待人工授权（isSessionAwaitingPermission）。 */
  awaitingPermission?: boolean;
  /** 最近一次 run 的终态（N5）：completed/aborted/error，会话列表三态用。 */
  lastOutcome?: "completed" | "aborted" | "error";
  /** 消息数（N6，GET /api/sessions 附带，批量 GROUP BY 填充）。 */
  messageCount?: number;
  /** 置顶（N6）：列表置顶展示。 */
  pinned?: boolean;
  /** 归档（N6）：归档后从默认列表隐藏。 */
  archived?: boolean;
  /** 会话级权限规则（framework session.permission 原样透出，含权限模式哨兵）。 */
  permission?: unknown[];
  /** 会话级 worktree 隔离状态（POST /api/sessions 创建时附带；切换会话经 worktree status 查询）。 */
  isolation?: SessionIsolation;
}

/** 跨项目会话列表条目（GET /api/sessions?all=1 附带归属；本项目会话两字段缺省）。 */
export type SessionListItem = SessionInfo & {
  projectId?: string;
  projectName?: string;
};;

/** git worktree 隔离（robustness-plan §9）：隔离副本会话在独立 worktree 工作，合并前主工作区零污染。 */
export type SessionIsolation = {
  enabled: boolean;
  /** 降级原因（enabled=false 时）：not-a-git-repo / git-error 等。 */
  reason?: string;
  path?: string;
  branch?: string;
};

export type ToolState =
  | { status: "pending"; input: unknown }
  | { status: "running"; input: unknown; title?: string; time: { start: string } }
  | { status: "completed"; input: unknown; output: string; title: string; time: { start: string; end: string }; metadata?: Record<string, unknown> }
  | { status: "error"; input: unknown; error: string; time: { start: string; end: string }; metadata?: Record<string, unknown> };

export type Part =
  | { id: string; type: "text"; text: string; messageId: string; sessionId: string }
  | { id: string; type: "reasoning"; text: string; messageId: string; sessionId: string }
  | { id: string; type: "tool"; callId: string; tool: string; state: ToolState; messageId: string; sessionId: string }
  | { id: string; type: "subtask"; prompt: string; description: string; agent: string; childSessionId: string; messageId: string; sessionId: string }
  | { id: string; type: "file"; mime: string; filename: string; url: string; messageId: string; sessionId: string }
  | { id: string; type: "image"; url: string; mediaType: string; messageId: string; sessionId: string }
  | { id: string; type: "compaction"; summary: string; messageId: string; sessionId: string };

export type PermissionRequest = {
  id: string;
  sessionId: string;
  permission: string;
  patterns: string[];
  metadata?: { summary?: string; filePath?: string; command?: string; [k: string]: unknown };
  always: string[];
  tool?: { messageId: string; callId: string };
};

export type LecternEvent = { type: string; data: unknown };

/** 任务终态小结（framework session.summary 事件，N5）：
 *  run 收尾时 summary 模型生成的一句总结 + 本轮结构化统计。 */
export type SessionSummary = {
  text: string;
  kind: "completed" | "aborted" | "error";
  meta?: { filesEdited: number; toolCalls: number; durationMs: number };
};

/** 任务产物（framework artifact.created 事件）：沙箱/工具产出的一次可交付文件。
 *  按「本轮 run」归集——每个 session.summary 切分一次边界，不跨轮累积。 */
export type Artifact = {
  artifactId: string;
  path: string;
  bytes: number;
  contentType: string;
  downloadUrl: string;
  previewUrl?: string;
  createdAt: number;
};

/** 会话已持久化的转录（来自引擎 getMessages）。info 取 id/role/error，parts 即完整片段。 */
export type SelectedSkill = { id: string; name: string; digest: string };
export type TranscriptMessage = { info: { id: string; role: string; error?: { name: string; message: string }; skill?: SelectedSkill; references?: string[] }; parts: Part[] };

export type AuthStatus = {
  loggedIn: boolean;
  cookieName: string;
  /** 已登录时的用户 profile（name/email，账户块展示用）。 */
  user?: { name: string; email: string } | null;
};

// ===== 文件系统 / Git / 终端（原 Inspector 面板，现由 WorkbenchPanel 承载）=====

export type TreeNode = {
  name: string;
  type: "dir" | "file";
  size?: number;
  mtime: string;
};

/** 宿主机探测到的 shell 候选（面板下拉 + 交互会话起哪一个）。 */
export type ShellCandidate = {
  file: string;
  label: string;
};

export type TerminalListResult = {
  backendKind: "pty" | "pipe";
  sessions: TerminalSession[];
  /** 系统默认 shell；探测不到时为 null。 */
  defaultShell: ShellCandidate | null;
  /** 本机全部候选（含默认，默认排第一），供面板切换。 */
  shells: ShellCandidate[];
};

export type TerminalSession = {
  id: string;
  name?: string;
  status: string;
  backend: "pty" | "pipe";
  exitCode?: number | null;
  startedAt: string;
};

export type TerminalChunk = {
  output: string;
  cursor: number;
  session: TerminalSession;
};

/** /api/terminal/read-all 批量游标读响应（单请求替代逐会话轮询）。 */
export type TerminalReadAllResult = {
  sessions: Array<{
    id: string;
    output: string;
    cursor: number;
    status: string;
    exitCode: number | null;
    name?: string;
    backend: "pty" | "pipe";
    bytesTotal: number;
  }>;
  missing: string[];
};

// ===== 工作台（多项目 / 模型选择 / Skill / 上下文 / 个人 key）=====

export type Project = { id: string; name: string; path: string; createdAt: string };

export type ProjectsState = { projects: Project[]; active: Project };

/** relay /models 响应（透传归一，composer 选择器数据源）。 */
export type FeaturedModel = {
  id: string;
  name: string;
  description?: string;
  channel: string;
  maxInputTokens: number;
};

export type ModelChannel = {
  id: string;
  name: string;
  models: { id: string; name: string; maxInputTokens: number }[];
};

export type ModelsState = {
  /** relay /v1/models 已按调用者身份过滤（个人 key → allowedModels 子集；登录会话 → 全部）；availableChannels 为当前健康渠道数（0 表示提交即失败）。 */
  models: { model: string; maxInputTokens: number; availableChannels?: number; allowedReasoningEfforts?: string[] }[];
  modelSelectorData: { featured: FeaturedModel[]; channels: ModelChannel[] } | null;
  authenticated: boolean;
  /** 本地 Ollama（在线时非 null）：模型以 providerId=ollama 的 ModelRef 使用。 */
  ollama: { baseUrl: string; models: { id: string; name: string }[] } | null;
  /** 路由降级环形日志（P0 可观测，最近在前）。 */
  failover: { from?: string; to: string; error: string; attempt: number }[];
};

/** 本机 / 工作区可发现的 Skill。列表不下发正文，选中时才按 id 读取。 */
export type SkillSource = "workspace" | "codex" | "agents";
export type SkillOption = { id: string; name: string; description?: string; source: SkillSource; digest?: string; markdown?: string };

/** 会话上下文用量：取最近一次 step-finish 的 input+output+cacheRead ≈ 窗口占用。 */
export type UsageInfo = {
  used: number;
  contextWindow: number;
  input: number;
  output: number;
  cacheRead: number;
  steps: number;
};

export type DiffFile = { path: string; additions: number; deletions: number; binary?: boolean };

// ===== 本地可信交付（P0）=====

export type DeliveryStatus =
  | "running"
  | "verifying"
  | "ready_for_review"
  | "verification_failed"
  | "unverified"
  | "cancelled"
  | "accepted"
  | "discarded";

export type DeliverySnapshot = {
  baseHeadSha?: string;
  worktreeHeadSha?: string;
  worktreeFingerprint: string;
  executionPlanHash?: string;
  deliveryCommitSha?: string;
  deliveryTreeSha?: string;
  capturedAt: string;
};

export type DeliveryAttempt = {
  id: string;
  deliveryId: string;
  runId: string;
  sequence: number;
  status: DeliveryStatus;
  unverifiedReason?: "no_required_checks" | "snapshot_stale";
  verificationSnapshot?: DeliverySnapshot;
  supersedesAttemptId?: string;
  supersededAt?: string;
  changedPaths: string[];
  summary?: string;
  risks: string[];
  createdAt: string;
  updatedAt: string;
};

export type CommandRunView = {
  id: string;
  deliveryAttemptId: string;
  kind: "agent" | "verification" | "service" | "browser_qa";
  requirement: "required" | "advisory";
  label: string;
  command: string;
  cwd: string;
  status: "running" | "passed" | "failed" | "cancelled";
  exitCode?: number;
  durationMs?: number;
  startedAt: string;
  endedAt?: string;
  output: string;
  outputTruncated: boolean;
  outputBytes: number;
  verificationSnapshotFingerprint?: string;
};

export type DeliveryOverview = {
  delivery: {
    id: string;
    projectId: string;
    sessionId: string;
    effectiveWorkspaceRoot: string;
    baseRef?: string;
    worktreeBranch?: string;
    activeAttemptId?: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  attempt: DeliveryAttempt | null;
  runs: CommandRunView[];
};

export type GitDiff = { available: boolean; files: DiffFile[]; diff: string; truncated?: boolean };

/** 个人 key 状态（仅掩码回显）。 */
export type KeyStatus = { configured: boolean; masked: string | null; relayUrl?: string; ollamaUrl?: string | null };

/** 降级端点（设置页）：baseUrl 必填，apiKey 仅掩码回显。 */
export type FailoverEndpointView = { baseUrl: string; modelId: string | null; apiKeyMasked: string | null };

/** 降级日志条目（最近端点切换，/api/models 与设置页透出）。 */
export type FailoverEventView = { from?: string; to: string; error: string; attempt: number };

/** 权限自动执行配置（设置 → 通用 → 权限）：域 → ask 逐次确认 / auto 自动始终允许。 */
export type PermissionDomain = "terminal" | "edit" | "task" | "gitWrite";
export type PermissionAction = "ask" | "auto";
export type PermissionSettings = Partial<Record<PermissionDomain, PermissionAction>>;
/** framework 权限键 → 设置域（未映射的键不受细粒度配置影响，仍逐次确认）。 */
export const PERMISSION_DOMAIN_OF: Record<string, PermissionDomain> = {
  bash: "terminal",
  terminal: "terminal",
  edit: "edit",
  task: "task",
  git_write: "gitWrite",
};

/** relay 账号下的 API key（控制面列表，prefix 掩码；明文只在签发时一次性返回）。 */
export type RelayKeyInfo = {
  loggedIn: boolean;
  keys: { id: string; name: string; prefix: string; status: "active" | "revoked"; quotaUsedTokens: number; monthlySpendUsedMicros: number; monthlySpendLimitMicros: number; lastUsedAt: string | null }[];
  /** lectern 当前绑定 key 的 prefix（前 12 位，与列表匹配「使用中」）。 */
  currentPrefix: string | null;
  error?: string;
};

/** 推理力度档位（N3）：与 relay reasoning_effort 对齐；off = 不发字段。 */
export type ThinkingEffort = "off" | "minimal" | "low" | "medium" | "high";

/** MCP server 连接态（设置弹窗透出）。 */
export type McpStatuses = {
  statuses: { name: string; state: "connected" | "error"; transport: string; tools: string[]; error?: string }[];
  configErrors: string[];
  sources: string[];
};

/** 已安装插件（P1：plugin.json 目录，可携带 mcp.json / skills）。 */
export type PluginInfo = {
  name: string;
  version?: string;
  description?: string;
  scope: "project" | "global";
  root: string;
  hasMcp: boolean;
};

/** SSO 捕获到的会话 cookie 载荷。
 *  `expiresAt` 是**秒级** Unix 时间戳（沿用 Electron Cookie.expirationDate 的单位，
 *  与 /api/auth/ingest 的 maxAge 换算保持同一量纲）；null 表示上游发的是 session
 *  cookie（无显式有效期），此时由服务端按 30 天兜底缓存。 */
export type SsoCookiePayload = {
  value: string;
  expiresAt: number | null;
};

/** Electron 宿主桥（preload.cjs 注入 window.lecternNative；Web 端不存在，需能力探测降级）。 */
export type LecternNativeBridge = {
  platform?: string;
  pickFolder?: () => Promise<string | null>;
  /** 任务完成系统通知（主进程 Notification；仅 Electron 宿主存在）。 */
  notifyTaskDone?: () => void;
  /** 打开内嵌服务日志目录（<userData>/logs，web.log 报障收集用）；返回目录路径。 */
  openLogsFolder?: () => Promise<string>;
  /** SSO 登录：打开 auth 子窗口；立即返回已有共享会话 cookie（登录过）或 null。 */
  openAuthWindow?: () => Promise<SsoCookiePayload | null>;
  /** 订阅 SSO 会话 cookie：主进程捕获 auth 域会话 cookie 后推送（含上游有效期）。 */
  onSsoCookie?: (callback: (payload: SsoCookiePayload) => void) => void;
  /** ⌘W 被宿主截获后调用；回调由前端按当前焦点关闭对应 pane。 */
  onCloseFocusedPane?: (callback: () => void) => () => void;
};

declare global {
  interface Window {
    lecternNative?: LecternNativeBridge;
  }
}
