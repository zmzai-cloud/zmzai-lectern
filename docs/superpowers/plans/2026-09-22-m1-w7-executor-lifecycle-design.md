# M1-W7 设计：AttemptExecutor + TaskLifecycle + ContextBuilder 抽离

- 日期：2026-09-22；状态：**S5–S8 全部实施完成**（见 §6 实施结果）
- 对应规格：§7（Runner 拆分）、§9.1（上下文组装与压缩）
- 基线：W6 收口后 runner.ts 1795 行；framework 552/552、typecheck 0 错误
- 前置文档：`2026-09-21-m1-w6-runner-split-design.md`（§8 实施结果含本设计要修的读偏斜竞态）

## 6. 实施结果（2026-09-22）

| Slice | 提交 | 结果 |
| --- | --- | --- |
| S5 TaskLifecycle | `0a59bf0a` | 552/552；scheduler.runJob 换绑 |
| S6 ContextBuilder + rebuildSnapshot | `2fcdf7e8` | 553/553（+1 TOCTOU 钉死）；**读偏斜竞态修复** |
| S7 AttemptExecutor | `be7ce315` | 553/553；runner 2068→**545 行**（越 400 审查线） |
| S8 CompactionStore 跨 Attempt | `f995ed6c` | 555/555（+2 复用/失效用例） |

关键实测发现：

1. **构造后改 deps 的引用语义**（S7）：测试会在 `new SessionRunner(deps)` 之后改 `deps.agentResolver` 等字段——executor 必须持**原 RunnerDeps 引用**而非构造时快照字段，快照会让 4 个用例静默失效。M2 Host 装配同样适用。
2. **§2.2 TOCTOU 修复落地**：`rebuildSnapshot` 单事务同拍读；FIFO 用例由时序侥幸升级为机制保证。
3. **§2.4 复用的诚实边界**（S8）：前缀指纹判据对纯文本历史有效；`rebuildMessages` 尚不重建 toolResult/tool call 消息，工具密集会话指纹天然失配 → 回落每 Attempt 重摘（与改动前等价，无回归）。**重建口径对齐（tool parts 重建）是解锁通用复用的后续项**，登记为 M1 后候选。
4. lectern 联调终验：484/484 + smoke PASS（对全部重构后的 framework）。


## 1. 范围与顺序

W7 拆 runner.ts 剩余主体，按依赖顺序三个单元、四个 slice（行为保持，CompactionStore 例外见 §4）：

| 单元（spec §7） | 现位置 | 内容 |
| --- | --- | --- |
| TaskLifecycle | casTask / syncTaskFromAttempt / settleTask / markPermissionWait / publishStepEvents / cancelResidualTask / runTask（Attempt 循环+预算闸） | 任务语义：投影、续跑、阻塞、交付条件 |
| ContextBuilder | rebuildMessages / buildCompaction / contextWindowFor / memory 注入点 / 排除快照 | 唯一上下文组装入口（§9.1）；**修 TOCTOU** |
| AttemptExecutor | runLoop 全体（Agent 构造、guards、事件漏斗、RunOutcome 装配） | 单次 Attempt 执行 |

W8（ToolExecutor 契约）不属 W7，工具相关代码原样随 runLoop 搬移。

## 2. 关键设计决策

### 2.1 runTask 归 TaskLifecycle，scheduler 的 runJob 换实现

`RunScheduler.executor.runJob` 当前指向 `SessionRunner.runTask`；S5 后改为 `TaskLifecycle.runTask`。TaskLifecycle 构造依赖：`store`、`publish` 回调、`attemptRunner`（执行单轮，S7 前由 runner.runLoop 实现，S7 后为 AttemptExecutor）。runner 对外 API（prompt/abort/resumeTask/replyPermission…）不动。

### 2.2 TOCTOU 修复（本设计唯一的行为变更，显式豁免行为保持）

现状：`runLoop` 先 `await workflowRuns()` 算排除集、**下一拍**才 `rebuildMessages()` 读消息——两拍之间 acceptPrompt 落库的新消息会泄入运行中 run 的上下文（W6 §8 已用插桩证实，FIFO 用例靠一拍微任务时序侥幸掩盖）。

修复：`WorkflowStore` 新增可选方法

```ts
/** 单事务内取「重建输入」：待排除的 user 消息 id 集与消息条目同拍读取。
 *  sqlite 实现一个 transaction 读两表；JSONL 实现退化为现状（两拍，注明）。 */
rebuildSnapshot?(sessionId: string): Promise<{ entries: MessageEntry[]; excludedUserIds: Set<string> }>;
```

ContextBuilder 优先走 `rebuildSnapshot`，缺失时回落现状两拍（JSONL/demo 模式可接受——该模式无并发提交面）。FIFO 用例从「时序侥幸」升级为「机制保证」，另加一条单测：模拟两拍之间插入提交，断言不泄漏。

### 2.3 ContextBuilder 收口组装点（§9.1 的先行子集）

`buildAttemptContext(session, input, acceptedUserId)` 返回 `{ history, systemPromptBlocks, compactionTransform, baseline }`——把 runLoop 里散落的「读排除集、rebuildMessages、记忆召回 unshift、压缩 transform 构建」收进一处。runLoop 保留执行装配（Agent 构造、tools、guards）。§9.1 的 ContextManifest/预算计费不在 W7（M2 随命令契约）。

### 2.4 CompactionStore 跨 Attempt（规格 §9.1，W7 的第二刀）

现状缺陷（已核实）：compaction.ts 的 anchor 是 `createCompactionTransform` 闭包变量，`runTask` 每个 Attempt 新建 transform → 跨轮重复摘要。S8：CompactionRecord 持久化（summary、源水位、streamEpoch、摘要模型）存 store（新增可选 `store.compaction`），`buildAttemptContext` 跨 Attempt 复用有效投影；rewind/源历史变化时失效重建。JSONL 无 store 时保持现状。对应 A30/A31 的 vitest 等价物。

## 3. Slice 计划（每步后 552 全绿 + typecheck 0）

| # | 内容 | 规模 | 备注 |
| --- | --- | --- | --- |
| S5 | TaskLifecycle 抽离（含 RESET_GUARDS_ON_RESUME 从 command-service 移入 task 域） | ~450 行净移 | scheduler.runJob 换绑 |
| S6 | ContextBuilder 抽离 + `rebuildSnapshot`（sqlite 实现）+ TOCTOU 测试 | ~200 行净移 + store 方法 | 唯一行为变更 |
| S7 | AttemptExecutor 抽离（runLoop + RunOutcome + guards 装配） | ~500 行净移 | runner.ts 预计降至 ~600 行（PI 适配与事件漏斗随迁） |
| S8 | CompactionStore 跨 Attempt | 新增 | A30/A31 单测 |

完成后 runner.ts 预计 1795 → **~600 行**（剩余为装配与对外 API 门面），达到 §7 的 400 行审查线附近。

## 4. 测试策略

- 既有 552 套件每步全绿为硬门禁；FIFO 用例每步后 3×。
- 新增：TOCTOU 单测（§2.2）、CompactionRecord 跨 Attempt 复用与失效（A30/A31 等价物）、TaskLifecycle 的 verdict→状态投影表驱动用例。
- W6 的 async 委托纪律延续：所有新门面方法非 async 直通委托。

## 5. 风险

- R-1 S7 规模最大（runLoop 内闭包捕获极多），如单 slice 超预估，允许把「事件漏斗/serializeEmit」再拆一步，但不允许半搬（runLoop 必须一次整体迁移）。
- R-2 `rebuildSnapshot` 是 WorkflowStore 接口扩展——Lectern 侧有自定义 store 实现的豁免面（可选方法，回落路径保底）。
- R-3 S8 改 compaction 语义边界：摘要复用只在「源水位与指令版本未变」时生效，任何不确定一律重建（宁重复摘要，不脏上下文）。
