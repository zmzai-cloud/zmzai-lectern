# M1-W6 设计：CommandService + RunScheduler 从 SessionRunner 抽离

- 日期：2026-09-21；状态：设计稿，供 review 后实施
- 对应规格：§7（Runner 拆分与依赖约束）、§6.3（命令契约，M2 范围本次不引入）
- 改动对象：`zmzai-framework/src/core/runtime/runner.ts`（2,068 行，基线 51f061e0）
- 行为基线：tarball@0.9.0 vitest 43 文件 / 484 测试全绿（ADR 基线快照）；**每步拆分后必须保持同水平**

## 1. 范围

W6 只拆「提交」与「调度」两个外围职责；`runLoop`（单次 Attempt 内部，807–1340 行）、`runTask`（Attempt 循环）、`settleTask`/`syncTaskFromAttempt`（任务生命周期）、`spawnSubagent`、压缩与消息重建**全部不动**——它们是 W7（AttemptExecutor + TaskLifecycle + ContextBuilder）的对象。这样把风险限制在外围机械搬移。

## 2. 现状地图（runner.ts 职责 → 去向）

| 现位置 | 职责 | 去向 |
| --- | --- | --- |
| `prompt()` 550–611 | 双路径提交：workflow 模式（投影 → 任务归属 → acceptPrompt → task.started → 触发 drain → 回执）；legacy 模式（活跃 run 时 enqueuePrompt，否则直启 runLoop） | **CommandService** |
| `resolveTaskForPrompt` 489–527 / `rollbackTaskResolution` 535–548 | 消息↔任务归属判定（幂等锚点 findTaskByRequestId、steering/resume 处置）与提交被拒回滚 | **CommandService** |
| `replyPermission` / `revokePermission` 613–662 | 控制命令路由到活跃 run | 留在 SessionRunner（薄委托），依赖 ActiveRunRegistry |
| `drain()` 341–404 | FIFO 驱动链：claimPrompt → runTask → finishPrompt → 队列空后处理 resumeRequests 与孤儿 queued | **RunScheduler** |
| `driveResumedTask` 415–427、`resumeTask()` 637–649 | 用户放行通路的登记与推进 | **RunScheduler**（`resumeTask` 的任务 CAS 部分经回调注入，避免依赖任务层） |
| `abort()` 664–682、`cancelResidualTask` 693–700 | 停止协调：清队列 → dispose 引擎 → abort 活跃 run → 等 drain → 残余任务收尾 | **RunScheduler**（残余任务收尾经回调注入） |
| `stampLease`/`clearLease` 466–474 | 租约打点（owner 恒为 `node:${pid}`） | **RunScheduler**，owner 改为可注入（为 §6.2 的 hostInstanceId+epoch 预留，默认值不变） |
| 模块级 `activeRuns` 182–184、`isSessionActive` 等 2048–2067 | 全局活跃 run 表（挂 globalThis 防多副本） | **ActiveRunRegistry**（默认仍挂 globalThis 单例，导出函数签名不变） |
| `runLoop` / `runTask` / `settleTask` / `casTask` / `spawnSubagent` / 压缩 / `rebuildMessages` | 执行与任务语义 | **不动（W7）** |
| `persist` / `publish` 438–464 | 事件持久化漏斗 | 不动（W7 归 EventProjector 时再评估） |

## 3. 新模块与接口草案

### 3.1 `runtime/active-run-registry.ts`

```ts
export type ActiveRun = { agent; engine; settled(); abort(); done: Promise<void> }; // 原样搬移
export class ActiveRunRegistry {
  register(sessionId, run): void; get(sessionId): ActiveRun | undefined;
  delete(sessionId): void; list(): string[];
}
// 兼容层：runner.ts 原 isSessionActive/isSessionAwaitingPermission/listActiveSessions
// 改为委托默认实例（仍挂 globalThis.__zmzaiFrameworkRuns 语义），导出签名不变。
```

### 3.2 `runtime/run-scheduler.ts`

```ts
export type SchedulerExecutor = {
  /** 一条被认领的 job 怎么跑——W6 由 SessionRunner.runTask 实现，W7 换 AttemptExecutor。 */
  runJob(session: SessionInfo, input: PromptInput, userMessageId?: string): Promise<WorkflowState>;
  /** abort 收尾时对残余任务的处理——SessionRunner.cancelResidualTask。 */
  cancelResidual(sessionId: string): Promise<void>;
};

export class RunScheduler {
  constructor(deps: {
    store: SessionStore; executor: SchedulerExecutor;
    leaseStore?: LeaseStore; leaseOwner?: string;   // 默认 `node:${process.pid}`（现行为）
  });
  drain(sessionId): void;                 // 原 drain 全量搬移
  requestResume(sessionId): Promise<boolean>;  // 原 resumeTask（任务 CAS 经回调或 taskStore 直用，语义不变）
  abort(sessionId): Promise<void>;        // 原 abort 编排
  idle(): Promise<void>;                  // 测试辅助：等待全部 draining 完成
}
```

要点：scheduler 不 import runner（无环）；`drain` 的第三分支（resumeRequests 竞争窗口注释）**逐行原样搬移**，这是已知最脆的并发窗口，W6 不改语义只换位置。

### 3.3 `runtime/command-service.ts`

```ts
export class CommandService {
  constructor(deps: {
    store: SessionStore; scheduler: RunScheduler;
    publish: (event: FrameworkEvent, sessionId: string) => Promise<void>;
  });
  /** 原 SessionRunner.prompt() 主体；两条路径都收进来：
   *  workflow 模式 → 投影/归属/acceptPrompt/task.started/触发 drain；
   *  legacy 模式（无 workflow store）→ enqueue 或 scheduler 直启。 */
  submit(sessionId: string, input: PromptInput): Promise<{ queued: boolean } & Partial<PromptReceipt>>;
}
```

要点：幂等与 409 仍由 `WorkflowStore.acceptPrompt`（promptHash + findPrompt）与 `findTaskByRequestId` 锚点承担，CommandService 只做编排——**不重写存储语义**。§6.3 的 protocolVersion/commandScope 契约是 M2 的事，本次 `PromptInput` 形状不变。

## 4. 已识别的环依赖与解法

`workflow.ts` 目前 `import type { PromptInput } from "../runtime/runner.js"`。拆出 CommandService 后 runner ↔ command-service 会经过 PromptInput 形成环。解法：**把 `PromptInput` 类型移到 `session/workflow.ts`**（它本来就是提交协议），`runner.ts` 保持 `export type { PromptInput }` 再导出，外部导入路径不变。

## 5. 实施顺序（四个独立 slice，每个单独可 review、可回滚）

| # | 内容 | 预计规模 | 验收 |
| --- | --- | --- | --- |
| S1 | ActiveRunRegistry 抽离 + runner 兼容导出 | ~80 行净移 | vitest 484/484 |
| S2 | PromptInput 移至 workflow.ts + 再导出 | 纯类型搬移 | vitest + typecheck |
| S3 | RunScheduler 抽离（drain/resume/abort/lease），SessionRunner 持有并委托 | ~350 行净移 | vitest 484/484 + 手册：并发窗口注释原样保留 |
| S4 | CommandService 抽离（prompt 提交链 + 任务归属 + 回滚），SessionRunner.prompt 变薄委托 | ~300 行净移 | vitest 484/484 |

完成后 runner.ts 预计 2068 → **~1,400 行**（剩余为 W7 对象）。不追求一次到位 400 行审查线。

## 6. 新增测试（随 S3/S4 以 vitest 形态落地，不依赖 E 阶段 harness）

- scheduler：stopRequested 期间 claim 到的 job 判 cancelled；resume 落在收尾窗口不丢失（复刻 390–403 注释场景）；abort 等待 drain 完成后才收残余任务。
- command：acceptPrompt 抛错时任务回滚（rollbackTaskResolution 路径）；startedTask 才发 task.started；legacy 双分支的排队条件。
- 对应 A 目录映射：A03/A04/A27 的单元级等价物（完整 L2 场景留 E 阶段）。

## 8. 实施结果（2026-09-21）

S1–S4 全部完成，framework 仓 547/547 全绿、typecheck 相对基线增量零（基线本身有 21 个历史 test 文件错误，与本次无关）。runner.ts 2068 → 1795 行；新增 active-run-registry.ts（44）/ run-scheduler.ts（148）/ command-service.ts（190）。runner.ts 对外导出（PromptInput、isSessionActive 等）全部保持原路径。

实施中发现并处理：

1. **【已修】async 委托多一拍**：`async prompt() { return cmd.submit(...) }` 的 promise 采纳会多一个 microtask 才恢复调用方的 await，实测翻转了 prompt 提交与 drain 链的交错时序，使 FIFO 用例确定性失败。修复：委托层用非 async 直通（prompt/abort）。
2. **【登记，未修】runLoop 读偏斜竞态（TOCTOU）**：`runLoop` 先读 `workflowRuns()` 构建排除集、再 `rebuildMessages()` 读消息，两拍之间新提交的消息已落库但尚未计入排除 → **排队中的用户消息可泄入正在运行 run 的模型上下文**。基线靠微任务时序碰巧避开，任何一拍抖动都会暴露（上面第 1 条就是现实证明）。属真实潜在缺陷，修复归属 W7 的 ContextBuilder 统一快照（规格 §9.1），不属 W6 行为保持范围。修复前该窗口随每次重构都可能再现。
3. 设计偏差记录：`driveResumedTask` 留在 runner 作为 executor 回调（任务层语义），未按 §2 表格移入 scheduler；scheduler 的 `requestResume` 只收调度侧登记，任务 CAS 留在 `resumeTask`——与 §3.2 设计一致。
4. §6 承诺的 scheduler/command 新增单测尚未落地（收尾批次补），当前以 547 既有测试全绿 + 3×FIFO 稳定性为门禁。

## 7. 风险

- R-1 `drain` 搬移时闭包引用从 `this.deps` 换成构造注入，容易顺手"简化"——纪律：只换引用不改逻辑，竞争窗口注释一并搬走。
- R-2 Lectern 侧直接引用 runner 内部行为（如 `isSessionActive`）——已确认 smoke 与 API 层只用公开导出；S1 的兼容导出兜底。
- R-3 双模式 prompt() 的 legacy 分支搬进 CommandService 后，JSONL demo 模式行为漂移——用 e2e/smoke.mjs（JSONL 路径）在 S4 后手动跑一次。
