# PC01–PC23 验收映射（2026-09-28，T00 交付）

- 层级说明：**模块** = 单仓库单元/组件测试；**装配** = 真实 createAgentRuntime/createServer + 真实 store 的集成测试；**进程** = 跨进程（Next/Host/Electron）注入式测试；**原生** = macOS 真机原生能力；**远端** = memory.zmzai.cloud 联调。
- 状态：`existing`（已有测试覆盖）/ `partial`（模块级有、生产链路缺）/ `new`（T01+ 新建）/ `tbd`（依赖后续任务）。

| ID | 门槛 | 层级 | 测试文件（现状 → 目标） | 环境 | 状态 |
| --- | --- | --- | --- | --- | --- |
| PC01 | 子代理创建（真实 runtime + 安装包工具） | 装配 | （无）→ framework `src/server/create-agent-runtime.subagents.assembly.test.ts` + lectern `lib/runtime-subagents.assembly.test.ts` | 本地 fixture sqlite + faux/scripted provider | new（T01 复现 / T02 修复） |
| PC02 | 子真实 outcome 传播 | 模块+装配 | framework `src/core/subagents/coordinator.test.ts`（spawn 幂等已有）→ 补 runChild failed/blocked/waiting outcome；lectern runChild 接线 | 同上 | partial（T03） |
| PC03 | 两项目并行限额 | 装配 | （无）→ AdmissionController 测试 + lectern 双 runtime fixture | 隔离双项目目录 | new（T03） |
| PC04 | spawn 重试/异 payload/中断 | 模块 | coordinator.test.ts（同键返回既有 child 已有）→ 补异 payload 409、事务中断回滚 | sqlite | partial（T02） |
| PC05 | 父 park 与子终态竞争 | 模块+进程 | framework `src/core/subagents/parked.test.ts` A28/A29（模块级已有）→ 生产链路 TaskLifecycle 接线（T05/T06） | sqlite | partial |
| PC06 | 邮箱各时点强杀恢复 | 进程 | （无）→ T06 注入式退出测试 | 子进程/exit hook | new（T06） |
| PC07 | agent_send 三态投递 | 模块+装配 | coordinator.test.ts + tools.test.ts（终态拒绝已有）→ queued 追加/安全边界/waiting_input 唤醒 | sqlite | partial（T04） |
| PC08 | 未验收子结果阻塞交付 | 模块 | framework `src/core/subagents/verification.test.ts`（门禁单元已有）→ CompletionState 真实 SubagentStore 查询 | sqlite | partial（T05） |
| PC09 | 根取消与派生/唤醒并发 | 装配 | （无）→ T05 事务性 admission 截止测试 | sqlite | new（T05） |
| PC10 | Host 收令后丢响应不二执行 | 进程 | `lib/host-gateway` 相关 + e2e/m2a-smoke.mjs 基础 → 回执查询/同键重试 | 本地 HTTP 代理 fixture | partial（T07） |
| PC11 | Host 单 owner / legacy 仅启动时 | 进程 | `host/src/server.test.ts`（3 tests 基础）→ armed 异常结构化、不动态回退 | Host 进程 fixture | partial（T07） |
| PC12 | 多项目/worktree 归属矩阵 | 装置+进程 | `lib/runtime-ownership.test.ts` + `lib/session-owner.test.ts`（部分）→ OwnerResolver 全路径 | 双项目双 worktree fixture | partial（T08/T09） |
| PC13 | 组合失败不推进目标 | 装配 | `lib/workspace-service.test.ts`（24 项 worktree 基础）→ merged/verifying/ready_to_advance 状态 + 实际验证执行 | git fixture 仓库 | partial（T10） |
| PC14 | 过期证据不放行/恢复不重复合并 | 装配 | 同上 → T11 集成场景 | git fixture | new（T11） |
| PC15 | smoke≠acceptance | 装配 | `lib/browser-verification.test.ts` 基础 → required 不降级 | 本地 fixture 服务 | partial（T13） |
| PC16 | 真实浏览器闭环 + Next 重启 | 进程 | `e2e/browser-verifier-e2e.cjs` 基础 → 表单/导航/错误态 fixture | Chromium | partial（T14） |
| PC17 | CUA Host 迁移 + 越权拒绝 | 装配+原生 | `lib/computer-use.test.ts` + `lib/computer-use-native.test.ts` 基础 → Host broker + 模型工具 | macOS | partial（T15） |
| PC18 | lease 串行/旧观察拒绝/接管停止 | 原生 | 同上 → T16 | macOS 真机 | new（T16） |
| PC19 | 未知动作不盲重发；Windows unavailable | 原生 | 同上 → T19 | macOS 真机 | new（T16） |
| PC20 | memory 绑定/越权/超时/撤权 | 远端 | （无）→ K1a 联调；无环境标 not_run | memory.zmzai.cloud 授权测试 bank | new（T17） |
| PC21 | retain 幂等/unknown/纠错 | 远端+模块 | zmzai-memory 契约测试（服务端）→ K1b outbox | 授权测试环境 | new（T18/T19） |
| PC22 | 6 类真实模型任务 ×3 | 远端 | `evals/real-model/cases.yaml` 已有案例定义 → 执行与记录 | 真实模型凭据 | tbd（T20；凭据缺失则 blocked） |
| PC23 | 发行物一致性（源码→build→vendor→安装包） | 装配+进程 | `scripts/release-validation` + `e2e/packaged-smoke.mjs` 基础 → 每轮 pack/vendor/install 后复跑 | macOS（Windows 标未验证） | partial（T12/G1） |

## 基线结论（与 spec §2 核查事实的关系）

- F01 深化：**createServer 不透传 subagentCoordinator** 是最深根因（runner.deps 恒 undefined → 工具/协调双路径全死）；Lectern `registry: undefined as never` 与 runChild 固定 `"completed"`（F02）叠加其上。修复顺序必须先接通 createServer 透传（T02），否则 Lectern 侧任何接线改动都无法生效。
- 基线存量失败（非本任务引入，修复责任在对应任务内）：
  1. Framework typecheck 13 错（subagents/tools.test.ts、completion.test.ts）→ T02 一并修复（同链路测试类型）。
  2. Framework parked.test.ts A28 环境超时（动态 import 7.1s > 5s）→ T04 改为静态导入或调超时。
  3. Lectern test:release 4 失败（web-server.source-test 未跟上 9831814 的 async ensureWebServer）→ 独立小修，随 T00 或 T07 提交。
