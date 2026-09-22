# M0 执行计划（倒排草案）与预算提案

- 日期：2026-09-21；状态：已按用户决策调整——**评测执行整体后置为独立阶段 E**（2026-09-21），M0 以案例冻结 + 盘点 + ADR + 本计划收口；倒排日历锚点待 D1
- 对应规格：`2026-09-21-lectern-host-and-subagents-design.md` §17（含 17.0 执行节奏总则）
- 原则：本文档是 B0 的日程事实来源；日历与人力未定前，粒度只到工作流与量级（S/M/L），不编造日期。

## 1. M0 交付物与现状

| 交付物 | 状态 |
| --- | --- |
| 确定性套件案例冻结（A01–A40，含分层/升级前可执行性标注） | ✅ `evals/deterministic/cases.yaml` |
| 真实模型任务集冻结（R01–R12） | ✅ `evals/real-model/cases.yaml` |
| 机器可读结果 schema | ✅ `evals/results/results.schema.json` |
| fixture 规划 | ✅ `evals/fixtures/README.md`（7 个 planned，构建顺序已排） |
| memory.zmzai.cloud API 盘点 | ✅ `2026-09-21-k1-memory-api-inventory.md` |
| Framework 联调方式决策 | ✅ `2026-09-21-framework-dev-linking-adr.md` |
| Harness L1 骨架（scripted provider + 副作用探针 + 假时钟） | → E 阶段（评测后置） |
| fixture 前 3 个（fx-multifile-bug / fx-failing-tests / fx-understanding） | → E 阶段 |
| 升级前基线首跑（deterministic 可执行子集 + 真实模型 R01–R03 若凭据可用） | → E 阶段 |
| Markdown 基线报告（原始计数、未验证项明确） | → E 阶段 |
| 真实模型预算上限固化 | 挂起至 E 阶段启动前 |

## 2. 工作流分解与依赖（B0 全程粗粒度）

量级：S≤1 天，M≈2–5 天，L≈1–2 周（单人等效；并行度取决于 D1）。

```
M0（2026-09-21 收口）
  ✅ 案例冻结 / 盘点 / ADR / 本计划
  评测执行（原 W1/W2/W4/W5）→ 整体后置为 E 阶段

M1 Framework 拆分（行为保持）← 当前阶段
  W6 CommandService/Store + RunScheduler (L)
  W7 AttemptExecutor + ContextBuilder/CompactionStore 跨 Attempt 化 (L)
  W8 ToolExecutor 契约（effect/concurrency/retrySafety + toolCallId 去重）(M)
  W9 模型能力快照统一（provider/endpoint 进 key）(S)
  W10 A30–A35 用例以常规 vitest 形态随实现落地 (M) ─→ tarball 收口
  依赖：W6→W7 可部分并行；W8、W9 独立

M2a 最小 Host 链路 (L)   →  M2b 路由四批迁移 (L×批次)  →  M2c 恢复/打包/切换 (L)
  M2a 含 SSE 代理长连接验证；M2b 每批跑 A 类对应用例；M2c 后发 0.7.0

M3 子代理协调 (L+)：coordinator + 五工具 + 写权 + parked/mailbox + UI
M4 全量回归 + 发布检查 → 0.9.0；真实模型重测在 E 阶段回填

E 评测阶段（前置：M3 收口后，可与 W1 并行）
  harness 三层建设 + fixtures + 升级前后两轮基线 + ZCode 对照 + 差距报告 + 性能门槛全量留档
```

0.6.x 合并窗口：M1 全程 + M2a/b 期间，0.6.x 只收 bug 修复；倒排计划固定每 2 周一个合并窗口同步 0.6.x 关键修复到主分支（具体节奏随 D1 定）。

## 3. 真实模型预算提案（挂起至 E 阶段启动前再批）

- 单次运行上限：单 run 输入+输出 ≤ 500k tokens；工具干预（人工介入）≥1 次即计入报告。
- 单轮全量：12 案例 × 3 次 × 3 系统 = 108 runs；M0 + M4 两轮 ≈ 216 runs，规划上限 54M tokens/两轮（按单 run 上限×108×2 的 50% 有效利用率估）。
- 费用不硬编码：按实际账单记录，缺失记 null。
- 触发重跑的条件（沿用规格 §4.2）：仅运行时/工具改动与发版；UI 提交不消耗预算。
- 扩展阶段（W/V/C/K 验收）按需追加单案例重跑，不整轮重跑。

## 4. 待用户决策点

| ID | 决策 | 建议 |
| --- | --- | --- |
| D1 | 日历锚点与人力（B0 投入几人、期望哪个季度收口 M4） | 提供后本文档升级为带日期版 |
| D2 | 真实模型预算上限（§3 提案值或修正） | 挂起至 E 阶段启动前（评测后置，2026-09-21） |
| D3 | task_deliver 调用率（0.6.x backlog）排期 | M0 冻结前完成（小改动，避免与 M1 双线改 runner） |
| D4 | 版本锚点确认（M2c→0.7.0、M3→0.8.0、M4→0.9.0） | 按建议值 |
| D5 | K1 桌面端鉴权方向：PAT / OAuth device flow / webview 复用 cookie | PAT（实现小、可撤销、与现有 cookie 会话并存；盘点报告 §4.1） |

## 5. 风险登记

- R-1 真实模型凭据或 ZCode 运行环境不可用 → 随评测后置一并移入 E 阶段风险。
- R-4 评测后置期间，里程碑验收以「既有回归 + 阶段内新增针对性测试」为准，能力回归要到 E 阶段才暴露——缓解：M1 严格行为保持（拆分不改语义），211 个既有测试全绿作为每步硬门禁；A 目录继续作为完成定义参照。
- R-2 Harness L1 骨架低估（scripted provider 与 PI 适配的接缝）→ 首个用例接入后重新估算，超 M 量级即修订本文档。
- R-3 K1 服务端缺口大于本盘点的"中"评级（尤其 expectedVersion 需动上游）→ 已按规格允许将 revise 乐观锁后置，不阻塞 K1 首轮联调。
