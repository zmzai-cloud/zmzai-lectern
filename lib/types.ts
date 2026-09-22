// 与 @zmzai/agent-framework 事件契约对应的本地类型（UI 层不直接依赖引擎包）

import type { AttachmentKind } from "./attachments/limits.js";

/** 附件类型统一从 lib/types 出口（规格 2 §15.1），避免组件到处 deep import。 */
export type {
  AttachmentError,
  AttachmentErrorCode,
  AttachmentReceipt,
  AttachmentStatus,
  ComposerAttachment,
  ComposerAttachmentStatus,
  InputAttachmentRef,
  WorkspaceReference,
} from "./attachments/types.js";
export type { AttachmentKind, AttachmentFormat } from "./attachments/limits.js";

export type ModelRef = { providerId: string; modelId: string };
export type ReadState = { lastReadMessageSeq: number; latestMessageSeq: number; unreadCount: number; historyRevision: number };

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
  /** 最近一次 run 的终态（N5）：completed/aborted/error。
   *  **只描述一次运行**——列表的「完成」判定已改由 `task.status` 驱动
   *  （规格 3 §14.3 / §18.3），这里保留是给执行轨迹与历史会话用。 */
  lastOutcome?: "completed" | "aborted" | "error";
  /** 当前（或最近一次）持久任务。列表与上下文条的任务态一律读它，
   *  不再从 summary 反推（规格 3 §15.2）。 */
  task?: TaskRecordView | null;
  /** 消息数（N6，GET /api/sessions 附带，批量 GROUP BY 填充）。 */
  messageCount?: number;
  readState?: ReadState;
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

/** 文件 part（规格 2 §11）。新链路只写 `attachmentId` 等描述符，**不再写 data URL**；
 *  `url` 仅为读历史遗留消息保留，因此是可选的——消费方必须先判 url 再判 attachmentId。 */
export type FilePart = {
  id: string;
  type: "file";
  mime: string;
  filename: string;
  messageId: string;
  sessionId: string;
  /** 旧链路遗留：`data:` 开头的内联内容。新消息不再产生。 */
  url?: string;
  /** 新链路：附件 id，配合 attachmentId 取原始文件。 */
  attachmentId?: string;
  size?: number;
  kind?: AttachmentKind;
  status?: "processing" | "ready" | "error";
};

export type Part =
  | { id: string; type: "text"; text: string; messageId: string; sessionId: string }
  | { id: string; type: "reasoning"; text: string; messageId: string; sessionId: string }
  | { id: string; type: "tool"; callId: string; tool: string; state: ToolState; messageId: string; sessionId: string }
  | { id: string; type: "subtask"; prompt: string; description: string; agent: string; childSessionId: string; messageId: string; sessionId: string }
  | FilePart
  | { id: string; type: "image"; url: string; mediaType: string; messageId: string; sessionId: string }
  | { id: string; type: "compaction"; summary: string; messageId: string; sessionId: string };

/** 旧链路输入附件契约（v1，data URL）。仅为兼容仍在传 base64 的调用方保留；
 *  新链路用 `attachmentIds`（规格 2 §9.1）。 */
export type InputAttachment = { name: string; mediaType: string; data: string; size: number };

export type PermissionRequest = {
  id: string;
  sessionId: string;
  permission: string;
  patterns: string[];
  metadata?: { summary?: string; filePath?: string; command?: string; [k: string]: unknown };
  always: string[];
  tool?: { messageId: string; callId: string };
};

export type LecternEvent = { type: string; data: unknown; seq?: number; sessionId?: string };

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

// ===== 持续任务（规格 3）=====

/** 任务生命周期。与 framework `TaskLifecycleStatus` 逐字对齐——UI 不做二次抽象，
 *  因为「在等授权」和「在等用户补信息」要给的是两个不同的按钮（规格 §14.2）。 */
export type TaskLifecycleStatus =
  | "queued"
  | "running"
  | "recovering"
  | "waiting_permission"
  | "waiting_input"
  | "waiting_external"
  | "verifying"
  | "delivered"
  | "blocked"
  | "failed"
  | "cancelled";

export type TaskStepStatus = "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
export type TaskCriterionStatus = "pending" | "passed" | "failed" | "not_applicable";

export type TaskStepView = { id: string; title: string; status: TaskStepStatus; order: number };
export type TaskCriterionView = { id: string; description: string; required: boolean; status: TaskCriterionStatus };

/** 阻塞原因。`resumable` 决定给不给「检查后重试」——一个不可恢复的阻塞
 *  摆出一个可点的重试按钮，比不给按钮更糟。 */
export type TaskBlockerView = {
  kind: "permission" | "input" | "choice" | "external_auth" | "unsafe_replay" | "budget" | "no_progress";
  message: string;
  requiredAction: string;
  resumable: boolean;
};

/** 最终交付信息（规格 §14.1 交付卡四问的来源）。`remaining` 为空数组时
 *  UI 必须显式写「无」——留白会让用户以为还有没列出的尾巴。 */
export type TaskResultView = {
  outcome: string;
  changes: string[];
  verification: string[];
  remaining: string[];
};

/** 任务的 UI 视图。字段是 framework `TaskRecord` 的**子集**：只留界面真正
 *  消费的那些。evidence 只带计数与最近若干条摘要，不整份下发——一个长任务
 *  的证据集可以有几十条，而界面只画最近几条。 */
export type TaskRecordView = {
  id: string;
  sessionId: string;
  goal: string;
  status: TaskLifecycleStatus;
  steps: TaskStepView[];
  acceptanceCriteria: TaskCriterionView[];
  blocker?: TaskBlockerView;
  revision: number;
  attemptCount: number;
  constraints: string[];
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  /** 累计执行毫秒（各 Attempt 之和），进度区展示运行时长用。 */
  activeMs?: number;
  result?: TaskResultView;
  /** 证据摘要（最近在前，最多 12 条）与总数。 */
  evidence?: { count: number; recent: { kind: string; summary: string }[] };
};

/** 一条消息与任务的关系（framework PromptReceipt.disposition）。
 *  后两个值是规格 3 之前的旧值，仅为容忍历史 receipt 保留。 */
export type PromptDisposition =
  | "task_started"
  | "task_steered"
  | "task_resumed"
  | "queued_new_task"
  | "started"
  | "queued";

/** 会话已持久化的转录（来自引擎 getMessages）。info 取 id/role/error，parts 即完整片段。 */
export type SelectedSkill = { id: string; name: string; digest: string };
export type TranscriptMessage = { info: { id: string; role: string; error?: { name: string; message: string }; skill?: SelectedSkill; references?: string[] }; parts: Part[]; messageSeq?: number };

export type MessageSearchHit = {
  projectId: string; sessionId: string; messageId: string; partId: string;
  kind: "text" | "tool" | "attachment_name";
  messageSeq: number; snippet: string; match: { start: number; length: number };
};

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

/** `GET /api/fs/file` 的结果：文本文件带内容，二进制只带判定结论。
 *
 *  【为什么二进制不是 HTTP 错误】「这份文件不是文本」是一个成功的观察，不是失败。
 *  调用方（文件 Tab / 成果预览）要的是**该怎么处理它**，所以结论必须能被读到，
 *  而不是变成一句异常消息。 */
export type FileView = {
  path: string;
  size: number;
  /** 文本内容；`binary` 为真时是空串。 */
  content: string;
  /** 不是文本（PDF / 图片 / 归档 / 未知二进制）。编辑器不打开它。 */
  binary: boolean;
  /** 服务端嗅探出的类型；`null` 表示不像文本但认不出具体是什么。 */
  mediaType: string | null;
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
  updateCheck?: () => Promise<UpdateState>;
  updateDownload?: () => Promise<UpdateState>;
  updateInstall?: () => Promise<boolean>;
  updateState?: () => Promise<UpdateState>;
  onUpdateStatus?: (callback: (state: UpdateState) => void) => () => void;
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

export type UpdateState = {
  status: "idle" | "checking" | "available" | "current" | "downloading" | "ready" | "error" | "unavailable";
  version: string | null;
  percent: number;
  error: string | null;
};

declare global {
  interface Window {
    lecternNative?: LecternNativeBridge;
  }
}
