# Lectern 持续任务执行与可信交付规格

**状态：** 待实施  
**日期：** 2026-09-17  
**适用仓库：** `zmzai-lectern`、`zmzai-framework`  
**优先级：** P0  
**目标版本：** 下一次包含 Agent 运行时改造的版本

## 1. 给实施模型的任务

重构 Lectern 的任务生命周期，使一条用户指令对应一个持续执行、可恢复、可验证的完整任务。模型一次输出结束、一次工具循环结束或一次 `run` 结束，都不能直接视为用户任务完成。

系统应在无需用户重复点击“继续下一步”的情况下，自动完成剩余步骤、执行必要验证并给出最终结果。只有遇到必须由用户授权、补充信息、选择方案，或存在无法安全自动恢复的外部状态时，任务才进入等待状态。

本任务同时修改 `zmzai-framework` 的运行时状态机和 `zmzai-lectern` 的产品呈现。不能只修改提示词或前端文案。

## 2. 用户问题与证据

当前体验存在三个直接问题：

1. Agent 会列出任务计划，但一轮模型调用结束后就停止。用户必须反复点击“继续下一步”，才能推动同一个目标。
2. 每一轮结束都会出现总结卡，但总结没有清楚区分“刚完成了一个阶段”和“整个任务已经交付”。用户不知道 Agent 做到哪里、还剩什么、是否需要自己介入。
3. 页面显示“任务完成”，正文却说“仍无法确认”“建议手动执行”“通过后再继续”。系统的完成状态和用户对完成的理解不一致。

截图中的典型冲突包括：

- 任务计划仍为 `0/5`，运行已经结束。
- 页面提供统一的“继续下一步”按钮，点击后发送一条新的合成用户消息。
- 卡片标题显示“任务完成”，正文同时声明推送、线上页面和图片均未验证。

这会让用户把执行控制、进度判断和收尾判断都承担下来，Agent 更像一个需要逐轮催促的对话模型，而不是能负责交付的工作代理。

## 3. 当前实现的根因

### 3.1 单次运行状态被当成完整任务状态

`zmzai-framework/src/core/runtime/runner.ts` 在 `agent.prompt()` 返回后，把没有抛错的运行记为 `completed`，并发布：

- `session.status: idle`
- `session.summary: { kind: "completed" }`
- `workflow_run.status: completed`

这些状态只能证明一次运行已经正常结束，不能证明用户目标已经实现。

### 3.2 前端把 `session.summary.completed` 映射成“任务完成”

当前 Lectern 中：

- `components/ChatView.tsx` 的 `SummaryCard` 把 `completed` 渲染成“任务完成”。
- `app/page.tsx` 的 `toSessionStatus`、通知和标题更新逻辑，把 `running → idle` 且存在 completed summary 当成任务完成。
- `components/ReviewPane.tsx` 同样把该状态显示为“已完成”。
- `lib/chat-projector.ts` 把 `session.summary` 当作每轮终态，并在收到它时封存本轮产物。

因此，系统把“模型停下来了”误报成“用户要的结果已经做好了”。

### 3.3 “继续下一步”通过伪造新用户轮次维持任务

`components/ChatView.tsx` 当前点击“继续下一步”会发送：

> 基于上面的任务总结，请继续完成你建议的下一步工作，直接开始执行。

这会产生新的用户消息和新的 workflow run。任务目标、验收条件和剩余步骤只能依赖上下文猜测，经过多轮或上下文压缩后容易漂移。

### 3.4 缺少独立、持久化的任务契约

当前已有 `todo.updated`、checkpoint、workflow run、lease 和 permission 等能力，但缺少一份跨 run 存续的任务记录，用于回答：

- 用户最终想得到什么；
- 什么条件满足后才算完成；
- 当前正在执行哪一步；
- 哪些步骤已经验证；
- 为什么暂停；
- 下一次内部续跑应从哪里继续。

## 4. 设计目标

### 4.1 必须实现

1. 一条用户指令创建一个持久任务；一个任务可以包含多次内部模型运行和工具调用。
2. 任务仍有必要工作时，模型一次停止后自动续跑，不创建新的用户消息。
3. 运行过程持续展示当前步骤、已完成步骤、最近进展和验证结果。
4. 只有达到明确的验收条件并记录验证证据后，才能标记为已交付。
5. 权限、用户独有信息、用户选择和不安全重试等真实阻塞可暂停任务；收到回复后继续同一任务。
6. 处理上游超时、工具失败、进程重启和上下文压缩，同时防止无限循环与重复副作用。
7. 移除主流程中的通用“继续下一步”和每轮“任务完成”卡片。

### 4.2 本期不做

- 不重做聊天消息的完整视觉系统。
- 不要求模型为所有简单问答生成五步计划。
- 不建设跨会话项目管理系统或多人任务分配系统。
- 不把用户新发的独立目标自动合并进当前任务。
- 不通过无限增加模型步数解决问题。

## 5. 核心概念

### 5.1 Session、Task、Attempt 的边界

| 概念 | 含义 | 生命周期 |
|---|---|---|
| Session | 用户与 Agent 的会话容器 | 可包含多个先后执行的任务 |
| Task | 一条用户目标及其验收条件 | 从接受指令到交付、失败或取消 |
| Attempt | Task 的一次内部模型运行 | 可以正常停止、报错或被中断 |
| Step | Task 中可跟踪的工作项 | pending → in_progress → completed/blocked/cancelled |

`Attempt completed` 只表示一次内部运行正常结束。只有 `Task delivered` 才能在 UI 中显示“任务完成”。

### 5.2 交互原则

- 进度是给用户看的信息，不是每轮都要用户审批的关卡。
- Agent 自己安排步骤、执行、检查、修复和收尾。
- 用户可以随时发送纠正或补充信息。该消息更新当前任务约束并唤醒任务，不应制造两个并行写入同一工作区的根任务。
- 需要用户时必须说清楚：卡在哪里、为什么只能由用户处理、用户做什么后会自动继续。

## 6. 持久化领域模型

在 framework 中新增持久化 `TaskRecord`。它不能只存在于 React 状态或模型上下文中。

```ts
type TaskLifecycleStatus =
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

type TaskStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "cancelled";

type AcceptanceCriterionStatus =
  | "pending"
  | "passed"
  | "failed"
  | "not_applicable";

type AcceptanceCriterion = {
  id: string;
  description: string;
  required: boolean;
  status: AcceptanceCriterionStatus;
  evidenceIds: string[];
};

type TaskStep = {
  id: string;
  title: string;
  status: TaskStepStatus;
  order: number;
  startedAt?: string;
  completedAt?: string;
  evidenceIds: string[];
};

type TaskEvidence = {
  id: string;
  kind: "tool_result" | "file_diff" | "command" | "test" | "preview" | "external_check" | "model_observation";
  summary: string;
  ref?: string;
  createdAt: string;
};

type TaskBlocker = {
  kind:
    | "permission"
    | "input"
    | "choice"
    | "external_auth"
    | "unsafe_replay"
    | "budget"
    | "no_progress";
  message: string;
  requiredAction: string;
  resumable: boolean;
};

type TaskRecord = {
  id: string;
  sessionId: string;
  rootRequestId: string;
  rootUserMessageId: string;
  goal: string;
  status: TaskLifecycleStatus;
  acceptanceCriteria: AcceptanceCriterion[];
  steps: TaskStep[];
  currentStepId?: string;
  evidence: TaskEvidence[];
  blocker?: TaskBlocker;
  revision: number;
  attemptCount: number;
  noProgressCount: number;
  constraints: string[];
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
};
```

要求：

- `TaskRecord` 更新采用 revision/CAS 或事务，避免重复 runner 同时推进同一任务。
- 每个 session 同一时间最多有一个会写工作区的 active root task。
- `goal`、验收条件、当前步骤和 blocker 必须进入上下文压缩后的恢复上下文。
- 简单问答可以只有一个隐式验收条件，不强制生成复杂计划。
- `todo.updated` 可暂时作为步骤投影，但不能继续作为唯一的任务来源。

## 7. 任务事件协议

在 `src/core/events/manifest.ts` 新增以下事件，所有事件都带 `taskId` 和 `revision`：

```ts
"task.started"
"task.plan.updated"
"task.step.started"
"task.step.progress"
"task.step.completed"
"task.recovery.started"
"task.blocked"
"task.verification.started"
"task.delivered"
"task.failed"
"task.cancelled"
```

建议载荷：

```ts
type TaskEventBase = { taskId: string; revision: number };

type TaskProgressData = TaskEventBase & {
  stepId?: string;
  message: string;
  completedSteps: number;
  totalSteps: number;
  evidenceId?: string;
};

type TaskDeliveredData = TaskEventBase & {
  result: string;
  evidenceIds: string[];
  filesEdited: number;
  toolCalls: number;
  durationMs: number;
};
```

兼容要求：

- 保留读取旧 `session.summary` 事件的能力。
- 新运行可以继续发布 `session.summary`，但语义改名为“attempt summary”，UI 只能在“执行轨迹”中显示，不能驱动任务完成状态。
- 如需要修改线协议，优先新增 `task.attempt.finished`，并在迁移期双写；不要直接改变旧事件结构导致历史重放失败。
- `todo.updated` 与 `task.plan.updated` 在迁移期双向投影，最终以 `TaskRecord` 为准。

## 8. 持续执行循环

### 8.1 总流程

```text
接收用户消息
  → 创建或更新 TaskRecord
  → 获取 task execution lease
  → 构造包含任务契约的模型上下文
  → 执行一次 Attempt
  → 持久化工具结果、步骤、证据和 Attempt 结果
  → 运行 Completion Gate
      ├─ 已满足全部验收条件 → task.delivered
      ├─ 必须等待用户/外部状态 → task.blocked 或 waiting_*
      ├─ 可恢复失败 → task.recovering → 内部续跑
      └─ 工作仍未完成 → 内部续跑
```

### 8.2 内部续跑

当 Attempt 正常停止但 Completion Gate 判定任务未完成时：

1. 不追加 `role: user` 消息。
2. 不调用前端 `/prompt` 模拟用户继续。
3. 创建与同一 `taskId/rootRequestId` 关联的内部 continuation job。
4. continuation 上下文明确包含原始目标、验收条件、剩余步骤、已有证据、最近失败和恢复建议。
5. 继续使用 session 级串行队列和 lease，禁止和用户新任务并行修改同一工作区。

可在 framework 内新增 `WorkflowRun.kind: "user_prompt" | "task_continuation" | "recovery"`。只有 `user_prompt` 创建用户消息。

### 8.3 模型停止不等于任务完成

以下任意情况都不能单独触发 `task.delivered`：

- 模型返回 `finish_reason: stop`；
- `agent.prompt()` resolve；
- 达到单次 Attempt 的 step 上限；
- 本轮没有工具调用；
- `session.status` 进入 idle；
- `session.summary.kind === "completed"`；
- 模型在文字中声称“已完成”。

达到单次 step 上限时，应关闭当前 Attempt、保存进度并创建 continuation，而不是要求用户继续。

## 9. Completion Gate：可信完成判定

新增独立的、可单元测试的 `evaluateTaskCompletion(task, runtimeState)`。只有同时满足以下条件，才返回 `delivered`：

1. 所有 `required: true` 的验收条件状态为 `passed`。
2. 不存在 `pending`、`in_progress` 或 `blocked` 的必要步骤。
3. 每个关键验收条件至少关联一条有效 evidence。
4. 没有未解决的 permission、unknown side effect、工具错误或外部状态不确定性。
5. 最终交付文本已经生成，包含结果、主要改动、验证证据和未完成项。

如果模型认为目标不可完成：

- 需求本身失败且无法修复：`failed`。
- 可以继续但需要用户动作：`waiting_*` 或 `blocked`。
- 无法验证关键结果：`blocked` 或 `failed`，不能 `delivered`。

对于纯解释、写作等无需工具的任务，验收条件可以通过最终内容本身作为 `model_observation` evidence；仍需明确经过 Completion Gate。

## 10. 恢复、重试与防空转

### 10.1 进度指纹

每次 Attempt 后计算进度指纹，至少包含：

- Task revision；
- 步骤状态集合；
- 验收条件状态集合；
- 新增/修改文件及 revision；
- 新 evidence；
- 有效工具结果摘要。

如果连续 Attempt 的指纹无变化，增加 `noProgressCount`。

默认策略：

1. 第一次无进展：注入恢复指令，要求重新读取现场并解释阻塞点。
2. 连续两次无进展：切换策略，优先做诊断或缩小步骤。
3. 连续三次无进展：进入 `blocked(no_progress)`，清楚告诉用户已尝试什么、卡在哪里、需要什么。

阈值应可配置并有上限测试。

### 10.2 错误分类

| 情况 | 行为 |
|---|---|
| 上游 429/5xx/断流 | 有限退避重试；仍失败则 recovering/blocked |
| 幂等只读工具超时 | 可自动重试 |
| 写操作返回明确失败且未产生副作用 | 可修复后重试 |
| 写操作结果未知 | `blocked(unsafe_replay)`，先检查外部状态 |
| 权限不足 | `waiting_permission` |
| 登录失效/验证码 | `waiting_external` |
| 缺少只能由用户提供的信息 | `waiting_input` |
| 达到时间/token/费用预算 | `blocked(budget)` |
| 用户主动停止 | `cancelled` |

不能把命令“没有输出”本身当作成功或完成。先检查退出码、进程状态、目标文件或外部系统状态。

### 10.3 重启恢复

当前 `lease-recovery.ts` 会把 in-progress todo 全部改为 cancelled。改造后应：

- 保留 TaskRecord 和已完成步骤。
- 把正在运行的 Attempt 标为 interrupted。
- 将未知副作用的工具标为需要核验。
- 安全可续的任务进入 `recovering` 并自动排入 continuation。
- 不能安全判断的任务进入 `blocked(unsafe_replay)`。
- 不得因为服务重启把整个任务显示为“完成”或静默 idle。

## 11. 权限与用户输入

权限卡仍可中断当前工具调用，但它属于同一个 task：

1. 发布 `task.blocked(permission)` 和 `session.status: waiting_permission`。
2. 用户授权后恢复当前 task，不创建新用户消息。
3. 用户拒绝后把拒绝结果返回模型，让其尝试替代方案；只有没有替代方案时才 blocked/failed。

仅在以下场景要求用户介入：

- 明确的高风险或受控权限；
- 缺失信息确实无法从工作区、工具或已有上下文获得；
- 两个方案会产生明显不同且不可逆的业务结果；
- 外部登录、验证码、付款等只能由用户完成；
- 工具副作用未知，自动重放可能重复提交、覆盖或发布。

不要为了让用户“确认计划”而暂停。计划可见，但默认直接执行。

## 12. 用户追加消息的语义

当 task 正在运行时，用户仍可发消息：

- 明确纠正、补充约束、回答问题：作为 task steering，追加到约束并触发安全重规划。
- 明确要求停止：取消 task。
- 明确提出无关的新目标：排入 session 队列，等待当前 task 交付或停止。

服务端应完成分类并给前端返回 disposition，例如：

```ts
type PromptDisposition =
  | "task_started"
  | "task_steered"
  | "task_resumed"
  | "queued_new_task";
```

不能让 steering 消息与当前 task 各自启动并发 runner。

## 13. API 与存储改造

### 13.1 Prompt API

`POST /api/sessions/:id/prompt` 返回：

```ts
{
  ok: true,
  taskId: string,
  rootRequestId: string,
  disposition: PromptDisposition
}
```

请求仍需 request idempotency key。重复请求不得创建第二个 task 或第二条用户消息。

### 13.2 Task API

新增：

- `GET /api/sessions/:id/task`：返回当前 active task 或最近一个 terminal task。
- `POST /api/sessions/:id/task/actions`：执行 `stop`、`retry`、`resume` 等显式动作。

`resume` 只用于 blocked/recovery 状态。正常运行中的 task 不需要“继续”。

### 13.3 SSE

SSE 按原 session 流传递 task 事件。客户端以 `seq + taskId + revision` 去重、排序和重放。断线重连后必须从持久事件恢复任务进度，不能只依赖当前页面内存。

### 13.4 存储

在现有 `SessionStore`/SQLite 与产品存储实现中增加 TaskStore 能力：

```ts
interface TaskStore {
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  getActiveTask(sessionId: string): Promise<TaskRecord | null>;
  updateTask(taskId: string, expectedRevision: number, patch: TaskPatch): Promise<TaskRecord>;
  listTasks(sessionId: string): Promise<TaskRecord[]>;
}
```

迁移必须支持已有数据库启动，不删除历史 session、message、part 或 event。

## 14. Lectern 界面改造

### 14.1 会话主区

移除 `SummaryCard` 的通用“继续下一步”按钮。每次 Attempt 的总结默认进入可折叠的“执行轨迹”，不再插入醒目的“任务完成”卡片。

任务运行时显示紧凑进度区：

- 当前步骤，如“正在迁移 6 张图片”；
- 进度，如“2/5 已完成”；
- 最近一个有意义的里程碑，如“已解析 PDF 12 页”；
- 运行时间；
- 可展开的计划与执行轨迹。

只在 `task.delivered` 后显示最终交付卡。内容固定回答：

1. 做成了什么；
2. 改了哪些主要内容；
3. 如何验证；
4. 是否仍有未完成项。

### 14.2 按钮

只显示与当前状态对应的动作：

- `授权并继续`
- `补充信息`
- `选择方案`
- `检查后重试`
- `停止任务`

禁止在正常 Attempt 结束后显示无上下文的“继续下一步”。

### 14.3 状态、标题与通知

- `running → idle` 不再触发“任务完成”toast、系统通知或文档标题。
- 只有 `task.delivered` 触发“任务完成”。
- `task.blocked` 触发一次需要用户处理的通知。
- `task.failed` 触发失败通知。
- `task.attempt.finished`、checkpoint 和内部 continuation 不弹系统通知。

### 14.4 文案约束

- “已完成”只用于已通过 Completion Gate 的 task 或明确完成的 step。
- 单次运行使用“本轮已结束”“阶段进展”或只在轨迹中显示，不使用“任务完成”。
- blocker 必须写明下一步动作，不能只说“请继续”。

## 15. 建议代码改动范围

### 15.1 `zmzai-framework`

重点修改：

- `src/core/runtime/runner.ts`
  - 将一次 Attempt 运行与 Task 生命周期拆开。
  - 在 Attempt 后执行 Completion Gate。
  - 未完成时创建内部 continuation。
  - 保留 session 串行执行和 lease 约束。
- `src/core/session/workflow.ts`
  - 增加 run kind、taskId、attempt ordinal 和 continuation receipt。
  - workflow `completed` 明确仅代表 Attempt/Job 完成。
- `src/core/session/store.ts` 及各存储实现
  - 新增 TaskStore、CAS 更新和迁移。
- `src/core/events/manifest.ts`
  - 新增 task 事件 schema。
- `src/core/runtime/lease-recovery.ts`
  - 按 task 语义恢复，不再无条件取消所有剩余步骤。
- `src/core/runtime/loop-guard.ts`
  - 扩展为跨 Attempt 的 no-progress 检测。
- `src/core/runtime/compaction.ts` 或对应上下文构造
  - 强制保留任务契约。
- 对应的 runner、workflow、store、recovery、event tests。

### 15.2 `zmzai-lectern`

重点修改：

- `components/ChatView.tsx`
  - 删除合成“继续”用户消息。
  - Attempt summary 移入轨迹。
  - 渲染 active task 进度与 delivered card。
- `components/TaskContextStrip.tsx`
  - 使用 TaskRecord 状态和步骤，而不是 session summary 推断。
- `components/SessionList.tsx`
  - 从 task lifecycle 显示运行、等待、阻塞和完成。
- `components/ReviewPane.tsx`
  - 区分 Attempt 结束和 Task 交付。
- `app/page.tsx`
  - 删除 `summary.kind` 驱动的完成状态、toast、标题和通知。
  - 监听 `task.delivered/blocked/failed`。
- `lib/chat-projector.ts`
  - 投影 task 事件；`session.summary` 仅作为 activity item。
- `lib/task-presentation.ts`
  - 统一 task 状态、按钮和文案映射。
- `lib/types.ts`、`lib/client.ts`
  - 增加 TaskRecord、事件和 API 类型。
- `app/api/sessions/[id]/prompt/route.ts`
  - 返回 task receipt/disposition。
- `app/api/sessions/[id]/events/route.ts`
  - 透传 task 事件。
- 新增 `app/api/sessions/[id]/task/route.ts` 和 task action route。

Lectern 当前使用 `vendor/zmzai-agent-framework-0.5.2.tgz`。必须先修改相邻的 `zmzai-framework` 源码、运行 framework 测试并构建新的包，再更新 Lectern 的 vendor tarball、版本引用和 lockfile。不得直接修改 `node_modules`。

## 16. 关键实现顺序

### 阶段 A：领域与存储（P0）

1. 新增 TaskRecord、状态枚举、TaskStore 和数据库迁移。
2. 新增 task 事件及解析测试。
3. Prompt 创建 task，并把 taskId 写入 workflow run。
4. 上下文构造始终带入任务契约。

### 阶段 B：运行时（P0）

1. 抽出 Attempt 运行函数，保留现有工具、权限和 retry 能力。
2. 实现 Completion Gate。
3. 实现不创建用户消息的 continuation job。
4. 实现同 session/task 的 lease、CAS 和重复触发保护。
5. 把 permission 回复、steering 和 retry 恢复到原 task。

### 阶段 C：界面（P0）

1. 前端订阅并投影 task 事件。
2. 移除“继续下一步”合成消息路径。
3. 改造进度区、状态、通知和最终交付卡。
4. 历史 `session.summary` 降级为执行轨迹。

### 阶段 D：恢复与保护（P1，但应随本任务一起验收）

1. 跨 Attempt no-progress guard。
2. 未知副作用处理。
3. 重启后的任务恢复。
4. 预算、最长运行时间和最大 Attempt 数配置。

## 17. 测试要求

### 17.1 Framework 单元测试

必须覆盖：

1. 有 required todo 未完成时，Completion Gate 不得返回 delivered。
2. 所有 required criteria passed 且有 evidence 时，才返回 delivered。
3. 模型连续三次正常 stop，但每次仍有剩余步骤时，自动创建 continuation，不新增用户消息。
4. continuation job 与原始 taskId、rootRequestId 一致。
5. 权限等待后回复，继续同一 task。
6. permission reject 后模型可走替代方案。
7. 可重试网络错误有限退避，次数耗尽后 blocked/failed。
8. unknown side effect 不自动重放。
9. 连续三次无进展进入 blocked(no_progress)。
10. 并发触发不会创建两个 active runner。
11. 重复 requestId 不创建重复 task 或用户消息。
12. compaction 后保留 goal、criteria、remaining steps 和 blocker。
13. 进程重启后安全任务恢复，不安全任务进入 unsafe_replay。

### 17.2 Lectern 单元/组件测试

必须覆盖：

1. `session.summary.completed` 不再显示“任务完成”。
2. 页面不存在通用“继续下一步”按钮和对应合成 prompt。
3. 只有 `task.delivered` 触发完成 toast、系统通知和标题。
4. task running 显示当前步骤和 x/y 进度。
5. waiting_permission、waiting_input、blocked 显示对应上下文动作。
6. SSE 重放不会重复累计步骤或通知。
7. 历史 session summary 仍可在执行轨迹查看。

### 17.3 端到端场景

#### 场景 A：PDF 内容铺到网页

单条用户消息：“把这个 PDF 的内容完整铺到网页上，并验证页面可用。”

模拟步骤：

1. 读取 PDF；
2. 提取正文和图片；
3. 更新网页；
4. 构建/启动；
5. 浏览器检查关键内容和资源；
6. 修复发现的问题；
7. 最终交付。

预期：用户不点击继续；页面实时显示步骤；模型中途 stop 时自动 continuation；最终卡片给出文件、构建结果和页面检查 evidence。

#### 场景 B：推送失败

执行到 Git push 时凭据失效。

预期：前面的本地改动仍显示已完成；任务进入 `waiting_external`，说明需要登录；登录完成后恢复同一 task 并继续验证，不显示任务完成。

#### 场景 C：命令无输出

命令长时间无输出且副作用不明。

预期：先检查进程与目标状态；不能确认时进入 `blocked(unsafe_replay)`；不把无输出当成成功，也不盲目重复提交。

#### 场景 D：应用重启

执行第三步时关闭并重启应用。

预期：前两步和证据仍在；第三步按副作用安全性恢复或请求检查；任务不会回到空白 idle，也不会显示完成。

## 18. 验收标准

以下条件全部满足才可关闭本任务：

1. 一个包含至少五个步骤的模拟任务可由一条用户消息启动并自动完成，全程无需“继续下一步”。
2. 模型在任务中途正常结束至少三次时，系统自动续跑，聊天记录中没有合成用户消息。
3. 任一 required step/criterion 未完成时，UI、通知和 session 列表均不会显示“任务完成”。
4. 任务完成状态只由持久化 `task.delivered` 驱动，并有验收 evidence。
5. 权限通过或用户补充信息后，恢复原 task，不创建新 root task。
6. 工具超时、网络错误、未知副作用、无进展和服务重启均有明确、可测试的状态转换。
7. 最终交付信息包含结果、主要改动、验证方式和剩余项；无剩余项时明确为“无”。
8. 正常内部 Attempt、checkpoint 和 continuation 不触发完成通知。
9. 同一 session 不会有两个 active root task 并发修改工作区。
10. 历史会话仍能加载，旧 summary 不再被误判为新 Task 的 delivered。
11. Framework 与 Lectern 的类型检查、单元测试、构建及 PDF 场景 E2E 全部通过。

## 19. 明确禁止的实现

- 不得只修改 system prompt，让模型“尽量继续”。
- 不得在前端自动点击或隐藏“继续下一步”。
- 不得用新增一条伪用户消息作为内部 continuation。
- 不得用 `session.status === idle`、模型 stop 或 summary completed 判断任务完成。
- 不得把 TaskRecord 只放在 localStorage 或 React 状态。
- 不得无限续跑；必须有 no-progress、预算和副作用保护。
- 不得自动重试结果未知的外部写操作。
- 不得直接修改 `node_modules` 中的 framework。
- 不得把“无法验证”包装成“已完成但建议用户检查”。

## 20. 交付物

实施完成后应提交：

1. `zmzai-framework` 的 TaskRecord、事件、store、continuation、Completion Gate、恢复逻辑和测试。
2. 新的 framework 包及 Lectern vendor/lockfile 更新。
3. Lectern 的 task API、投影、状态组件、通知逻辑和测试。
4. 一份状态迁移说明，列出旧 `session.summary` 与新 task lifecycle 的兼容关系。
5. PDF 场景 E2E 的运行记录或测试报告。
6. 最终变更说明，明确完成判定依据和仍存在的限制。

## 21. 产品结果示例

任务运行中：

> 正在更新网页 · 3/6  
> 已完成 PDF 解析和图片提取，正在把第 4–8 页内容写入页面。

真实阻塞：

> 需要登录 GitHub 才能继续推送。网页本地构建和检查已经通过；登录完成后我会继续推送并检查线上页面。

最终交付：

> 已把 PDF 的 12 页内容和 18 张图片铺到网页，并修复了两处移动端溢出。`pnpm build` 通过，浏览器检查确认目录跳转、正文和图片均可访问。剩余项：无。

这三种状态必须由持久任务状态和验证 evidence 驱动，而不是由一轮模型文案自行声明。
