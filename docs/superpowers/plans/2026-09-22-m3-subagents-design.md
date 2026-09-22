# M3 设计：子代理持久协调（B0 最后核心块）

- 日期：2026-09-22；状态：设计稿，供 review 后实施
- 对应规格：§8 全节（工具接口/持久模型/并发写权/权限取消预算/UI 最小闭环）、§9.4（任务契约与父级验证）
- 前置：M1 拆分后 AttemptExecutor 持有 spawnSubagent 回调（collabs 注入）；framework 0.10.0 已含 ToolContract（effect/concurrency 声明面就绪）
- 现状基线：spawnSubagent 同步 await 子 runLoop 至终态（串行、句柄即抛）；SessionRunner.runAttempt 是嵌套子运行的现有入口；task 工具 35 行串行封装

## 1. 总体决策

### 1.1 协调器在 framework（SubagentCoordinator），不在 Lectern Host

子代理的调度域 = 任务执行域（TaskLifecycle 的 parked/mailbox 语义要直接操作 RunScheduler），放 framework 使 Lectern Host 经现有 runner 透明获得；Host 只做配置（并发上限）与 UI 查询面。与 §8.1"均通过 Framework 服务调用，不在工具实现里另建调度器"一致。

### 1.2 五工具语义（§8.1 逐条实现）

| 工具 | 实现要点 |
| --- | --- |
| `agent_spawn` | 登记 SubagentRecord（queued）+ 创建 childSession（同事务）→ 通知 coordinator 调度 → **立即返回 childId**（不等待） |
| `agent_list` | 读当前 Task 树内子代理状态+最近进度（coordinator 内存投影 + store 复核） |
| `agent_send` | mailbox 持久投递（messageId 去重）→ 若 child 在 waiting_input 则唤醒；终态返回 CHILD_TERMINAL 不复活 |
| `agent_wait` | 最多 30s：等首个终态/需处理状态；无变化返回 running——**非 async 直通语义**（不得 await 挂死父执行器） |
| `agent_cancel` | 幂等标记 cancelling → coordinator 停止 admission → 取消子 run → 收尾后 cancelled |

旧 `task` 工具 = spawn+wait 兼容封装（保留返回形态）。

### 1.3 持久模型（§8.2 SubagentRecord）

```ts
type SubagentRecord = {
  childId: string;            // 协调主键（= childSessionId，spec：spawn 幂等键）
  childSessionId: string; parentSessionId: string; rootTaskId: string; parentTaskId: string;
  spawnRequestId: string;     // 同键重试返回同一 child
  agentType: string; goal: string; mode: "read_only" | "workspace_write";
  workspaceId: string;        // 共享工作区（B0 不做子 worktree）
  status: "queued"|"running"|"waiting_permission"|"waiting_input"|"waiting_external"|"cancelling"|"recovering"|"blocked"|"completed"|"failed"|"cancelled";
  revision: number; runId?: string; executionEpoch?: number; traceId: string;
  times: { spawnedAt: string; startedAt?: string; endedAt?: string };
  result?: { outcome: "completed"|"failed"|"cancelled"; summary: string; evidenceRefs?: string[]; usage?: unknown };
  consumeState?: "pending_review"|"accepted"|"needs_revision"|"rejected";
  parkedParent?: boolean;     // 父因 children parked（§8.2 调度状态，非第二 Task 状态）
};
```

存储：**项目 SQLite 新表 `subagents`**（framework store 扩展 `store.subagents`，同事务能力与 tasks 表同级）；mailbox 用 `subagent_messages` 表（messageId 去重唯一索引）。

### 1.4 并发与调度

- 限额：每根 Task 3 并发 / Host 全局 6（可配置 env `LECTERN_SUBAGENT_*`）；队列按根 Task 轮转、根内 FIFO；
- **parked 机制（§8.2 核心）**：父轮次结束但必要子代理未终态 → TaskLifecycle 置 `parkedReason=children`（Task 状态保持 running、释放父模型并发槽）→ 子结果入邮箱+父唤醒意图**同一事务** → RunScheduler 为同一 Task 调度内部续跑 → 多子同时完成经 mailbox 水位幂等合并为**一个**父唤醒；
- 子 run 复用 SessionRunner（childSession 无 parentId 递归保护已有）；read_only 子代理工具白名单（read/glob/grep/repomap/websearch 等 effect=[] 者），workspace_write 沿用 writePaths 圈禁。

### 1.5 写权（§8.3 B0 子集）

单写者由现有 lease+drain 序列保证（M2c 已有）：子 workspace_write run 在同一 session 队列内天然串行。跨根 Task 冲突写入的 WorkspaceAccessCoordinator 完整版（含 Host 全局写权表）**移 M4**——B0 内 session 级队列 + 并发上限 6 已把风险面缩到「多根任务同 workspace」一个窗口，记录为已知限制。

### 1.6 权限/取消/预算（§8.4）

- 权限交集：子 PermissionEngine 初始化 = 父 ruleset ∩ preset 声明（现有 writePathGuardRules 展开方向已对）；pending 请求持久化到 SubagentRecord（waiting_permission），父根会话事件流带 `subagent.` 前缀透出；
- 取消树：cancel → marking cancelling → 子 runner.abort()（M2b 已有）→ 终态确认 cancelled；父 cancel 经 coordinator 递归全后代；
- 预算：子 usage 逐 attempt 计入 rootTaskId 聚合（TaskRecord 已有 activeMs/tokens 通道，补 groupBy root）。

## 2. Slice 计划（M3a framework → M3b Lectern）

| # | 内容 | 层 | 验收 |
| --- | --- | --- | --- |
| S17 | `store.subagents` + `subagent_messages` 表 + SubagentRecord CRUD（CAS revision） | framework | 单测：spawn 幂等/状态机非法迁移拒绝 |
| S18 | SubagentCoordinator：限额队列 + spawn/list/send/wait/cancel + 子 run 生命周期接线（复用 SessionRunner） | framework | 集成：3 并发 spawn ≥2 区间重叠（A13）；重试 spawn 同 child（A14）；cancel 树无孤儿（A18） |
| S19 | parked/mailbox/父唤醒：TaskLifecycle parkedReason + RunScheduler 内部续跑 + 水位幂等合并 | framework | A28（父先停子后完 → 自动续跑一次唤醒）；A29（与取消竞争不复活） |
| S20 | 五工具注册（旧 task 兼容封装）+ read_only 白名单 + 权限交集 + 根会话 subagent.* 事件桥 | framework | A16（越界探针不变）；A17（Promise 正常返回≠completed）；A20（消息不丢） |
| S21 | Lectern：并发配置 + Host `/v1/subagents` 查询面 + UI 最小闭环（子代理列表/状态/取消按钮/权限卡来源标注） | lectern | 刷新后从 Host 快照恢复；子完成不弹根"已交付"（§8.5） |
| S22 | SpawnContract/ResultContract + 父验证（pending_review→accepted/rejected + evidenceRefs 校验）+ task_deliver 门禁扩展 | framework | A36（子自称成功但测试失败→父拒交付） |

## 3. 不做（B0 边界，spec 明示）

- 多 worktree 自动整合（W1）；子代理跨 Host 重启自动重放（首期 queued 可重调度、running 落 recovering 待人工确认，§8.4）；跨根 Task 通信；子代理多进程。

## 4. 风险

- R-1 parked/mailbox 的唤醒合并是 M3 最深水区——S19 单独一轮，先事务图后代码；
- R-2 子 run 复用 SessionRunner 的 globalThis activeRuns 键冲突（父子同进程）——childSessionId 键已天然分离，但 abort 树要沿 coordinator 走不能裸调全局表；
- R-3 UI 子会话只读展开（§8.5）依赖现有 childSession transcript 可读——S21 验证，缺则补 `/v1/sessions/:id/messages?childOf=` 过滤。
