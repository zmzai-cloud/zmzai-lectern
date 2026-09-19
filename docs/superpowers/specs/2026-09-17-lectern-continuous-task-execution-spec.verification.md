# 持续任务执行与可信交付 · 验收报告

**规格：** `docs/superpowers/specs/2026-09-17-lectern-continuous-task-execution-spec.md`
**分支：** `feat/task-execution`（基于 `feat/file-attachments`）+ `zmzai-framework` `main`
**日期：** 2026-09-17
**结论：** 通过 —— 第 18 节 11 条全部满足；第 19 节 9 条禁止项逐条核查未违反。
  §17.3 四个场景中 A / C 落在 framework 运行时 E2E，B 由 `task_block` 用例覆盖，
  D 由租约恢复用例覆盖语义、由打包版硬杀重启用例覆盖真实启动路径（2026-09-19 补，见 §4.3）。

本文同时是交付物 §20.4（状态迁移说明）、§20.5（PDF 场景 E2E 运行记录）与
§20.6（最终变更说明与限制）。§20.1–§20.3 的代码位置见 §8。

---

## 1. 变更说明（§20.6 前半）

### 1.1 要修的根因：一次运行结束 ≠ 一条任务完成

改造前，Lectern 对「任务做完了没有」的判定来自 `session.summary.kind === "completed"`，
而这个事件由 `runLoop` 在一轮 agent 循环收尾时发出。于是一个六步任务在第二步之后停一下
（模型给出了纯文本、没有工具调用），界面就显示「任务完成」；用户只能再点一次「继续下一步」，
而那个按钮发出去的是一条**伪用户消息**——聊天记录里出现了他没说过的话。

规格 §5.1 把这条链路拆成四层，这是本次改动的地基：

| 层 | 含义 | 终止条件 |
|---|---|---|
| Session | 一段对话容器 | 用户关闭 |
| **Task** | **用户的一条目标** | `task.delivered` / `failed` / `cancelled` |
| Attempt | 一次内部运行（一个 agent 循环） | 模型给出不含工具调用的文本 |
| Step | 任务拆解出的一个步骤 | 模型把 todo 标成 completed |

`Attempt completed` **不等于** `Task delivered`。规格 §8.3 列出的七种「看着像完成、其实不是」
的信号（`finish_reason: stop`、`agent.prompt()` resolve、单次 Attempt 的 step 上限、本轮没有
工具调用、`session.status` 进 idle、`session.summary.kind === "completed"`、模型文字自称
「已完成」）现在一条都不能触发 `task.delivered`。

### 1.2 Framework 运行时

四个阶段（规格 §16）的提交序列：

| 提交 | 内容 |
|---|---|
| `8e2f827d` | 阶段 A+B：`TaskRecord` 领域模型、TaskStore 三实现、12 个 `task.*` 事件 schema、SQLite 迁移、`runTask` 循环、Completion Gate、内部续跑、权益等待恢复、跨 Attempt no-progress、未知副作用、重启恢复 |
| `51ab1ec3` | 人工放行通路（`resumeTask`）与崩溃对账（`finalizeInterruptedRun` 三步改四步） |
| `1f43ab11` | 时间预算（`activeMs`）与契约存续（§17.1.12） |
| `d06d3921` | `task_block` 工具：让「需要用户介入」成为可执行的运行时状态 |
| `97bde551` | §17.3 场景 A / C 的运行时端到端用例 |

关键设计取舍，逐条对应规格：

- **内部续跑不创建用户消息**（§8.2 / §19）。`WorkflowRun.kind` 取
  `"user_prompt" | "task_continuation" | "recovery"`；续跑靠 systemPrompt 注入任务契约 +
  `driveText` 替换 `input.text`，**不落库**。`resumeTask` 那条更彻底：它根本不经过
  `prompt()`，没有 workflow receipt、`acceptedUserId` 为 undefined——而「接受了一条用户消息」
  正是投影器画一条用户气泡的默认路径，所以另设 `RESUME_DRIVE_TEXT` 标记显式跳过（§13.2）。
- **Completion Gate 判定顺序先阻塞、后完成**（§9 五条件）。有阻塞就先返回阻塞，不会出现
  「条件 1–4 都成立但用户还在等授权」时把任务判成交付。
- **进度指纹不含 `TaskRecord.revision`**（§10.1）。revision 每写一次 +1，把它算进指纹会让
  「只更新了 `updatedAt`」看起来像有进展。指纹取语义要素：步骤状态集合、验收条件状态集合、
  证据集合（按 `(kind, ref)` 取值，**排除 `model_observation`**）、文件改动。三档策略：
  第 1 次无进展注入恢复指令、第 2 次切换策略、第 3 次进 `blocked(no_progress)`。
- **时间预算累加各 Attempt 的 `durationMs`，不是 `now - createdAt`**（§10.2）。墙钟会把
  「停下来等用户」的空白也算进去，一个因缺授权停了一夜的任务第二天点「继续」时会第一轮就
  超时——那正是「继续变死按钮」的另一种写法。
- **失败分类**：`fatalError`（确定没救 → `failed`）与 `attemptSettled`（一轮没跑完 →
  `continue`）分开。401 这类鉴权错误只跑一轮就 `failed`，不浪费重试。
- **契约存续**（§17.1.12）：契约进 systemPrompt，每个 Attempt 从**持久化的 TaskRecord**
  重新渲染；compaction 的 `transformContext` 只折叠 messages。两者不在同一容器里，所以
  压缩上下文不会把 goal / criteria / remaining steps / blocker 挤掉。

### 1.3 Lectern 界面

| 提交 | 内容 |
|---|---|
| `050d923` | 任务层接入界面（21 files, +1577/−147） |
| `ef87476` | vendor 换 `zmzai-agent-framework` 0.8.0 |

- **完成判定单点化**。`lib/task-presentation.ts` 的 `presentTask()` 里只有
  `completed: task.status === "delivered"` 一处定义完成。toast、系统通知、文档标题、会话列表
  勾选、交付卡全部读它。此前这三件事散在 `page.tsx` 的 `toSessionStatus`、`ChatView` 的
  SummaryCard 与会话列表各自的 if 里，三处对「完成」的理解各不相同——这正是 §18.3 要治的病。
- **「继续下一步」被删除**，且不是隐藏。`ChatView` 的 `onContinue` prop、`buildContinueContext`、
  续跑 chip 与 SummaryCard 的续跑按钮一并移除；`diagnoseError` 六条 hint 里所有「点『继续』」
  的措辞改成「框架会在同一任务里退避重试」「在下方输入框里补一句」这类真实可做的动作。
  §17.2-2 是四条**源码级**用例：主扫面是
  `ChatView.tsx` / `page.tsx` / `TaskContextStrip.tsx` / `TaskStatus.tsx`，附加两条分别读
  `ChatView.tsx`（错误文案里不得再出现「点『继续』」，但必须说到真实通路「任务卡」）与
  `ReviewPane.tsx`（本轮小结文案是「本轮已结束」，且**不得**用「任务完成」描述一轮的结束）。
  剔除注释是刻意的——文件里写「这里不再有 X」是好的文档，不该被判违规。
- **四个值域的 `disposition`**（§12 / §13.1）：`task_started` / `task_steered`（running 中
  追加约束）/ `task_resumed`（从 waiting/blocked 解锁）/ `queued_new_task`。判定依据是**任务
  当前状态**，不是模型对文本的猜测。
- **五个按钮是封闭清单**（§14.2）：`授权并继续` / `补充信息` / `选择方案` / `检查后重试` /
  `停止任务`。其中只有「检查后重试」打后端（`POST /api/sessions/:id/task {action:"resume"}`）。
  授权、补充、选择三种情形用户都要在**别处**做一件事（点授权卡、在输入框打字），系统会在
  那件事发生时自己接着跑；再摆一个「继续」按钮只会让人以为不点就不走。
- **通知只在真实状态变化时发**（§14.3）。`taskNotice()` 对 `queued` / `running` /
  `recovering` / `verifying` 返回 `null`——一次 continuation 发生在任务内部，用户不需要知道
  「又跑了一轮」。只有 `delivered` 会改窗口标题（写「任务完成」进标题栏是一种承诺）。

### 1.4 本轮补上的一个真实缺口：`task_block` 工具

这是实施过程中发现的问题，不是规格里写好的：`inputRequired` / `choiceRequired` /
`externalAuthRequired` 三个字段在运行时**一律写死 null**。后果是 §11 那套「模型停下来说
我缺 X」的任务契约无法执行——它会被当成一次正常收尾自动续跑，三轮之后落进
`blocked(no_progress)`，而用户看到的阻塞原因是「连续 3 轮没有实质进展」，真实原因（缺一条
凭据）被彻底换掉了。同时 §17.3 场景 B 走不到，`waiting_input` / `waiting_external` 两个
生命周期状态**运行时不可达**。

修法是新增一个声明型工具 `task_block`（`src/core/tools/task-block.ts`）：

```ts
{ kind: "input" | "choice" | "external_auth", message, requiredAction, options? }
```

`runLoop` 在 `afterToolCall` 的成功分支里捕获它（只留最后一次声明），`completionStateOf`
按 `kind` 分派到对应的 `*Required` 字段。三条实现上的注意：

- `options` 用 `.optional()` 而**不是** `.default([])`。zod 的 `default` 在推导出的 JSON
  Schema 里会变成必填字段，而模型在 `input` / `external_auth` 两种情况下根本不会传它——
  于是每一次声明都因为「缺少 options」被挡在工具校验，`task_block` 成了个永远调不通的工具。
  （这条是实际踩到的：第一版写 `.default([])`，临时测试打印工具 part 才找到根因。）
- `permission: () => null`——声明阻塞没有副作用，不该弹授权卡。
- `firstBlocker` 里 input 那条原本写死文案「补充必要信息后任务会自动继续。」，属 §14.4 禁止
  的模糊指示；现在三条分支都透传 `requiredAction`（模型原话）。

---

## 2. 状态迁移说明（§20.4）

### 2.1 三套状态域，各管各的

改造后同时存在三套状态值，它们的**职责边界**是这张表存在的理由：

| 状态域 | 取值 | 归属 |
|---|---|---|
| `session.status` | `idle` \| `running` \| `waiting_permission` \| `waiting_input` | 会话**运行层**：这一刻进程在不在跑 |
| `session.summary.kind` | `completed` \| `aborted` \| `error` | **单次 Attempt** 的收尾小结（N5） |
| `TaskRecord.status` | 11 态（见 2.2） | 用户**目标**的生命周期 |

关键事实：`session.status` **只有四个值**，没有 `waiting_external`、也没有 `blocked`；而任务
生命周期有 11 态。两者不是「同一件事的粗细两种说法」，是不同层的信号。

### 2.2 对照表

| 旧信号 | 取值 | 改造前的含义 | 改造后的含义 | 与任务层的关系 |
|---|---|---|---|---|
| `session.summary.kind` | `completed` | **「任务完成」**（← 根因） | 「本轮 Attempt 结束」 | 不驱动任何完成态 |
| | `aborted` | 本轮被中断 | 同左 | 不驱动任何完成态 |
| | `error` | 本轮出错 | 同左 | 不驱动任何完成态 |
| `session.status` | `idle` | 「没在跑」 | 同左 | **不承诺完成**（区别就在这） |
| | `running` | 「在跑」 | 同左 | 任务在 `queued`/`running`/`recovering`/`verifying` 时出现 |
| | `waiting_permission` | 「等授权」 | 同左 | 任务在 `waiting_permission` / `blocked(permission)` |
| | `waiting_input` | 「等输入」 | 「等输入」**或「副作用未知」** | 后者在任务层是 `blocked(unsafe_replay)`，见 2.4 |
| `TaskRecord.status` | `queued` / `running` / `recovering` / `verifying` | — | 系统自己推进中 | 界面 → `running` |
| | `waiting_permission` / `waiting_input` / `waiting_external` / `blocked` | — | 球在用户这边 | 界面 → `waiting` / `needs_input` |
| | `delivered` | — | **任务完成**（唯一） | 界面 → `completed` |
| | `failed` | — | 任务失败 | 界面 → `failed` / 列表 `error` |
| | `cancelled` | — | 用户停止 | 界面 → `idle` / 列表 `aborted` |

### 2.3 三条迁移规则

**(a) `session.summary` 只降级为「本轮」叙事，不再参与完成判定。**
`sessionStatusFor(status, task)` 里**没有任何一条分支读 summary**。`SummaryCard` 的文案随之
改成「本轮已结束 / 本轮被中断 / 本轮出错」，并带 `data-attempt-summary` 标记，让「这一轮」
与「这个任务」在界面上是两句不同的话。历史会话的 summary 仍可在执行轨迹查看（§17.2-7）。

**(b) 有任务契约时，任务状态压倒一切旧信号。**
`sessionStatusFor` 优先读 `task.status`，映射关系即上表末列。`sessionListOutcome` 的取值域
比它宽一格——列表要多区分「中断」与「失败」，主区状态机不区分，所以是两个函数而不是一个
加参数。

**(c) 没有任务契约时（历史会话 / 旧库），宁可回 `idle`，不拿「有 summary」当「做完了」。**
`idle` 不承诺完成，`completed` 承诺。旧列表实现是
`lastOutcome ?? (title ? "completed" : "idle")`——首条消息会被用作占位标题，于是「有标题」
几乎恒真，列表里满屏「完成」，包括那些跑了一半还在等授权的任务。现在无任务时只承认明确的
`error` / `aborted`，其余一律 `idle`。

### 2.4 一个刻意保留的不一致（必须知道）

`runner.ts` 有**两处**用 `session.status: "waiting_input"` 表达「副作用未知」：

- `runner.ts:1205`（`unknownSideEffect` 分支）
- `runner.ts:1248`（catch 分支的三元）

也就是说，`session.status` 的 `waiting_input` 被复用成了两种含义：真的缺信息，以及
「写操作结果不明」。任务层对后者有更精确的表达——`blocked(unsafe_replay)`。

**界面不受影响**，因为 lectern 的 `sessionStatusFor` 在**有任务时完全不读 `session.status`**
的 waiting 值，只由 `task.status` 决定。但这意味着：任何将来想从 `session.status` 反推任务
状态的新代码都会踩到这个复用。如果哪天要给 `session.status` 加 `waiting_external`，先来改
这里，别绕过任务层。

### 2.5 「重试」为什么必须是一个真实通路（§13.2）

`resumeTask` 三步：① 放掉 `recovery_required` 闸；② 任务回 `queued` 并清 blocker；
③ **重置 `noProgressCount` / `attemptCount` / `activeMs`**（`RESET_GUARDS_ON_RESUME`）。

第三步不是顺手清理。没有它，「检查后重试」按下去会立刻撞回同一个阻塞——一个被
`no_progress` 判死的任务，用户核对完外部状态再点一次，如果计数器还停在 3，它会在第一轮
结束时就又落回 `blocked(no_progress)`。那样按钮虽然活着，但**按不动**，等于把
§18「恢复原 task」变成形式上的满足。

同一条规则也作用于「用户发消息恢复」那条路径（`resolveTaskForPrompt` 的 resuming 分支），
原因相同。

---

## 3. PDF 场景 E2E 运行记录（§20.5）

### 3.1 覆盖位置与形态

规格 §17.3 的四个场景，落点如下：

| 场景 | 落点 | 形态 |
|---|---|---|
| A · PDF 内容铺到网页 | `src/core/runtime/task-runtime.test.ts` | **运行时 E2E**：真 runner + 真 SQLite 事件日志 + 脚本化模型 |
| B · 推送失败 | 同上，`task_block` 四条用例 | 运行时集成（见 3.3） |
| C · 命令无输出 | 同上 | 运行时 E2E |
| D · 应用重启 | `src/core/runtime/lease-recovery.test.ts` + `e2e/packaged-smoke.mjs` | 租约语义用例 + **打包版硬杀重启**（真实启动路径，2026-09-19 补） |

**「运行时 E2E」是什么意思，以及它不覆盖什么。** 场景 A 走的是**真的** `SessionRunner`、
真的 `runLoop`、真的 Completion Gate、真的持久化事件日志（断言从 `eventLog.read()` 读回，
而不是去戳 runner 内部状态），只有模型替换成了脚本（`FauxResponseStep`）。走这条路是因为
规格要钉的是一个**状态机属性**——「模型停三次不算完成」——而它恰恰是模型不确定时最容易
漏掉的。浏览器里跑一遍反而**更弱**：真实模型的停顿次数不可控，断言会变成「看情况」。
不覆盖的是渲染进程与真实工具链（真 PDF 解析、真构建）。这两段由文件附件规格的
`extract-pipeline.test.ts`（真 PDF）与 `lib/attachments/extract/pdf.test.ts` 覆盖。

### 3.2 场景 A 运行记录

**输入**：一条用户消息 —— 「把这个 PDF 的内容完整铺到网页上，并验证页面可用」。

**脚本**：六步任务，每步两帧 —— 先发一个把该步标成 `in_progress` 的 `todo` 工具调用，
再发一段**不含工具调用**的纯文本（`"${title}这一步先到这里，接着往下做。"`）。这第二帧就是
规格说的「模型正常结束」：它在旧实现里会直接触发「任务完成」。六步之后才补两条收尾帧
（六步全 `completed` 的 `todo` + 交付文本）。

```
titles = ["读取 PDF 并拆页", "提取正文与图片", "把内容写进页面",
          "本地构建并启动", "浏览器检查关键内容与资源", "修复发现的问题并交付"]
```

**实测输出**：

```
✓ §17.3 端到端场景 > 场景 A：六步任务由一条消息跑完全程，中途停三次不算完成 33ms
✓ §17.3 端到端场景 > 场景 C：写操作结果未知时落 blocked(unsafe_replay)，且不自动重放 27ms
  Test Files  1 passed (1)
       Tests  6 passed | 13 skipped (19)
```

**断言与结果**：

| # | 断言 | 结果 |
|---|---|---|
| 1 | 用户消息数 = 1（没有第二次 run，也没有合成消息） | ✅ |
| 2 | workflow run 数 = 1（六步在同一个 run 内由续跑驱动） | ✅ |
| 3 | 六个步骤全部 `completed` | ✅ |
| 4 | `task.delivered` 事件**恰好 1 次** | ✅ |
| 5 | 第一次 `task.delivered` 之前，`task.attempt.finished` **≥ 3** | ✅ |
| 6 | 交付文本含「浏览器检查」（来自最后一次尝试，不是中途那句「先到这里」） | ✅ |
| 7 | `task.result.outcome` 非空 | ✅ |

第 5 条是整份规格的主命题：如果系统仍把「模型停了」当「做完了」，第一次
`attempt.finished` 之后就会冒出 `task.delivered`——而那正是用户投诉的那个现象。

### 3.3 场景 B / C / D 的覆盖

- **场景 C**（命令无输出、副作用不明）：沙箱替身返回
  `{ ok: false, outcome: "unknown", durationMs: 30_000, outputText: "" }`。断言任务落
  `blocked` + `blocker.kind === "unsafe_replay"` + `resumable === true` + `requiredAction`
  含「确认外部系统」，且 **`sandbox.run` 只被调用 1 次**（没把「无输出」当失败去重试），
  `task.delivered` = 0，并且 `status !== "failed"`（它没坏，只是不知道）。
  实施中踩到一处：授权之前会先出现一条 `blocked(permission)`（§11.1 对用户是「在等你」），
  所以等待条件写的是「等 `blocker.kind === "unsafe_replay"` **那一条**」，别把前者当终局。
- **场景 B**（推送失败 → 需要登录）：由 `task_block` 四条用例覆盖 ——
  ① 缺信息落 `waiting_input` 且 `blocker.requiredAction` 是模型原话（显式断言**不含**
  「补充必要信息后任务会自动继续」这句模糊指示）；② 外部登录落 `waiting_external`，用户补齐后
  `disposition === "task_resumed"`、恢复**同一个** task、`task.blocked` 恰好 1 条；
  ③ 步骤全做完但在等用户时仍然不是 `delivered`；④ 参数不合法的声明不会把任务冻住。
- **场景 D**（重启）：framework 的 `lease-recovery.test.ts` 覆盖租约语义；**打包版应用的真实
  启动路径**由 `e2e/packaged-smoke.mjs` 的硬杀用例覆盖（2026-09-19 补，见 §4.3）。

---

## 4. 已知限制（§20.6 后半）

**(1) `waiting_input` / `waiting_external` 依赖模型主动调用 `task_block`。**
工具已经可用且可执行（§1.4），但模型如果只是**用文字**说「我缺一份凭据」而没调工具，系统
仍然按一次正常收尾自动续跑，三轮后落 `blocked(no_progress)`，真实原因被替换。缓解手段是
工具的 description 明确写了三种必须调用的情形（缺信息/二选一/外部登录）。这一条无法靠代码
根除——它取决于模型是否按契约调用；能保证的是**调用就一定生效**，且生效后状态与文案都正确。

**(2) 场景 A 是运行时级 E2E，不是浏览器 E2E。** 理由见 §3.1。真 PDF 解析与真构建不在
这条链路上；它们分别由文件附件规格的 `extract-pipeline.test.ts` 与 `pdf.test.ts` 覆盖。
没有把「真模型跑真 PDF」写进 CI。

**(3) 场景 D 的恢复验证：framework 租约语义 + 打包版真实启动路径（2026-09-19 补齐）。**
`lease-recovery.test.ts` 覆盖租约语义（恢复 / `unsafe_replay`）；打包版的启动路径现在由
`e2e/packaged-smoke.mjs` 覆盖——种入「过期租约 + 仍在 running 的任务」（其中一条另带未收尾
的工具调用），**SIGKILL 掉进程（不调 `desktop.close()`）**，重启后断言两条分支分别落
`waiting_input(input)` 与 `blocked(unsafe_replay)`，并且会话列表文案、任务卡文案与可点动作
（「补充信息」/「检查后重试」）都与状态对应。用例跑在 `pnpm test:packaged` 里，因此自动进
`desktop-release-check.yml` 的 macOS 与原生 Windows 两个 job。

**这条用例构造了什么、没构造什么（不要读成更强的结论）：** 磁盘状态是直接写进 SQLite 的，
因为打包冒烟不许调模型（`release-gates.md` 要求它可离线跑），跑不出一个真实 run。所以
「租约由 runner 亲手盖上」这一跳**没有**被覆盖；被覆盖的是它之后的全过程——恢复扫描、
任务对账、状态映射、界面文案与按钮。另外 `desktop.close()` 的优雅关闭路径（租约正常释放）
不再单独验证：它走的是 runner 的 clear，不是恢复。

**(4) framework `tsc --noEmit` 有 20 条既有测试文件错误**（`openai-provider.test.ts` 6、
`attachments.test.ts` 9、`builtins.test.ts` 3、`truncate-from.test.ts` 1、`workflow.test.ts` 1），
与本次改动无关，本次未动。**源码错误数为 0**（本次一度把它推到 22，因为新写的
`task-runtime.test.ts` 里 `h.deps.sandbox` 带出了 undefined 分支；已按该 harness 既有约定
显式暴露 `sandbox` 修掉，回到 20 的基线）。

**(5) framework 0.8.0 尚未发布到 npm。** Lectern 通过 `vendor/zmzai-agent-framework-0.8.0.tgz`
消费（320673 字节，含 `dist/core/tools/task-block.js`）。发布与 vendor 对齐见 §9。

---

## 5. 验证记录

```
# zmzai-framework（main，HEAD 97bde551 + 本轮测试文件修正）
npx vitest run        → 45 files / 529 tests passed
npx tsc --noEmit      → 源码 0 错误；20 条既有测试文件错误（见 §4.4）

# zmzai-lectern（worktree .worktrees/conversation-first-ui，分支 feat/task-execution）
npx tsc --noEmit      → 干净（exit 0）
npx vitest run        → 39 files / 418 tests passed
pnpm build            → 成功；/api/sessions/[id]/task 进产物清单
```

任务执行相关的测试分布（本报告结论的主要证据来源）：

| 关注点 | 文件 | 用例 |
|---|---|---|
| 领域模型 / TaskStore（含 SQLite 迁移、CAS） | `src/core/session/task-store.test.ts` | 33 |
| Completion Gate 五条件与判定顺序 | `src/core/task/completion.test.ts` | 32 |
| 契约存续（goal / criteria / remaining / blocker） | `src/core/task/contract.test.ts` | 12 |
| 进度指纹与三档 no-progress | `src/core/task/progress.test.ts` | 13 |
| 计划 / 步骤拆解 | `src/core/task/plan.test.ts` | 21 |
| `task_block` 工具（三类声明、非法参数、免授权） | `src/core/tools/task-block.test.ts` | 6 |
| 运行时集成（续跑、权限、预算、重启、场景 A/C） | `src/core/runtime/task-runtime.test.ts` | 19 |
| 租约恢复与崩溃对账 | `src/core/runtime/lease-recovery.test.ts` | 10 |
| `task.*` 事件 schema | `src/core/events/manifest.test.ts` | 10 |
| **§17.2 七条逐条** | `lib/task-execution.test.ts` | 35 |
| 呈现派生（纯函数表、按钮清单） | `lib/task-presentation.test.ts` | 16 |
| 投影器（任务深拷贝、revision 单调、换任务重置） | `lib/chat-projector.test.ts` + `task-execution.test.ts` 附加组 | 7 + 2 |

`lib/task-execution.test.ts` 顶部写下的那段话是本文件几条断言的由来，一并留在这里：

> 规格要修的是一个**归因错误**：把「一次运行结束」当成「任务完成」。这类错误很难靠人眼
> 发现——界面上两句话长得几乎一样，只有在「跑了一半就停下」的时刻才会分叉。

同文件里两个辅助函数的取舍值得一提：`code()` 剔掉注释行——注释里写「这里不再有 X」是好
文档，不该被判违规；`semantic()` 剔掉 `createdAt` / `updatedAt` / `deliveredAt` 三个本地
时间戳——投影器用 `new Date()` 生成它们，两次重放会差几毫秒，直接深比必挂，而它们不承载
任何语义。

---

## 6. 第 18 节逐条验收

| # | 标准 | 结论 | 证据 |
|---|---|---|---|
| 1 | 一个至少五步的模拟任务由一条用户消息启动并自动完成，全程无需「继续下一步」 | ✅ | 场景 A：六步、一条消息、一个 workflow run、六个 step 全 completed |
| 2 | 模型在任务中途正常结束至少三次时自动续跑，聊天记录中没有合成用户消息 | ✅ | 场景 A 断言 5：首次 delivered 前 `attempt.finished ≥ 3`；断言 1：用户消息数 = 1 |
| 3 | 任一 required step/criterion 未完成时，UI、通知和 session 列表均不显示「任务完成」 | ✅ | `presentTask.completed` 单点定义；`sessionListOutcome` 不再把「有标题」当完成；§17.2-1/3 |
| 4 | 任务完成状态只由持久化 `task.delivered` 驱动，并有验收 evidence | ✅ | `ROWS` 行 0a 只认 `task.status === "delivered"`；`taskNotice` 只对 delivered 改标题/播提示音；evidence 由 `TaskResult` 与 criterion evidenceIds 承载 |
| 5 | 权限通过或用户补充信息后，恢复原 task，不创建新 root task | ✅ | 权限等待用例（replyPermission 后继续同一 Attempt）；`task_block` 的 external_auth 用例断言恢复同一 task、`task.blocked` 恰好 1 条 |
| 6 | 工具超时、网络错误、未知副作用、无进展和服务重启均有明确、可测试的状态转换 | ✅ | 场景 C（unsafe_replay）；no_progress 三档；401 只跑一轮落 failed；`lease-recovery.test.ts` |
| 7 | 最终交付信息含结果、主要改动、验证方式和剩余项；无剩余项时明确为「无」 | ✅ | `TaskResult` 四问；`TaskDeliveryCard` 的 `data-task-outcome` / `-basis` / `-remaining`；「剩余项：无」有显式分支 |
| 8 | 正常内部 Attempt、checkpoint 和 continuation 不触发完成通知 | ✅ | `taskNotice` 对 queued/running/recovering/verifying 返回 `null`；§17.2-3 七项断言 |
| 9 | 同一 session 不会有两个 active root task 并发修改工作区 | ✅ | `resolveTaskForPrompt` 只复用活跃任务或开新任务；`isActiveStatus` 判定；重复 requestId 返回同一 task |
| 10 | 历史会话仍能加载，旧 summary 不再被误判为新 Task 的 delivered | ✅ | §17.2-7 四项：历史 summary 可查看、不产出任务、不显示完成、列表回 idle |
| 11 | Framework 与 Lectern 的类型检查、单元测试、构建及 PDF 场景 E2E 全部通过 | ✅ | §5 验证记录（framework 20 条既有测试错误见 §4.4） |

---

## 7. 第 19 节禁止项核查

| 禁止项 | 结论 | 说明 |
|---|---|---|
| 只修改 system prompt 让模型「尽量继续」 | 未违反 | 动了运行时状态机（`runTask` 循环 + Completion Gate）与持久化 `TaskRecord`，不是提示词 |
| 在前端自动点击或隐藏「继续下一步」 | 未违反 | 按钮与合成 prompt 一并**删除**；§17.2-2 是源码级断言，剔除注释后不存在相关标识符 |
| 用新增一条伪用户消息作为内部 continuation | 未违反 | `driveText` 替换 `input.text`、`resumeTask` 走 `RESUME_DRIVE_TEXT`，两者都不落库；场景 A 断言用户消息数 = 1 |
| 用 `session.status === idle`、模型 stop 或 summary completed 判断任务完成 | 未违反 | `sessionStatusFor` 无一条分支读 summary；`completed` 只在 `task.status === "delivered"` 时为 true |
| 把 TaskRecord 只放在 localStorage 或 React 状态 | 未违反 | 持久化在 SQLite（`SqliteTaskStore`），跨进程重启与断线重连可读；投影器只做视图 |
| 无限续跑（必须有 no-progress、预算和副作用保护） | 未违反 | 进度指纹三档 + `blocked(no_progress)`；`activeMs` 预算（clamp 到 (0, 24h]）；Attempt 硬上限 64（默认 24） |
| 自动重试结果未知的外部写操作 | 未违反 | 场景 C：`sandbox.run` 只调 1 次，落 `blocked(unsafe_replay)` 而非重试或 failed |
| 直接修改 `node_modules` 中的 framework | 未违反 | framework 源码改动 → 测试 → 重打 vendor tarball（0.8.0）→ 更新 lockfile → 删旧 tgz |
| 把「无法验证」包装成「已完成但建议用户检查」 | 未违反 | `blocked(unsafe_replay)` 的 `requiredAction` 直说要确认外部系统；`resumable` 决定给不给重试按钮，不可恢复的阻塞不摆出可点的重试 |

---

## 8. 第 20 节交付物

| # | 交付物 | 位置 | 状态 |
|---|---|---|---|
| 1 | framework 的 TaskRecord、事件、store、continuation、Completion Gate、恢复逻辑和测试 | `zmzai-framework` `8e2f827d` / `51ab1ec3` / `1f43ab11` / `d06d3921` / `97bde551` | ✅ |
| 2 | 新的 framework 包及 Lectern vendor/lockfile 更新 | `zmzai-framework` 0.8.0；`vendor/zmzai-agent-framework-0.8.0.tgz`（`ef87476`） | ⚠️ 未发布到 npm，见 §4.5 |
| 3 | Lectern 的 task API、投影、状态组件、通知逻辑和测试 | `app/api/sessions/[id]/task/route.ts`、`lib/task-presentation.ts`、`lib/task-execution.test.ts`、`components/TaskStatus.tsx`、`app/page.tsx`、`lib/chat-projector.ts`（`050d923`） | ✅ |
| 4 | 一份状态迁移说明，列出旧 `session.summary` 与新 task lifecycle 的兼容关系 | 本文 §2 | ✅ |
| 5 | PDF 场景 E2E 的运行记录或测试报告 | 本文 §3 | ✅ |
| 6 | 最终变更说明，明确完成判定依据和仍存在的限制 | 本文 §1 + §4 | ✅ |

---

## 9. 后续工作

1. **把 framework 0.8.0 发布到 npm**，并把 vendor tarball 与已发布版本对齐（当前 vendor 包
   即 `pnpm pack` 产物，内容与待发布版本一致，但 registry 上仍是 0.7.0）。发布后
   `package.json` 的 spec 可从 `file:` 切回版本号。
2. **观察 `task_block` 的调用率。** §4.1 那条限制的补法不在代码里——先看真实会话里模型是否
   按契约调用它。如果调用率低，要考虑的是工具 description 的措辞，或者把「缺信息」这类
   场景的识别前移到 Completion Gate（例如连续两轮文本里出现明确的缺信息陈述时给一次
   `waiting_input`），而不是继续加提示词。
3. ~~**真实应用的跨重启 E2E**（§4.3）：在 Electron 打包冒烟里加一条「跑到一半杀掉进程再启动」
   的用例，把 `lease-recovery` 的租约语义接到真实启动路径上。~~ **已完成**（2026-09-19）：
   `e2e/packaged-smoke.mjs` 的硬杀用例，覆盖两条恢复分支与界面文案，见 §4.3。
   残留：「租约由 runner 亲手盖上」那一跳仍未覆盖，需要能跑真模型的打包验收。
4. **`session.status` 的 `waiting_input` 复用**（§2.4）：若将来要区分「副作用未知」与「缺
   输入」，先给会话状态加值、再改 lectern 的 `sessionStatusFor`，别让新代码从会话层反推任务层。
