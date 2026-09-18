/**
 * 任务呈现派生模型（state-driven workbench UI spec §6）。
 *
 * `deriveTaskPresentation` 是纯函数：把活跃会话、对话投影、git/diff 状态与可预览
 * 产物路径，折叠成一个六态 `TaskPresentationState`，并附带视觉所需的
 * label / icon kind / priority / badge model。**本文件不写 JSX、不引入 React、不
 * 读写任何外部状态**，只做有序谓词表的求值，供 TaskContextStrip / SessionList /
 * WorkbenchPanel 等视觉组件消费。
 *
 * 关键约束（spec §6 明文）：
 * - running 优先于 failed（表行 3 vs 4）；Agent 持续工作时不得被历史失败态抢占。
 * - failed 与 delivered 非互斥：失败但产物在 → delivered，失败仅作次级 badge
 *   （§7.6），绝不吞掉可追溯的失败。
 * - delivered 优先于 review_ready（行 5 vs 6）：产物是比「一批编辑」更强的结果。
 * - 每一条谓词都必须有单测（§13）。
 */

import type { TaskBlockerView, TaskCriterionStatus, TaskLifecycleStatus, TaskRecordView, TaskStepView } from "./types";

export type TaskPresentationState =
  | "idle"
  | "running"
  | "needs_input"
  | "review_ready"
  | "delivered"
  | "failed";

/** 会话级状态域（与 spec §6 对齐；waiting 对应「等待用户输入」的会话态）。 */
export type SessionStatus =
  | "idle"
  | "running"
  | "waiting"
  | "completed"
  | "failed";

/** 权限/澄清请求的最小形态（字段足够判断「是否有面向用户的待处理输入」）。 */
export type PresentationPermission = {
  id: string;
  permission: string;
};

/** 纯函数输入（spec §6 PresentationContext）。 */
export type PresentationContext = {
  sessionId: string | null;
  sessionStatus: SessionStatus;
  permissionRequest: PresentationPermission | null;
  editedPaths: string[];
  previewablePaths: string[];
  /** 用户显式选定的右侧 tab（automatic/user 契约的 user 侧；此处仅记录，不影响状态派生）。 */
  explicitWorkbenchTab: "review" | "files" | "preview" | null;
  /** 用户显式选定的底部 debug tab（同上）。 */
  explicitDebugTab: "terminal" | "problems" | "output" | "debug" | null;
  /** 是否存在可审查的 git 变更（diff 非空）。 */
  hasGitChanges?: boolean;
  /** 当前持久任务（规格 3 §15.2）。**给了就由它决定状态**——那些从
   *  `editedPaths` / `previewablePaths` 反推的谓词是在没有任务契约的年代
   *  写下的近似，一旦有了权威的任务生命周期，近似就该让位。
   *  省略（历史会话 / 未启用任务层）时行为与改造前逐字一致。 */
  task?: TaskPresentationView | null;
};

/** 任务处于「系统正在自己推进」的状态。cancelled 刻意不算——它已经停了。 */
export function isTaskActive(status: TaskLifecycleStatus): boolean {
  return status === "queued" || status === "running" || status === "recovering" || status === "verifying";
}

/** 图标语义（icon kind）：不绑定具体 SVG，只给语义类型，视觉组件据此选图标。 */
export type IconKind =
  | "spark" // idle / 开始任务
  | "spinner" // running
  | "question" // needs_input
  | "diff" // review_ready
  | "artifact" // delivered
  | "error"; // failed

/** 次级失败 badge：delivered/review_ready 状态下仍要露出的底层失败（§7.6）。 */
export type FailureBadge = {
  /** 失败来源。终端命令只属于终端面板，不改变任务状态。 */
  kind: "session_failed";
  /** 简短可读提示。 */
  label: string;
};

/** 派生结果。 */
export type TaskPresentation = {
  state: TaskPresentationState;
  /** 可读状态文案（中文）。 */
  label: string;
  icon: IconKind;
  /** 视觉主角优先级：数值越大越该在屏上占据主要视线（配合 §2.2 层级表）。 */
  priority: number;
  /** 次级失败 badge（仅当状态非 failed、但底层确有失败时非 null）。 */
  failureBadge: FailureBadge | null;
};

const LABELS: Record<TaskPresentationState, string> = {
  idle: "就绪",
  running: "运行中",
  needs_input: "需输入",
  review_ready: "待审查",
  delivered: "已交付",
  failed: "失败",
};

const ICONS: Record<TaskPresentationState, IconKind> = {
  idle: "spark",
  running: "spinner",
  needs_input: "question",
  review_ready: "diff",
  delivered: "artifact",
  failed: "error",
};

/** §2.2 层级表映射出的视觉主角优先级（failed 与 running 同层，delivered 最高）。 */
const PRIORITIES: Record<TaskPresentationState, number> = {
  idle: 0,
  needs_input: 3,
  running: 2,
  failed: 2,
  review_ready: 1,
  delivered: 4,
};

/**
 * 有序谓词表：逐行求值，第一行条件命中的状态即返回。无跨行状态，每行只引用
 * PresentationContext 的字段（spec §6「no cross-row state」）。
 */
type PredicateRow = {
  state: TaskPresentationState;
  match: (ctx: PresentationContext) => boolean;
};

const ROWS: PredicateRow[] = [
  // 0a. 有任务且已交付 → delivered（规格 §14.3：**只有** task.delivered 能到
  //     这里。下面第 5 行那条「有可预览产物 → delivered」是任务层出现之前的
  //     近似判断，一旦有任务契约就不再使用它）。
  { state: "delivered", match: (ctx) => ctx.task?.status === "delivered" },
  // 0b. 有任务且失败 → failed
  { state: "failed", match: (ctx) => ctx.task?.status === "failed" },
  // 0c. 任务在等用户做具体动作（含 blocked）→ needs_input。这里的 waiting_*
  //     与 blocked 都成立：它们对用户的含义是同一件事——「球在你这边」。
  { state: "needs_input", match: (ctx) => ctx.task?.needsUser === true },
  // 0d. 任务在推进 → running。优先级低于 0a/0b 高于一切近似判断。
  { state: "running", match: (ctx) => ctx.task != null && isTaskActive(ctx.task.status) },
  // 1. 无会话，或会话无有意义任务事件 → idle
  //    （有意义事件 = 权限请求 / 编辑 / 可预览产物 / git 变更之一）
  {
    state: "idle",
    match: (ctx) =>
      ctx.sessionId === null ||
      (ctx.sessionStatus === "idle" &&
        ctx.permissionRequest === null &&
        ctx.editedPaths.length === 0 &&
        ctx.previewablePaths.length === 0 &&
        ctx.hasGitChanges !== true),
  },
  // 2. 有面向用户的权限/澄清请求，或会话本身处于等待态 → needs_input
  //
  //    补充（spec 缺口）：spec §6 表格行 2 只写了 `permissionRequest !== null`，
  //    但 `SessionStatus` 域里的 `"waiting"` 没有任何一行消费它。实测框架确实会
  //    在没有 PermissionRequest 的情况下进入等待态——runner 检测到 unknownSideEffect
  //    时发 `session.status: waiting_input`（zmzai-framework/src/core/runtime/runner.ts），
  //    此时 UI 既无 pending 卡片、状态也不是 running，若照抄 spec 会落到行 6/行 7，
  //    把「等你处理」显示成「待审查」甚至「就绪」。等待态的语义就是「面向用户在等」，
  //    因此这里把 `waiting` 与 permissionRequest 并列。
  {
    state: "needs_input",
    match: (ctx) => ctx.permissionRequest !== null || ctx.sessionStatus === "waiting",
  },
  // 3. Agent 会话运行中 → running（优先于 failed）。交互终端的 shell 本来就是
  //    常驻 PTY，不能把它误当成 Agent 任务运行。
  {
    state: "running",
    match: (ctx) => ctx.sessionStatus === "running",
  },
  // 4. 失败且无产物无编辑可看 → failed
  {
    state: "failed",
    match: (ctx) =>
      ctx.sessionStatus === "failed" &&
      ctx.previewablePaths.length === 0 &&
      ctx.editedPaths.length === 0,
  },
  // 5. 有可预览产物 → delivered（优先于 review_ready）
  { state: "delivered", match: (ctx) => ctx.previewablePaths.length > 0 },
  // 6. 有编辑或 git 变更 → review_ready
  {
    state: "review_ready",
    match: (ctx) => ctx.editedPaths.length > 0 || ctx.hasGitChanges === true,
  },
  // 7. 兜底 → idle
  { state: "idle", match: () => true },
];

/**
 * 派生底层失败 badge（§7.6）：当最终态是 delivered/review_ready，但底层确有失败时，
 * 仍要露出失败作为次级信息，而非吞掉。
 */
function deriveFailureBadge(
  ctx: PresentationContext,
  state: TaskPresentationState,
): FailureBadge | null {
  if (state === "failed") return null; // failed 本身就是主态，无需次级 badge
  if (ctx.sessionStatus === "failed") {
    return { kind: "session_failed", label: "会话执行失败" };
  }
  return null;
}

// ===== 持久任务（规格 3 §14）=====

/** 任务可执行的动作。**只有这五个**，且每个都必须能真的做成一件事
 *  （规格 §14.2 的清单是封闭的：任何额外按钮都要先证明它对应的状态存在）。
 *
 *  `authorize` 与 `resume` 的区别容易搞错：授权请求本身由权限卡片处理
 *  （那是唯一能给出「允许一次 / 始终允许 / 拒绝」三态的地方），任务条上的
 *  「授权并继续」只负责把用户送到那张卡片前；而 `resume` 是「用户核对完了，
 *  继续跑」——授权、登录、预算这三种情形下用户没有任何东西要**输入**，
 *  只能通过一次显式放行动作让任务重新开始推进。 */
export type TaskActionId = "authorize" | "supply_input" | "choose" | "recheck" | "stop";

export type TaskAction = {
  id: TaskActionId;
  label: string;
  /** 按钮下方/悬浮说明：这一下点下去会发生什么。 */
  hint: string;
  primary: boolean;
};

/** 视觉语气（映射到 @zmzai/theme 的语义色，组件不自己挑颜色）。 */
export type TaskTone = "idle" | "live" | "wait" | "warn" | "ok" | "danger";

export type TaskPresentationView = {
  status: TaskLifecycleStatus;
  label: string;
  tone: TaskTone;
  /** 步骤进度（规格 §14.1「2/5 已完成」）。无步骤时为 null，不假装 0/0。 */
  progress: { done: number; total: number; current: string | null } | null;
  actions: TaskAction[];
  /** **只有这里为 true 才允许说「任务完成」**（规格 §14.3 / §18.3 / §18.4）。
   *  UI 的 toast、系统通知、文档标题、列表勾选全部读它，不再读 summary.kind。 */
  completed: boolean;
  /** 正在等用户做一个具体动作（含 blocked）。 */
  needsUser: boolean;
};

/** 状态 → 文案 / 语气。用一张表而不是 switch，是为了让「11 个状态各有归属」
 *  这件事在类型层面可验证：漏一个键 TS 就会报错（记录类型要求全覆盖）。 */
const TASK_TONE: Record<TaskLifecycleStatus, { label: string; tone: TaskTone }> = {
  queued: { label: "排队中", tone: "idle" },
  running: { label: "执行中", tone: "live" },
  recovering: { label: "恢复中", tone: "live" },
  waiting_permission: { label: "等待授权", tone: "wait" },
  waiting_input: { label: "等待补充", tone: "wait" },
  waiting_external: { label: "等待外部状态", tone: "wait" },
  verifying: { label: "验证中", tone: "live" },
  delivered: { label: "已交付", tone: "ok" },
  blocked: { label: "已阻塞", tone: "warn" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已停止", tone: "idle" },
};

/** blocked 的细分提示：`blocked` 是一个状态，但预算耗尽与「副作用未知」
 *  要用户做的事完全不同，笼统的「已阻塞」等于什么都没说。 */
const BLOCKER_LABEL: Record<TaskBlockerView["kind"], string> = {
  permission: "等待授权",
  input: "等待补充信息",
  choice: "等待选择方案",
  external_auth: "等待登录",
  unsafe_replay: "外部状态待确认",
  budget: "已超出预算",
  no_progress: "没有实质进展",
};

/** 动作表：按「用户此刻能做什么」给，而不是按状态堆按钮（规格 §14.2）。
 *
 *  为什么授权/补充/选择不给 `resume`：那三种情形用户都要**在前面某个地方**
 *  做一件事（点授权卡片、在输入框打字），系统会在那件事发生时自己接着跑；
 *  再摆一个「继续」按钮只会让人以为不点就不走。 */
function actionsFor(task: TaskPresentationViewInput): TaskAction[] {
  const blocker = task.blocker;
  const out: TaskAction[] = [];
  if (blocker) {
    if (blocker.kind === "permission") {
      out.push({ id: "authorize", label: "授权并继续", hint: "跳到上方的授权卡片，选择允许或拒绝", primary: true });
    } else if (blocker.kind === "input") {
      out.push({ id: "supply_input", label: "补充信息", hint: "在下方输入框里补上任务需要的信息，发送后会接着做", primary: true });
    } else if (blocker.kind === "choice") {
      out.push({ id: "choose", label: "选择方案", hint: "在下方输入框里写下你选的方案，发送后会接着做", primary: true });
    } else if (blocker.resumable) {
      // external_auth / unsafe_replay / budget / no_progress：用户核对完外部状态后
      // 只能靠一次显式放行让任务重新推进——没有任何东西要他输入。
      out.push({ id: "recheck", label: "检查后重试", hint: blocker.requiredAction, primary: true });
    }
  }
  if (!isTaskTerminal(task.status)) {
    out.push({ id: "stop", label: "停止任务", hint: "中止这条任务，未确认的外部动作不会被重放", primary: false });
  }
  return out;
}

function isTaskTerminal(status: TaskLifecycleStatus): boolean {
  return status === "delivered" || status === "failed" || status === "cancelled";
}

/** 会话级状态：任务优先，其次才看会话自身（规格 3 §14.3 / §18.3）。
 *
 *  【为什么任务优先】`session.status` 说不了「任务做完了没有」——它在一个任务
 *  中途停一次（模型给出纯文本、一次 Attempt 结束）就会回到 idle。旧实现把
 *  `session.summary.kind === "completed"` 映射成 `completed`，于是「这一轮跑完
 *  了」被渲染成「任务完成了」，这正是规格 §3.2 的根因。
 *
 *  这个函数里**没有任何一条分支读 summary**。没有任务时宁可回 `idle`
 *  （意思是「现在没在跑」），也不拿「有 summary」当「做完了」——`idle` 不承诺
 *  完成，`completed` 承诺。 */
export function sessionStatusFor(status: string, task: TaskRecordView | null): SessionStatus {
  if (task) {
    if (task.status === "delivered") return "completed";
    if (task.status === "failed") return "failed";
    if (task.status === "cancelled") return "idle";
    if (task.status === "blocked" || task.status.startsWith("waiting_")) return "waiting";
    return "running";
  }
  if (status === "running") return "running";
  if (status === "waiting_permission" || status === "waiting_input") return "waiting";
  return "idle";
}

/** 会话列表条目的状态键（规格 §15.2 / §18.3）。
 *
 *  【旧实现在这里说「完成」】原来是 `lastOutcome ?? (title ? "completed" : "idle")`
 *  ——只要会话有标题就显示「完成」，而标题几乎总是有的（首条消息会被用作占位
 *  标题），于是列表里满屏「完成」，包括那些跑了一半就停下、还在等授权的任务。
 *  这正是规格 §18.3「required step 未完成时列表不得显示任务完成」要治的病。
 *
 *  现在有任务契约时一律由 `task.status` 决定；没有任务（历史会话 / 旧库）时
 *  只承认明确的失败与中断，其余一律「空闲」——不再把「有标题」当成「做完了」。
 *  这条规则与 `sessionStatusFor` 必须同步演进，但**取值域不同**：列表要多区分
 *  「中断」与「失败」，主区状态机不区分，所以是两个函数而不是一个加参数。 */
export function sessionListOutcome(item: {
  task?: TaskRecordView | null;
  awaitingPermission?: boolean;
  running?: boolean;
  lastOutcome?: string | null;
}): SessionListOutcome {
  const task = item.task;
  if (task) {
    if (task.status === "delivered") return "completed";
    if (task.status === "failed") return "error";
    if (task.status === "cancelled") return "aborted";
    if (task.status === "blocked" || task.status.startsWith("waiting_")) return "awaiting";
    return "running";
  }
  if (item.awaitingPermission) return "awaiting";
  if (item.running) return "running";
  if (item.lastOutcome === "error") return "error";
  if (item.lastOutcome === "aborted") return "aborted";
  return "idle";
}

export type SessionListOutcome = "completed" | "error" | "aborted" | "awaiting" | "running" | "idle";

export type TaskNoticeKind = "delivered" | "needs_user" | "failed";

/** 一条任务状态该触发的通知（规格 §14.3）。
 *
 *  `null` 表示**什么都不发**——包括 running / queued / recovering / verifying
 *  这些中间态。内部 Attempt 的收尾落在这一类里：一次 continuation 发生在任务
 *  内部，用户不需要知道「又跑了一轮」，更不该收到一句「任务完成」。 */
export type TaskNotice = {
  kind: TaskNoticeKind;
  /** 窗口标题。**只有真交付才改标题**：「任务完成」四个字写进标题栏是一种承诺，
   *  所以它绑定在 `delivered` 上，而不是「这一轮没报错」。 */
  title: string;
  toast: string;
  toastMs: number;
  /** 系统通知正文；null 表示这条状态不发系统通知。 */
  os: string | null;
  /** 是否走主进程那条只有固定文案的「任务完成」通道。它说的是「任务完成」，
   *  所以只给 delivered 用；blocked/failed 走 Web Notification，有正文可写。 */
  bridgeDone: boolean;
  /** 是否播放完成提示音。 */
  chime: boolean;
};

export function taskNotice(task: TaskRecordView | null): TaskNotice | null {
  if (!task) return null;
  if (task.status === "delivered") {
    return {
      kind: "delivered",
      title: "✓ 任务完成 — Lectern",
      toast: "任务已完成",
      toastMs: 4000,
      os: "任务已完成，回来看看结果",
      bridgeDone: true,
      chime: true,
    };
  }
  if (task.status === "blocked" || task.status.startsWith("waiting_")) {
    // 标签与进度卡上的状态文案同源（`presentTask`），否则会出现「卡片写等待授权、
    // 通知写任务等待中」这种同一条状态两种说法。
    const label = presentTask(task).label;
    return {
      kind: "needs_user",
      title: "Lectern",
      toast: `${label} · 需要你处理`,
      toastMs: 6000,
      os: `${label}：${task.blocker?.requiredAction ?? "回到 Lectern 处理"}`,
      bridgeDone: false,
      chime: false,
    };
  }
  if (task.status === "failed") {
    return {
      kind: "failed",
      title: "Lectern",
      toast: "任务失败，详情见执行轨迹",
      toastMs: 6000,
      os: "任务失败，回来看看原因",
      bridgeDone: false,
      chime: false,
    };
  }
  return null;
}

type TaskPresentationViewInput = { status: TaskLifecycleStatus; steps: Pick<TaskStepView, "title" | "status">[]; blocker?: TaskBlockerView };

/** 纯函数：TaskRecord → 呈现模型（规格 §14.1 / §14.2 / §14.3）。
 *
 *  【为什么要单独一层】状态文案、按钮、是否算完成这三件事此前散在 page.tsx 的
 *  `toSessionStatus`、ChatView 的 SummaryCard 与会话列表各自的 if 里，三处
 *  对「完成」的理解各不相同——这正是规格 §18.3 要治的病。收敛到这里之后，
 *  每个消费方读的是同一个 `completed`。 */
export function presentTask(task: TaskPresentationViewInput): TaskPresentationView {
  const base = TASK_TONE[task.status];
  const label = task.status === "blocked" && task.blocker ? BLOCKER_LABEL[task.blocker.kind] : base.label;
  const total = task.steps.length;
  const done = task.steps.filter((step) => step.status === "completed").length;
  const current = task.steps.find((step) => step.status === "in_progress")?.title ?? null;
  return {
    status: task.status,
    label,
    tone: base.tone,
    progress: total > 0 ? { done, total, current } : null,
    actions: actionsFor(task),
    completed: task.status === "delivered",
    needsUser: task.status === "blocked" || task.status.startsWith("waiting_"),
  };
}

/** framework `TaskRecord` → 界面视图（规格 §15.2）。
 *
 *  【为什么只发子集】一个长任务的 evidence 可以有几十条，而界面只画最近几条。
 *  整份下发会把 SSE 帧和 API 响应撑成以证据为主体的体积，而用户看不到大部分。
 *  这里连「最近几条」都裁到 12 条，并且只留 kind + summary（ref、id 对界面无用）。
 *
 *  类型按结构声明而不是 `import type { TaskRecord }`：本文件被客户端组件引用，
 *  结构声明把「Lectern 到底消费了 framework 的哪些字段」写进了代码——framework
 *  改字段时这里会先报错，而不是等到运行时读到 undefined 才在界面上少画一个数字。 */
export function toTaskView(task: {
  id: string;
  sessionId: string;
  goal: string;
  status: TaskLifecycleStatus;
  steps: readonly TaskStepView[];
  acceptanceCriteria: readonly TaskCriterionLike[];
  blocker?: TaskBlockerView;
  revision: number;
  attemptCount: number;
  constraints: readonly string[];
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  activeMs?: number;
  result?: { outcome: string; changes: readonly string[]; verification: readonly string[]; remaining: readonly string[] };
  evidence: readonly { kind: string; summary: string }[];
}): TaskRecordView {
  return {
    id: task.id,
    sessionId: task.sessionId,
    goal: task.goal,
    status: task.status,
    steps: task.steps.map((step) => ({ id: step.id, title: step.title, status: step.status, order: step.order })),
    acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      required: criterion.required,
      status: criterion.status,
    })),
    ...(task.blocker ? { blocker: task.blocker } : {}),
    revision: task.revision,
    attemptCount: task.attemptCount,
    constraints: [...task.constraints],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.deliveredAt ? { deliveredAt: task.deliveredAt } : {}),
    ...(task.activeMs !== undefined ? { activeMs: task.activeMs } : {}),
    ...(task.result ? { result: { ...task.result, changes: [...task.result.changes], verification: [...task.result.verification], remaining: [...task.result.remaining] } } : {}),
    evidence: {
      count: task.evidence.length,
      recent: task.evidence.slice(-12).reverse().map((item) => ({ kind: item.kind, summary: item.summary })),
    },
  };
}

/** framework 侧验收条件的结构下界。
 *
 *  写 `status: TaskCriterionStatus` 而不是 framework 的原始类型，是为了让「界面能
 *  画哪些状态」成为一条**编译期约束**：framework 将来新增一个状态值，这里会先
 *  报错，而不是让新状态在界面上静默落进某个 `else` 分支。 */
type TaskCriterionLike = { id: string; description: string; required: boolean; status: TaskCriterionStatus };

/**
 * 可预览产物判定：目前仅 HTML 家族（与成果预览的实际渲染能力一致）。
 *
 * 单点定义，供 WorkbenchPanel（自动推荐预览）与 page.tsx（组装
 * previewablePaths）共用——此前两处各写一份正则且不一致
 * （`/\.html?$/` 漏了 `.htm`），属于典型漂移，统一到此处。
 */
const PREVIEWABLE_RE = /\.(html?|htm)$/i;

export function isPreviewable(path: string): boolean {
  return PREVIEWABLE_RE.test(path);
}

/** 从一批路径中筛出可预览产物（保持原顺序）。 */
export function previewableOf(paths: string[]): string[] {
  return paths.filter(isPreviewable);
}

/**
 * 纯函数：把 PresentationContext 折叠为 TaskPresentation。
 * 无副作用、无 IO，同一输入恒得同一输出。
 */
export function deriveTaskPresentation(
  ctx: PresentationContext,
): TaskPresentation {
  for (const row of ROWS) {
    if (row.match(ctx)) {
      const state = row.state;
      return {
        state,
        label: LABELS[state],
        icon: ICONS[state],
        priority: PRIORITIES[state],
        failureBadge: deriveFailureBadge(ctx, state),
      };
    }
  }
  // 兜底（ROWS 末行恒真，理论不可达，防御性保留）
  return {
    state: "idle",
    label: LABELS.idle,
    icon: ICONS.idle,
    priority: PRIORITIES.idle,
    failureBadge: null,
  };
}
