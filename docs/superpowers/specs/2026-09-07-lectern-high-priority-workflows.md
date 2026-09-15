# Lectern 高优先工作流 Spec

- 状态：Draft，待产品确认；本文不是功能完成报告。
- 日期：2026-09-07。
- 基线：Lectern 0.5.1，Next.js 15 + React 19 + Electron，共用 Web/API 层。
- 范围：一个 Epic，六条产品工作流，按可独立验收的小任务实施。
- 本次交付：仅本地规格文档；不创建远程 Issue、不启动实现、不发布版本。
- 需求来源：`docs/p0-p1-tracker.md` 的 Next Batch 与 Additional High-Priority Requests。

## 1. 目标与成功标准

让 macOS / Windows 用户能完成连续流程：选合适的模型，提交文字和附件，离开当前会话后继续管理任务，遇到断线或余额不足时保留进度，最后审查、下载或接受可信结果。

用户不需要理解 provider、事件流或 Git CAS 才能完成主流程，但这些机制必须保证不串项目、不重复执行、不丢附件、不把未验证结果展示为成功。现在优先补齐工作流，而不是再重做一套外观。

成功标准：

1. 六条工作流都有下文定义的端到端证据；组件存在、单测通过不等于工作流完成。
2. 同一发送操作在超时、重连、双击后只创建一个用户消息和一个运行请求。
3. 断线恢复后，文本、工具状态、附件和任务状态与服务端一致，无重复文本增量。
4. 跨项目操作不依赖当前 UI 所选项目；错误归属请求不能读取或修改另一项目数据。
5. 用户看到真实执行模型和有来源的价格；未知价格/余额显示未知，不显示为零。
6. 交付只接受当前 attempt 的已审查快照；冲突、证据变化、未知工具副作用均不能被自动忽略。

## 2. 已核实现状

核验方式：2026-09-07 静态阅读工作区源码。以下不是本轮运行测试的结论。framework 源码为相邻仓库，实际安装依赖仍是 vendor 中的 0.4.1 包；实施前须比对源码与该包，修改后正式更新依赖及锁文件。

| 能力 | 现状与缺口 | 代码定位（仓库相对路径） |
| --- | --- | --- |
| 消息分页 | API 先读取全会话，再按 tail/skip 切片；不是数据库分页；新增消息期间 offset 会漂移 | `app/api/sessions/[id]/messages/route.ts:18`，framework `src/core/session/sqlite-store.ts:158` |
| 历史与实时消息 | 先订阅、缓存实时事件，再灌入历史；需要明确快照水位与重放边界 | `app/page.tsx:542` |
| SSE 重连 | 已带 since 游标，服务端带 seq；客户端仍向投影器传递重复 seq，delta 采用追加 | `lib/client.ts:306`，`lib/chat-projector.ts:130`，`app/api/sessions/[id]/events/route.ts:21` |
| 搜索 | 跨项目遍历转录、每会话取首个命中、最多 30 个；没有 messageId/partId 定位 | `app/api/sessions/search/route.ts:10` |
| 任务中心 | 已有跨项目列表、分组、未读任务数；尚非持久化逐消息已读状态 | `lib/task-groups.ts:3`，`components/SessionList.tsx` |
| 项目归属 | 非隔离 sessionRuntime 回落到当前项目 runtime；已有跨项目查 store 的辅助函数可复用 | `lib/runtime.ts:412`，`lib/runtime.ts:420` |
| 附件 | 独立 InputAttachment；最多 5 个文本/代码文件，每个 512 KiB；前端同名去重、没有独立读取状态 | `lib/types.ts:69`，`components/Composer.tsx:338` |
| 附件发送与回溯 | 校验后传入 runner；失败保留输入；rewind 从 file part 恢复 data URL | `app/api/sessions/[id]/prompt/route.ts:25`，`app/api/sessions/[id]/rewind/route.ts:59` |
| 执行排队 | runner 支持运行中排队；需要补齐请求标识及模型、图片等完整队列载荷 | framework `src/core/runtime/runner.ts:221` |
| 交付 | 已有 immutable snapshot、attempt、Git CAS；API 多数动作取 active attempt，commands 上传只算 advisory | `lib/delivery-types.ts:18`，`app/api/deliveries/attempt/route.ts:66` |
| 模型 | relay + Ollama 目录、窗口/推理力度缓存、手动选择和 failover；尚无结构化场景价格路由契约 | `app/api/models/route.ts:16`，`lib/model-caps.ts:18`，`lib/relay.ts:25` |
| 凭据 | 已有 AES-GCM 文件存储；不能因此声称已具备系统凭据库保护 | `lib/settings.ts:29` |
| 余额恢复 | API 客户端把错误转为普通 Error；本次在 app/lib/components/electron 未找到充值/余额处理链路 | `lib/client.ts:41`，`components/AccountBlock.tsx` |

必须保留：账户菜单中的设置入口、现有桌面外壳和主题、附件与用户正文分离、隔离 worktree、交付快照/CAS、无签名的应用内下载更新策略。本文不改变此前可信交付 spec 的证据与预算原则。

## 3. 范围与排期

P0 是本 Epic 内的数据/执行安全前置，不代表取代 tracker 中的发布安全 P0。P1 是已确认的高优先产品工作流。模型与充值原先未定相对顺序，本文建议在核心消息/任务/附件链路之后上线；契约确认可提前。

| 工作流 | 最小可验收交付 | 优先级 | 前置 |
| --- | --- | --- | --- |
| F0 共用基础 | 项目归属、稳定游标、请求幂等、结构化错误、恢复边界 | P0 | 无 |
| M 消息体验 | 会话内搜索、未读、长历史、可靠重连与错误状态 | P1 | F0 |
| T 后台任务中心 | 跨项目状态、停止/重试/继续/复制和防重复执行 | P1 | F0；复用 M 已读数据 |
| A 文件附件 | 添加、读取、持久化、发送、恢复、下载完整链路 | P1 | F0 |
| D 交付工作流 | 审查、退回、丢弃、快照导出、接受、回滚 | P1 | F0、M/T/A 的任务与证据关联 |
| R 模型选择 | 场景推荐、性价比/效果偏好、自定义模型、费用展示 | P1 | F0；真实目录与价格来源 |
| B 余额恢复 | 账户入口、402 提示、保留进度、支付返回后显式继续 | P1 | F0、R 的账户来源；真实计费契约 |

```text
F0 项目归属 / 请求幂等 / 事件和恢复契约
  +--> M 消息查询与已读 --> T 任务视图和操作
  +--> A 附件生命周期 ---+--> D 交付证据与导出
  +--> R 模型来源与策略 -----> B 余额识别与恢复

计费契约确认 ----------------> B 支付接入
```

先保证执行对象和请求身份，再做管理入口；否则任务中心会扩大跨项目误操作和重复运行风险。附件存储与模型配置可在基础契约稳定后独立推进。充值缺少后端依赖不得阻塞其他五项，也不得用假支付流程冒充完成。

## 4. F0：共用契约

以下均为拟新增/扩展契约，不是现有 API。UI DTO 放 `lib/types.ts`，执行、队列、转录与事件一致性归 framework；项目归属及本地宿主安全归 Lectern。不得仅修改 node_modules 或靠前端 localStorage 实现执行一致性。

### 4.1 身份与错误

所有会话 API 从持久化项目/session/worktree 映射解析根目录，找不到返回 404，不回落到活动项目。新增查询响应总是包含 projectId；客户端不能提交任意 workspaceRoot。worktree 已消失时返回可恢复错误，不偷偷改在主目录执行。

Electron 本地服务只监听 loopback；写 API 校验可信 Origin/宿主会话，文件读取同时校验资源归属。远程 Web 部署若存在，必须使用认证主体做相同资源校验，不能把 `userId=local` 当作多用户鉴权。

```ts
type WorkflowErrorCode =
  | "INVALID_INPUT" | "NOT_FOUND" | "FORBIDDEN" | "CONFLICT"
  | "NETWORK_UNAVAILABLE" | "MODEL_UNAVAILABLE" | "CAPABILITY_MISMATCH"
  | "BUDGET_EXCEEDED" | "INSUFFICIENT_BALANCE" | "UPSTREAM_PAYMENT_REQUIRED"
  | "ATTACHMENT_INVALID" | "SNAPSHOT_STALE" | "RECOVERY_REQUIRED"
  | "INTERNAL_ERROR";

type WorkflowError = {
  code: WorkflowErrorCode;
  message: string;
  retryable: boolean;
  requestId: string;
  billingSource?: "platform" | "custom_provider" | "unknown";
  providerId?: string;
  recoveryId?: string;
};
type ApiFailure = { error: string; detail: WorkflowError };
type MutationIdentity = { requestId: string; expectedRevision: number };
```

保留旧 `error: string`，新客户端用 detail，不从显示文案推断动作。HTTP 映射：输入错误 422、未知资源 404、无权限 403、陈旧状态/幂等冲突 409、明确支付问题 402、网络上游不可用 503、未分类内部错误 500。日志关联 requestId，但不记录凭据、完整附件或原始上游敏感响应。

### 4.2 发送、队列与幂等

`POST /api/sessions/:id/prompt` 扩展 requestId、draftId、modelSelection、attachmentIds；旧 text/images/attachments/effort/skillId/references 继续兼容。

```ts
type PromptReceipt = {
  ok: true;
  requestId: string;
  userMessageId: string;
  runId: string;
  disposition: "started" | "queued";
};
```

幂等记录键为 `(projectId, sessionId, requestId)`，保存规范化请求摘要和 receipt。相同键相同载荷返回原 receipt；相同键不同载荷返回 409。会话删除时一并删除，存续期间不得因短期 TTL 导致旧发送可重复。

framework 在一个事务内登记请求、持久化用户消息、附件引用和完整排队载荷。运行器从已登记请求启动，不再次 append 用户消息；同时保留会话级执行租约。队列必须包含实际模型决策、图片、附件、agent、effort、skill 和 references，不得静默丢字段。

响应丢失时客户端用原 requestId 重发，只在收到持久化 receipt 后清空对应草稿。活跃任务中用户发送的新消息允许 FIFO 排队；重试/继续动作不得借排队产生第二个运行。

进程在副作用执行后、确认前退出，无法靠数据库保证外部操作 exactly-once。必须记录 `recovery_required`，提示核对实际文件/命令结果；不得自动重放。新 session 创建也使用 requestId，避免首次发送失败留下重复会话。

### 4.3 持久化及迁移

| 实体 | 存储所有者与必要字段 | 约束 |
| --- | --- | --- |
| workflow_requests | framework 项目数据库；sessionId/requestId/payloadHash/receipt/state | sessionId + requestId 唯一；事务落盘 |
| workflow_runs | framework；runId/sessionId/requestId/status/revision/recovery/实际模型 | 每 session 最多一个执行租约；revision 单调递增 |
| session_read_state | 项目数据库；sessionId/lastReadMessageSeq | 服务端取 max，不允许回退 |
| message 序号 | framework messages 增加 message_seq，session 增加 historyRevision | `(session_id,message_seq)` 唯一；序号不复用 |
| message_search | framework；messageId/partId/kind/content | 与转录同事务更新；删除/rewind 同步清理 |
| attachment 与 draft | Lectern 项目数据库与专用 blob 目录 | 见 A；不写入用户仓库 |
| model_policy | Lectern 项目设置；选择模式/偏好/预算/provider 引用 | 设备凭据独立，不随项目导出 |
| billing_recovery | framework run 的结构化恢复记录 | 只存恢复信息，不存支付凭据 |

旧消息按 `(created ASC, id ASC)` 回填 message_seq，后续在写事务内递增；不能依赖毫秒时间戳唯一。迁移采用版本号和事务，先做一致性备份；中断重启可重试。保留旧 JSON 字段及旧 API 一个兼容版本。涉及新附件引用的版本禁止未经兼容验证直接降到 0.5.1，详见回滚计划。

## 5. M：消息体验

### 产品行为

保留当前聊天主界面，标题栏提供会话内搜索；结果显示命中摘要并跳到具体消息/工具片段。未读分隔线位于首次未读助手消息前；滚动阅读旧消息时，新内容不能强制拉到底部。主动回到底部后恢复自动跟随。

首次加载、空会话、无搜索结果、历史加载失败、断线、权限等待各有独立状态。权限请求只能由用户或已有有效规则处理；切换视图不产生授权。macOS 使用 Cmd、Windows 使用 Ctrl 的平台快捷键绑定，但不在页面中堆使用说明。

### 查询与实时契约

`GET /api/sessions/:id/messages?view=window&limit=50&before=<cursor>`；定位使用 `around=<messageId>`，与 before 互斥。limit 1..200。无参数旧响应不变，新 UI 不再调用全量路径。

```ts
type MessageWindow = {
  projectId: string;
  sessionId: string;
  messages: Array<TranscriptMessage & { messageSeq: number }>;
  beforeCursor: string | null;
  afterCursor: string | null;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  historyRevision: number;
  snapshotSeq: number;
  readState: { lastReadMessageSeq: number; unreadCount: number };
  task: TaskSummary;
  artifacts: Artifact[];
};
type SearchHit = {
  projectId: string;
  sessionId: string;
  messageId: string;
  partId: string;
  kind: "text" | "tool" | "attachment_name";
  snippet: string;
  match: { start: number; length: number };
};
```

cursor 是服务端编码的 `{sessionId,messageSeq,historyRevision}`，不得作为授权依据；分页顺序按 messageSeq。after 用于跳转后的向后加载。rewind 增加 historyRevision，旧游标返回 409 并重新定位，不删除其它会话缓存。

转录、运行状态快照与 event log 水位必须由 framework 同一一致性读取得到；相关写入先持久化再发布。UI 先装载快照，再请求 `/events?since=snapshotSeq`。事件按 `(sessionId, seq)` 去重，只有应用成功才推进游标；乱序/缺口重新补拉，不跳过未知缺口。水位不可满足返回 reset-required，重新取快照。切会话取消旧请求，并以 sessionId + 请求代次拒绝迟到响应。

历史窗口最多保留 500 条完整消息，超出卸载远端页并保留游标；摘要、任务状态、未读与产物属于独立快照，不能因为窗口卸载丢失。采用 `@tanstack/react-virtual` 做动态行高虚拟化，默认 overscan 8；大型代码/工具输出折叠，不一次渲染全部文本。

`GET /api/sessions/:id/search?q=...&limit=30&cursor=...` 返回 `{results: SearchHit[], nextCursor: string|null}`。全局 `/api/sessions/search` 增加同样的定位字段与分页，旧字段保留。q trim 后 1..200 字符，空值返回空结果；首期对正文、工具名称/摘要和附件名做大小写不敏感子串搜索，排除推理内容、密钥、附件正文及全量工具日志。索引使用规范化内容表，参数化 SQL；不得每次反序列化全库附件。

`PUT /api/sessions/:id/read-state` 输入 `{lastReadMessageSeq:number}`，返回 readState。仅窗口聚焦、页面可见、消息尾部进入视口并停留 500ms 才推进；大于服务端最新序号的请求拒绝。未读数统计游标之后的可见助手消息，不统计用户消息或每个 token。

### 验收

1. M-01：10,000 条含 Markdown/工具/附件的转录，首屏只取 50 条；DOM 消息行不超过 100，完整消息缓存不超过 500。
2. M-02：读取老历史时并发新增 100 条消息，前后分页无缺失/重复；搜索能定位首、中、末页以及工具和附件名。
3. M-03：重复事件、重连、服务重启、快照与订阅间新增事件后，最终投影与服务端快照完全相等。
4. M-04：快速切换 A/B 会话时，A 的迟到请求不改变 B；失败分页有可重试入口且锚点不跳动。
5. M-05：隐藏窗口不自动已读；重启后游标保留；rewind 后失效游标可恢复，无负未读数。
6. M-06：在 10,000 条消息、50 MiB 可搜索正文数据集，热缓存 20 次本地查询 p95 小于 500ms，打开尾页 p95 小于 1s；这是目标，基线尚未测量，须记录测试机器与打包版本。

## 6. T：后台任务中心

### 产品行为与状态

在现有侧栏增加任务视图切换，主区域是紧凑列表，不新增独立外壳。视图：全部、运行中、等待处理、失败、最近完成；保留项目筛选、归档和置顶。每项显示任务名、项目、状态、最近活动、实际模型；费用未知显示未知。点击进入准确会话；行内工具使用图标与 tooltip，更多操作进菜单。

后台指应用与服务仍运行时，用户离开当前会话；退出应用/电脑休眠后不承诺继续计算。重启时未结束的运行标记为中断并核对，不显示为仍在执行。

```ts
type TaskStatus = "queued" | "running" | "waiting_permission" | "waiting_balance"
  | "recovery_required" | "completed" | "failed" | "cancelled";
type TaskSummary = {
  projectId: string; sessionId: string; runId: string | null;
  status: TaskStatus; revision: number; unreadCount: number;
  updatedAt: string; model: ModelRef | null; error?: WorkflowError;
};
type TaskActionRequest = MutationIdentity & {
  action: "stop" | "retry" | "continue" | "duplicate";
  runId: string;
};
```

新增 `POST /api/sessions/:id/actions`，返回 `{ok:true,task:TaskSummary,receipt?:PromptReceipt,newSessionId?:string}`。沿用已有 abort 底层机制，但所有入口遵守相同租约、幂等和归属校验。列表 `/api/sessions?all=1` 扩展 task 信息；首期轮询 5s、窗口恢复立即刷新，允许部分项目读取失败并明确显示不可用项目。

| 操作 | 可用条件 | 精确语义 |
| --- | --- | --- |
| 停止 | queued/running/waiting_permission | 取消当前执行与尚未执行队列；终结 pending permission；不撤销已完成文件修改；已结束重复停止返回现态 |
| 重试 | failed，且未发生副作用或引擎有安全恢复点 | 不复制原用户消息、不 truncate 历史；创建新 run 并关联 retryOfRunId，恢复失败步骤 |
| 继续 | cancelled/waiting_balance，或用户已核对 recovery_required | 新 run 从持久化对话和已知工具结果继续；不自动执行未知结果工具；权限审批仍有效检查 |
| 复制 | 任意可读任务 | 同项目创建未运行的新会话，复制最后用户输入/附件/选择配置；不复制进程、工具结果、授权记录或交付接受状态 |

waiting_permission 的主操作是查看并处理授权，不能用继续绕过。completed 通过输入框提交新消息，不显示“重试完成任务”。无安全恢复点时重试入口替换为“核对后继续”，不得承诺透明恢复。所有操作进行中禁用本项冲突操作，409 刷新真实状态，不乐观伪造成功。

### 验收

1. T-01：三个项目各有运行/权限等待/失败任务，列表准确分组；在 A 项目视图停止 B 任务只影响 B。
2. T-02：同一 action 连续点击 10 次及两窗口并发调用，至多创建一个新 run；旧 revision 返回 409。
3. T-03：停止后队列不会继续执行、权限等待解除；完成的写文件结果仍保留。
4. T-04：复制附件任务只产生草稿；离开会话、重启应用后状态与草稿仍存在。
5. T-05：重试/继续保留已完成工具结果；未知副作用必须人工核对，不能自动再写文件或再提交。

## 7. A：文件附件完整链路

### 格式边界

本期完成 UTF-8 文本/代码和现有图片链路：文本最多 5 个，每个 512 KiB；图片最多 4 张，每张 4 MiB；请求含编码开销总上限 32 MiB。空文本文件允许，必须明确显示 0 B。PDF、DOCX、XLSX、压缩包在本期明确拒绝，不伪装成 text/plain，不向模型发送乱码。二进制文档解析列为后续独立 parser 工作项，不能宣称本期支持任意文件。

### 生命周期与契约

文件选择、拖拽及粘贴图片都进入同一入口。对每个候选立即创建本地 ID 和占位条目，状态为 reading/uploading/ready/failed/cancelled；读完前不能发送。不同内容同名文件可以共存；同一草稿内按原始字节 SHA-256 去重并提示，不按文件名静默丢弃。

```ts
type AttachmentView = {
  id: string; draftId: string; name: string; mediaType: string;
  size: number; sha256: string; kind: "text" | "image";
  state: "ready" | "failed";
  error?: WorkflowError;
};
type DraftView = {
  id: string; projectId: string; sessionId: string | null; revision: number;
  text: string; attachmentIds: string[]; modelSelection: ModelSelection;
};
```

新增本地 API：

| API | 请求/响应 |
| --- | --- |
| `POST /api/drafts` | `{projectId,sessionId?,requestId}` -> DraftView；校验项目归属 |
| `GET /api/drafts?projectId=...&sessionId=...` | 返回 `{draft:DraftView|null,attachments:AttachmentView[]}`；未建会话用 `sessionId=new`，按当前设备用户与项目隔离 |
| `GET /api/drafts/:id` | 返回 `{draft:DraftView,attachments:AttachmentView[]}`；用于重启与保存冲突后的恢复 |
| `PUT /api/drafts/:id` | `{expectedRevision,text,attachmentIds,modelSelection}` -> DraftView；失配 409 |
| `POST /api/drafts/:id/attachments` | multipart：file + clientAttachmentId；一个文件一个请求 -> AttachmentView |
| `DELETE /api/drafts/:id/attachments/:attachmentId` | 解除当前草稿引用；重复操作幂等 |
| `GET /api/sessions/:id/attachments/:attachmentId/download` | 已发送附件原始字节，服务端关联 session/message/attachment 后返回 |

附件原始字节存在专用数据目录，随机内部 ID 作路径，不使用上传文件名拼路径；元数据落项目 SQLite。先写临时文件、验证实际字节/MIME/UTF-8、原子改名，再提交 ready 引用。服务端是校验权威；长度、数量、base64 兼容请求、目录拖拽、符号链接逃逸、Windows 保留名和控制字符都有明确处理。

上传取消用 AbortController，FileReader 可中止；取消后迟到回调不能复活条目。部分失败逐项重试，不清空成功项。草稿切会话、发送失败和重启均保留；保存节流 300ms，发送前等待保存成功。新消息原子绑定 ready 附件引用；清空 UI 草稿不删除已发送附件。未引用临时 blob 24h 后清理；草稿/消息引用存在则禁止清理。

新消息 part 使用稳定 attachmentId + 元数据，不把二进制反复带入分页响应。runner 经服务端读取并生成模型输入，继续遵守“用户正文与文件内容分离”契约；附件内容视为不可信数据，不可自行授予工具权限。legacy data URL file part 继续读取，按需转存并校验；rewind、复制和恢复均用独立附件投影，不把内容塞进 text。

下载使用安全 Content-Disposition（attachment）、nosniff 和服务端确认 MIME；预览 HTML/Markdown 不执行脚本、不获取本机权限。下载与消息归属不匹配返回 404，不能给客户端任意 path 下载接口。产生的结果文件沿用 D 的 artifact 下载边界，不混用输入附件身份。

### 验收

1. A-01：拖入 5 个文件后输入正文逐字不变；附件条目显示名称、大小和状态，纯附件可发送。
2. A-02：超过数量/大小、无效 UTF-8、伪造 MIME、目录或 PDF/DOCX 被逐项拒绝，已有成功附件保留。
3. A-03：同名不同内容可同时发送；同内容重复添加有提示；取消读取/上传后条目不会复活。
4. A-04：失败重试、切会话、重启、排队发送、rewind 和复制后原始附件 SHA-256 一致。
5. A-05：中文、空格、Windows 保留名、路径穿越、跨项目猜 ID 等下载用例通过；拒绝项不写用户工作区。
6. A-06：加载 10,000 条历史消息不返回整库 data URL；尚有引用的附件不被垃圾回收。

## 8. D：交付工作流

### 用户流程

沿用 Review / Files / Preview / Terminal。Review 默认展示本轮变更、验证结果、风险和产物；每个证据显示 attempt、执行时间与状态。Agent 说“完成”只代表运行完成，不代表验证通过。

正常路径：生成结果 -> 固定快照 -> 运行用户批准的必要检查 -> 审查 -> 接受并合并 / 导出补丁 / 退回修改 / 丢弃。退回输入 1..4000 字反馈，可关联 file/hunk；创建新 attempt，旧证据只读。没有 required 检查时保持 unverified，只能通过明确的二次确认接受未验证快照。

### 数据与 API

延续 `DeliveryAttempt`、`DeliverySnapshot`、`CommandRun`，不要另建第二套状态机。扩展 `/api/deliveries/attempt` 动作：`return`、`approve_checks`、`run_checks`、`rollback`；原 accept/discard/verify/finish 等写动作都必须带 attemptId、expectedRevision、requestId。服务端比较目标与 active attempt，一旦用户正在看的 attempt 过时就返回 409，不转而操作新的 active attempt。

```ts
type DeliveryActionInput = MutationIdentity & {
  sessionId: string; attemptId: string;
  action: "accept" | "discard" | "return" | "verify" | "rollback"
    | "approve_checks" | "run_checks";
  feedback?: { text: string; path?: string; hunkId?: string };
  allowUnverified?: boolean;
  approvedPlanId?: string;
};
type ApprovedChecks = {
  id: string; sessionId: string; version: number; planHash: string;
  commands: Array<{ id: string; label: string; command: string; cwdRelativePath: string }>;
  approvedAt: string;
};
```

approve_checks 接收 `{commands}`，经用户确认、根目录校验后服务端生成 ApprovedChecks；run_checks 只接受 approvedPlanId，客户端不能上传 passed/exitCode 来制造必要检查通过。命令实际启动、退出码、取消、日志脱敏、snapshot fingerprint 由服务端执行器记录；旧 commands 接口仅 advisory。所有 required 必须终态 passed，pending/running/cancelled 都不能判通过。验证时文件变化使快照失效，不把该结果用于接受。

新增只读导出：

- `GET /api/deliveries/:attemptId/patch`：从快照 base/tree 生成 `git diff --binary`，覆盖新增/删除/重命名与二进制变更；绝不取当前可变 worktree。无 Git 快照返回 409。
- `GET /api/deliveries/:attemptId/artifacts/:artifactId/download`：从已捕获不可变产物读取；校验 project/session/attempt 关系、原始字节 hash 与下载文件名。

快照必须区分任务开始时用户已有变更与本次交付变更。默认只允许接受已归属于隔离工作区/本任务的变更；共享目录里归属不明的文件显示冲突并要求拆分或明确纳入，不自动提交全部 dirty 文件。接受仅创建本地提交，不自动 push。

接受操作用已有 immutable delivery commit/tree + Git CAS，外加持久化操作日志：prepared -> ref_updated -> accepted。崩溃后核对 ref 和 merge SHA，恢复同一个操作，不重复创建/合并。回滚是对该接受提交创建 revert 提交，不 reset、不改写历史；有后续提交/脏目录/冲突时保留现场并报告。丢弃默认只关闭 attempt、保留证据和 worktree；清理隔离目录必须是另一个明确确认的破坏性动作。

结果文件单个导出上限 100 MiB，超限显示在文件管理器定位，不读入 renderer。预览与下载共享服务端 owner/path 校验，HTML 预览隔离 origin 或 sandbox，不能拿到本地桥或凭据。

### 验收

1. D-01：伪造 passed 命令不能让 required 通过；含任意 running/cancelled/failed required 时不能显示“验证通过”。
2. D-02：退回生成新 attempt，旧截图/日志/补丁仍对应旧 hash；旧界面点击接受返回 409。
3. D-03：基分支前进、文件改变、CAS 失败均拒绝接受，不移动目标 ref、不覆盖用户变更。
4. D-04：补丁在相同 base 的干净仓库 `git apply --check` 和实际应用成功，结果 tree 与快照一致（含二进制）。
5. D-05：接受提交仅含获准文件；重复调用及 ref 更新后进程退出均可恢复为同一提交。
6. D-06：回滚生成新的 revert 提交；冲突不自动清理；非 Git 项目可下载结果但不显示可用 Git 操作。
7. D-07：结果下载 hash 一致，跨 session/attempt、越界路径、符号链接逃逸和脚本预览均被隔离。

## 9. R：自动选模型与自定义模型

### 面向用户的选择

默认选择“自动”，用户可选“性价比优先”或“效果优先”，也可固定模型。模型列表先解释用途，再展示名称、能力、价格依据和速度信息；“最佳效果”是基于当前目录及评测的推荐，不宣称所有任务绝对最优。

| 场景 | 性价比优先 | 效果优先 | 必需能力 |
| --- | --- | --- | --- |
| 日常问题 | 达到日常问答质量门槛后，选估算费用较低者 | 选该场景质量分最高者 | 文本；有图片则 vision |
| 写作/总结 | 满足长度与质量要求的低成本模型 | 更高忠实度/结构质量评分模型 | 足够上下文；不能静默截断附件 |
| 代码构建/调试 | 满足工具调用与代码评测门槛的低成本模型 | 代码/工具成功率优先 | tools + 上下文 + 所需输入模态 |
| 复杂分析/大改动 | 满足复杂任务门槛且预算内的模型 | 多步任务质量优先，仍不突破预算 | 上下文、推理能力；涉及改代码时 tools |

不在 spec 写死具体商业模型名和单价。实施时从真实目录/价格来源建立版本化推荐表，有来源日期和评测版本；没有数据的自定义模型只支持手动选择，不凭名字猜能力或假设免费。

```ts
type Scenario = "daily" | "writing" | "coding" | "complex";
type Money = { currency: string; amount: string };
type ModelSelection =
  | { mode: "auto"; preference: "value" | "quality";
      scenario: Scenario | "auto"; maxRunCost: Money | null;
      allowedProviderIds: string[] }
  | { mode: "manual"; model: ModelRef; maxRunCost: Money | null };
type ModelCatalogEntry = {
  ref: ModelRef; label: string;
  billingSource: "platform" | "custom_provider" | "local";
  capabilities: { tools: boolean | null; vision: boolean | null;
    contextTokens: number | null; maxOutputTokens: number | null };
  pricing: null | {
    currency: string; perTokens: 1000000;
    input: string; output: string; cachedInput: string | null;
    source: string; updatedAt: string;
  };
  scenarioScores: Partial<Record<Scenario, {
    quality: number; minimumPassed: boolean; evalVersion: string;
  }>>;
  latencyP50Ms: number | null;
};
type ModelDecision = {
  model: ModelRef; scenario: Scenario; reasonCode: string;
  policyVersion: string; catalogVersion: string;
  estimatedCost: Money | null;
};
```

### 决策与费用规则

新增 `POST /api/models/recommend` 输入 `{sessionId,draftId,selection}`，输出 `{decision:ModelDecision|null,candidates:ModelCatalogEntry[],error?:WorkflowError}`。服务端读取草稿和必要上下文，前端不决定最终路由。发送时再次校验并持久化决策；目录变化导致价格提高或模型改变时返回 409 要求重新确认，不消费旧报价静默发送。

首期使用版本化规则分类，不额外发 LLM 请求：用户指定场景优先；code-build agent、构建/修改代码意图优先 coding；多步骤分析意图优先 complex；摘要/改写意图 writing；否则 daily。分类器只读用户正文、agent 类型、上下文规模和附件类型，不把附件中的指令当路由命令；规则以固定测试语料锁定，用户可改场景。

候选筛选顺序：用户允许的 provider -> 已启用且可用 -> 所需模态/tools/上下文 -> 质量门槛 -> 预算。性价比按估算费用升序、质量降序、稳定 ID 排序；效果优先按场景质量降序、估算费用升序、稳定 ID 排序。不得跨币种直接比较；没有可靠汇率时只在预算币种内推荐。无符合候选时返回明确原因，不自动放宽限制。

报价显示币种、每百万 token 输入/输出/缓存价、更新时间；倍数必须注明相对基准，不能代替真实价格。费用估算基于已知输入和配置输出上限，标注“不含未知后续工具轮次”；最终费用来自实际用量及对应价格快照，缺项即 unknown。预算预检每次模型调用都执行；已用量 + 本轮已知上界超限则暂停。上游不支持可靠上界时，只能称预算预警，不能宣传硬消费封顶。

固定模型缺能力或不可用时提示更换，不静默改模型。自动 failover 只在同一授权 provider、同等能力且不增加已批准价格上界时允许，并展示原因；跨 provider 可能改变数据去向，必须先征得用户确认。收到 402 不进入自动循环重试。

### 自定义模型

设置仍在账户菜单内。新增 provider 配置：名称、协议（首期 OpenAI-compatible 或 Ollama）、base URL、API key、model ID、可选能力与价格。用户录入能力必须标“用户配置”，连接成功不能证明工具/视觉能力全部可用。

新增 `/api/settings/providers` GET/POST、`/:id` PATCH/DELETE、`/:id/test` POST。读取只返回掩码和 configured 状态；保存时 API key 为 write-only，空缺保留原值，显式 clear 才删除。test 超时 10s，结果 `{status:"ok"|"failed",checkedAt,latencyMs,error?}`，仅做目录/身份连通检查，不执行工具；付费测试需独立确认。

网络 endpoint 默认 HTTPS；本地 loopback Ollama 可 HTTP。禁止 URL 凭据、非 HTTP 协议与意外重定向；远程 Web 的连接测试禁止访问内网/云元数据地址。桌面用户明确配置的本地服务仅由本机访问，绝不转交云端探测。自定义 provider 永不接收平台 cookie 或平台 key。

设备凭据通过 Electron 主进程 safeStorage（macOS Keychain / Windows DPAPI 支撑）保护，主进程校验调用来源；不向 renderer 回读明文。Web 使用服务端现有加密存储并限制权限，不声称等同系统凭据库。系统保护不可用时禁止新增持久化密钥，仅允许会话内使用；旧加密配置需可验证迁移，不删除尚未成功迁移的原记录。

### 验收

1. R-01：四场景 x 两偏好 x 三输入能力组合（纯文本/图片/工具）至少 24 个固定用例，候选满足能力、provider 与预算约束。
2. R-02：相同输入/目录/策略得到相同决策；实际 run 展示的模型与请求记录一致，排队后不丢选择。
3. R-03：固定模型不可用、未知价格、币种不同、目录变化、无预算内候选都有明确结果，不静默换贵模型。
4. R-04：自定义模型保存、测试、重启、修改、删除均生效；正运行使用旧配置快照，删除被引用 provider 需先停用，不能中途破坏调用。
5. R-05：renderer/localStorage/日志/导出项目不含明文 key；自定义服务捕获请求中不出现平台凭据。
6. R-06：费用展示有币种、单位、来源、估算标签；缺失用量或单价不输出伪造精确总额。

## 10. B：充值与余额不足恢复

### 范围和依赖门槛

账户菜单增加余额和充值入口；不把设置或充值单独放到顶层导航。优先打开现有官方安全计费页面，不在 Electron 内自建收银台，也不要求应用签名才能完成网页充值。

实际计费账户、查询接口、充值 URL 和登录衔接尚未核实。本节定义 Lectern 内部适配接口，不定义或假设任何上游支付 endpoint。接入前必须取得四项证据：当前用户与扣费账户映射、余额及币种语义、官方充值入口 allowlist、支付完成后余额更新/一致性契约。未取得时仅可交付 402 分类和输入保留，充值按钮隐藏或显示暂不可用，不能指向猜测 URL。

```ts
type BillingState = {
  source: "platform" | "custom_provider" | "unknown";
  providerId: string | null;
  status: "available" | "insufficient" | "unknown" | "unavailable";
  balance: Money | null;
  checkedAt: string | null;
  canRecharge: boolean;
};
interface BillingAdapter {
  getState(sessionId?: string): Promise<BillingState>;
  getRechargeDestination(): Promise<{ url: string; expiresAt: string | null } | null>;
}
type RecoveryCheckpoint = {
  id: string; sessionId: string; runId: string; revision: number;
  reason: "balance" | "network" | "unknown_side_effect";
  completedToolCallIds: string[];
  pendingToolCallId: string | null;
  safety: "safe_to_continue" | "requires_review";
};
```

新增 Lectern 本地 `GET /api/account/billing` -> BillingState；`POST /api/account/recharge-link` -> `{url,expiresAt}` 或 503。适配器仅在确认真实上游契约后实现；URL 的 HTTPS、host、过期时间由服务端与宿主双重校验，不携带 API key。外部浏览器无法共享 Electron cookie 时走官方网页登录，不把会话 cookie 放进 URL。

### 错误与恢复

provider 错误先结构化：明确余额不足映射 INSUFFICIENT_BALANCE；只有 HTTP 402、原因不明时显示“上游要求处理计费”，不能断言账户余额为零。区分平台余额、自定义 provider 配额和本地模型；给自定义 provider 的 402 不显示“给 Lectern 充值即可解决”。

运行遇到支付问题，停止进一步付费调用并保留转录、待执行队列、附件、实际模型和 RecoveryCheckpoint，状态 waiting_balance。原消息已入库则保留在会话中；未获得 receipt 的草稿继续保留，可用原 requestId 查询/重试。

支付页打开不等于支付成功；回调、窗口聚焦或用户点击刷新只触发可信余额查询。支付返回后可按 2/4/8/16/30s 有界刷新，最多 60s，之后手动刷新；金额仍未知不得显示已到账。即便已到账，也必须用户点击“继续任务”才创建新 run，且不能重放已完成工具。恢复点不安全时先核对副作用；不调用 rewind 代替恢复。

### 验收

1. B-01：平台明确余额不足显示正确充值入口；自定义 provider 402 显示对应 provider 与设置入口；未知 402 不伪造余额。
2. B-02：充值页取消、失败、超时及余额未到账，原草稿/附件/运行证据保留，不自动继续或反复扣费。
3. B-03：伪造支付返回参数不能把状态改为成功；只能通过可信上游余额查询更新。
4. B-04：支付成功返回、重复点继续、应用重启后恢复都只创建一个新 run；已执行的文件写入与命令不重复执行。
5. B-05：无可核验的恢复点时进入 requires_review，不宣称可以无损自动续跑。
6. B-06：官方账户、充值入口和真实到账闭环完成一次脱敏联调记录后才能把支付接入标为完成；mock 不替代真实计费验收。

## 11. 子任务拆分与工作量

下表是建议拆单，不代表已创建 Issue。全部状态为未开始。单位为单工程师人日，含对应测试，不含等待外部计费资料、证书或 Windows 设备时间；不是交付日期承诺。AI 辅助仍需跑真实测试，暂无可信压缩系数。

| ID | 内容 | 估算 | 前置 |
| --- | --- | --- | --- |
| F0-1 | session/project/worktree 解析、跨项目 API 安全 | 2 | 无 |
| F0-2 | 幂等请求、完整队列、run revision 与恢复边界 | 3 | F0-1 |
| F0-3 | message_seq、快照水位、事件去重与迁移 | 3 | F0-1 |
| M-1 | 数据库分页、搜索、命中定位 | 3 | F0-3 |
| M-2 | 虚拟化、缓存窗口、已读与失败状态 | 3 | M-1 |
| T-1 | 任务视图、跨项目刷新及操作 | 3 | F0-2、M-2 |
| A-1 | 草稿、附件 blob/引用与上传校验 | 3 | F0-1 |
| A-2 | 输入条目、取消/重试/恢复与下载 | 3 | A-1、F0-2 |
| D-1 | 批准检查、服务端证据、attempt 前置条件 | 3 | F0-2 |
| D-2 | 退回、丢弃、快照补丁与结果下载 | 3 | D-1、A-2 |
| D-3 | 接受操作日志、CAS 崩溃恢复与 revert | 3 | D-1、T-1 |
| R-1 | provider 设置、凭据迁移、目录能力 | 3 | F0-1 |
| R-2 | 推荐规则、报价与运行预算检查 | 3 | R-1、F0-2 |
| B-1 | 402 分类、恢复 UI 与余额适配边界 | 2 | F0-2、R-1 |
| B-2 | 真实计费接入、到账刷新与继续 | 2 | B-1、上游契约确认 |
| Q-1 | macOS 打包链路验收 | 2 | 交付批次功能 |
| Q-2 | Windows 原生链路验收 | 2 | 交付批次功能、Windows 环境 |

合计约 46 人日，允许在不修改相同模块的前提下并行。高风险 F0-2/F0-3/D-3 若超过单任务 3 天，按“持久化契约 / 执行集成”继续拆分，不削减验收。建议首个可发布批次 F0 + M + T + A，第二批 D，第三批 R + B；每批都执行平台回归，不为凑版本号合并未验收功能。

## 12. 测试与发布门槛

| 层级 | 必须覆盖 | 最小新增场景目标 |
| --- | --- | --- |
| 单元 | 路由筛选、费用、任务状态、事件 delta 去重、权限与附件校验、交付聚合 | 60（含 R 的 24 组合） |
| 集成 | 实际 SQLite 迁移/并发、快照+SSE、请求幂等、附件归属、Git CAS/崩溃、mock 402 | 30 |
| 浏览器 E2E | 六条工作流正常/失败恢复，跨项目，10,000 条历史压力，键盘和截图 | 18 |
| 原生打包 | macOS 与 Windows 拖拽/文件选择、路径、凭据、下载、重启与外链返回 | 每平台 8 |
| 真实后端 | 模型目录/价格、自定义兼容 provider、正确计费账户/支付返回 | 每接入一类 provider 一组；计费闭环 1 组 |

场景数用于规划，验收以覆盖行为为准，不可用重复断言凑数。网络/计费失败优先使用故障注入，支付实测金额及账户必须经用户授权。

回归命令：`pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm test:release`；framework 运行其对应 store/event/runner/attachments 测试。版本发布另走发布流程，本 spec 不授权现在构建或上传新包。

桌面截图覆盖 1440x900、1024x768，Windows 100%/125%/150% 缩放，亮/暗模式；窄 Web 视图覆盖 390x844。检查长文件名、模型名、金额、错误文案换行，无横向溢出/控件遮挡；保留系统标题栏控制安全区。原生 Windows 验收不能由 macOS 交叉打包替代。

## 13. 回滚与降级

1. 功能开关分为 message_window、task_center、attachment_refs、model_routing、billing_ui、delivery_actions；默认关闭，完成对应契约测试后逐项启用。
2. 前端故障可回退视图，但新后端仍识别新附件和请求 ID。关闭 UI 不清理消息、草稿、证据或配置。
3. 数据迁移前做一致性备份，启动时检测 schema version；旧程序无法读新 schema 时阻止打开该库并提供兼容恢复说明，不能尝试写入。
4. 回退 0.5.1 必须先导出升级后新增消息/附件/配置，再用单独数据目录验证备份恢复。不能把旧备份覆盖当前库，假装回滚没有数据损失；优先发布前向修复。
5. 模型路由可退回固定模型选择；保留 run 价格/模型快照。计费不可用时保留错误和恢复记录，隐藏充值动作，不自动换账户或 provider。
6. Git 接受后的产品回滚用 revert 提交；功能版本回滚不撤销用户已经接受的提交。未知 CAS 操作先按日志核对 ref，再允许后续写入。

## 14. 文件与模块边界

| 文件（仓库相对路径） | 预期变更 |
| --- | --- |
| `app/page.tsx` | 消息窗口、草稿/receipt、旧请求取消、任务导航 |
| `components/ChatView.tsx` | 虚拟化、未读、会话内搜索和恢复状态 |
| `components/Composer.tsx` | 独立附件条目、草稿、模型场景与发送状态 |
| `components/SessionList.tsx`、`lib/task-groups.ts` | 任务中心分组、未读、动作权限 |
| `components/DeliveryReview.tsx` | 固定 attempt 的证据与操作 |
| `components/AccountBlock.tsx`、`app/settings/` | 账户内余额入口与模型配置 |
| `lib/client.ts`、`lib/types.ts`、`lib/chat-projector.ts` | 类型化错误、窗口/事件契约、幂等投影 |
| `lib/runtime.ts`、`lib/projects.ts` | 会话归属解析，不依赖 UI 活动项目 |
| `app/api/sessions/[id]/`、`app/api/sessions/search/route.ts` | 分页/定位/已读/动作/结构化错误与归属校验 |
| `lib/delivery*.ts`、`app/api/deliveries/` | 审查前置条件、真实检查、导出、CAS 恢复 |
| `lib/settings.ts`、`lib/model-caps.ts`、`lib/relay.ts`、`app/api/models/` | provider + model 复合键能力缓存、推荐、真实价格、认证隔离 |
| `electron/main.cjs`、`electron/preload.cjs` | 系统凭据保护、安全外链和原生下载；不向 renderer 暴露密钥 |
| 拟新增 `lib/attachments.ts`、`lib/drafts.ts`、`lib/model-routing.ts`、`lib/billing.ts` | 各领域服务，避免都堆进 page.tsx |
| framework `src/core/session/store.ts`、`sqlite-store.ts`、`jsonl-store.ts` | 分页/快照/请求持久化；不同 store 显式能力声明 |
| framework `src/core/runtime/runner.ts`、`attachments.ts` | 完整排队、run 身份、结构化错误、安全恢复、引用投影 |
| framework `src/core/events/sqlite-event-log.ts` | 与消息快照一致的事件水位和恢复 |
| `vendor/`、`package.json`、`pnpm-lock.yaml` | 经验证的 framework 包更新，不能只在开发源码生效 |

## 15. 不在本期范围

- PDF/Office/OCR/压缩包解析、文档向量库与超大文件分块检索。
- 自建支付订单、支付渠道、退款/发票系统或跨 provider 钱包。
- 云端执行、退出应用仍运行的守护进程、定时调度、跨设备任务同步。
- 任意 provider 协议全面兼容、自动训练路由模型、无来源的模型排行榜。
- 全量重做 UI、通用 IDE 功能、自动 push/PR/部署。
- 新增签名证书或改变无签名更新方式。已有 Windows 原生验证和升级回滚待办继续保留。
- 既有可信交付 spec 中尚未完成的自动浏览器 QA 服务编排/自动修复全部实现；本期消费可用证据，未运行项明确标未验证，不假装通过。

## 16. 完成定义与待确认依赖

每个子任务提交必须列出对应验收编号、自动化结果及不能自动验证的实测证据。所有子项完成之前，Epic 保持未完成；mock 与缺少硬件的检查保持明确标记。

产品范围按本文草案：六项都纳入，先补核心闭环，不追求一次上线。实施前技术门槛：framework 的原子快照/安全恢复能力、真实价格目录、计费账户及支付契约。依赖缺失时应单独标记受阻子任务，不能把未知契约猜成现成能力。

本文已完成现状核对与本地规格草拟，尚未获得草案确认，也未进行确认后的独立质量评分。GitHub 相似 Issue 查询本轮因 GraphQL EOF 失败；未创建、修改或同步远程 Issue。
