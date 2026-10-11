# Jev 决策模型整合 P0 清单

Date: 2026-10-11
Status: 待拍板（Jev 仍处 early access，P0-0 含可达性实测门禁）

## 背景与总原则

Jev 是 TypeSafe AI 2026-09-15 发布的 "System One Model"：不生成自然语言，
API 形态为 state + 命名的类型化问题 → 结构化答案。三种原语：

- **Choice**：从列表选一项（带 probabilities + confidence）
- **Score**：按 rubric 打分
- **Noul**：陈述真伪判断（0–1）

宣称比 LLM 快 200x、便宜 400x（docs.typesafe.ai / console.typesafe.ai）。

zmzai 全线散落大量"小决策点"，现状要么写死阈值、要么烧完整 LLM 调用。
本清单只收 P0：接入地基 + 三个决策点替换。总原则（所有 P0 共同约束）：

1. **决策模型做增强，规则做兜底**：任一决策调用失败/超时/未配置，同步回落
   到现有规则路径，行为与今日一致。
2. **feature flag 关闭 = 行为零差异**：默认关闭，灰度开启。
3. **热路径延迟预算**：loop-guard、进展判定在每轮循环上，决策调用必须带
   硬超时；超时即走回落，绝不阻塞主流程。
4. **framework 测试总数只增不减**（既有约定）。
5. 决策点输出一律带 confidence/概率，低置信度自动走回落，不做静默采纳。

## P0-0 接入地基：DecisionProvider 门面 + Jev 实测门禁

| 项 | 内容 |
| --- | --- |
| 仓库 | zmzai-framework（门面）、zmzai-relay（渠道） |
| 现状 | framework 的 `ModelCaps`（`src/adapters/openai-provider.ts:11-21`）只是宿主模型目录的描述性查询；无任何决策模型接口。relay 渠道类型只有 LLM chat 通道。 |
| 改动 | ① framework 新增 `DecisionProvider` 门面：`decide(state, questions[])`，三原语类型定义（Choice/Score/Noul），内置超时+回落+confidence 阈值语义；**非 async 直通门面层不适用**（决策本身是远程调用，但接口按一次批量多问题设计，利用 Jev 并行评估特性）。② relay 将 Jev 配置为一种新渠道类型，framework 指向 relay 端点（复用 key 管理/监控），不直连 console.typesafe.ai。③ 实测门禁：early access 可达性、真实延迟（P50/P99）、真实价格、国内网络路径，产出一份实测记录；不达标则 P0-1~P0-3 全部冻结。 |
| 验收 | 单测覆盖回落路径（超时/5xx/低置信度）；flag 关闭时全量现有测试不变绿变红；实测记录入本文件附录。 |
| 依赖 | 无（其余 P0 全依赖此件） |

## P0-1 记忆沉淀门控（首个试点，风险最低）

| 项 | 内容 |
| --- | --- |
| 仓库 | zmzai-agent |
| 位置 | `lib/memory/retain-hook.ts:16-61`、`lib/memory/format.ts:64-73` |
| 现状 | run 终态后把**全部**新增 user/assistant 消息无差别推给 Hindsight retain；唯一门禁是 transcript 非空；超 8k 字符整体盲截断。寒暄、报错、重试轮全量投喂。 |
| 改动 | retain 前加一次 Jev 批量判定（fire-and-forget 链路，延迟宽松）：Noul「本 run 是否含值得长期保留的事实」+ Score「沉淀价值分」+ Choice「全量 / 选段 / 跳过」；选段结果替换 8k 盲截断。 |
| 验收 | ① 抽样一周：寒暄/纯报错 run 不再触发 Hindsight 抽取调用（省调用比例有数据）；② 抽样对比新旧记忆召回质量不降；③ 决策失败时回落全量投喂（现行为），UI/日志可观测回落率。 |
| 依赖 | P0-0 |

## P0-2 失败分类器（loop-guard 增强，热路径）

| 项 | 内容 |
| --- | --- |
| 仓库 | zmzai-framework |
| 位置 | `src/core/runtime/loop-guard.ts`（storm=3 :16 / blocked=3 :18 / edit=2 :20）、接线 `src/core/runtime/attempt-executor.ts:367-427` |
| 现状 | 固定阈值：连续失败计数达阈值才注入"改变策略"指令；对第一次就明显 fatal 的错误也要傻等满次数。签名刻意不含 args（防"化妆参数"），需保留。 |
| 改动 | 仅在**阈值边缘（第 2 次）**触发一次 Jev Choice：`fatal / retryable / strategy_change`；fatal 提前止损。不做每次失败的逐次调用（热路径成本）。签名机制不动。 |
| 验收 | ① 明显 fatal 错误（权限拒绝、路径不存在类）平均少浪费 1–2 轮；② 跑既有 task/eval 集对比误杀率不升；③ 决策超时即回落固定阈值，无延迟回归。 |
| 依赖 | P0-0；建议在 P0-1 试点数据达标后启动 |

## P0-3 任务进展打分（no-progress 判定增强）

| 项 | 内容 |
| --- | --- |
| 仓库 | zmzai-framework |
| 位置 | `src/core/task/completion.ts:86-93`（no-progress 3 轮一刀切）、`src/core/task/progress.ts:60+`（taskFingerprint）、执行处 `src/core/runtime/task-lifecycle.ts:518-552` |
| 现状 | 语义指纹（防刷设计，注释详述）是确定性底座；但"原地打转 vs 缓慢推进"是 3 轮二值一刀切，漏判"有意义的未完成动作"。另：`task-lifecycle.ts:229` 的 `budgetExhausted` 恒填 null，token/费用维度预算缺失。 |
| 改动 | ① Jev Score 对（指纹差、最近 Attempt 轨迹）打"进展分"，分数并入 no-progress 判定：打转更早止损、慢任务不误杀。指纹本体不动（确定性底座不概率化）。② 顺带补 budgetExhausted 的 token 预算维度（此项不依赖 Jev，可先行独立做）。 |
| 验收 | ① 打转任务止损轮数下降；② 有意义的慢任务（eval 集标注）存活率上升；③ 防刷回归：taskFingerprint 防刷测试全绿。 |
| 依赖 | P0-0；budgetExhausted 子项无依赖可先行 |

## 执行顺序与理由

P0-0（地基+实测门禁）→ P0-1（fire-and-forget 链路试点，出真实数据）→
P0-2（热路径，靠试点数据背书延迟假设）→ P0-3。
先低风险链路验证 Jev 真实质量，再上 agent 循环热路径。

## P1 展望（本轮不做，占位）

- qa-check 泛化（`src/core/tools/qa-check.ts:34-67`，已是结构化 pass/fail 形态，
  正则→决策模型零阻抗）；
- 子代理结果自动验收（`coordinator.ts:401-406` reviewChild 有决策面无决策者）；
- relay 渠道周期性 priority 重排 + 熔断阈值自适应（离线打分写回 Mongo，
  请求路径保持纯规则）；
- relay 滥用/异常用量风控（目前空白）。

## 明确不做（决策模型禁入区）

- 权限审批（安全语义必须确定性、可审计，用户同意权不交模型）；
- compaction 触发阈值（prompt cache 前缀字节稳定性依赖它）；
- failover 循环、限流计数（确定性/计费强相关）；
- `/api/ask` 总结、summarizeRun、摘要生成（生成任务，Jev 明确不做）；
- 工具结果逐行裁剪打分（正则近零成本，模型化可能成本倒挂）。

## 风险

- Jev early access：价格/配额/SLA 均未验证，P0-0 实测门禁不通过则全线冻结，
  已写代码仅留门面与测试（flag 默认关）。
- 国内可达性未知：relay 渠道化时预留代理/自建转发位。
- 决策漂移：所有决策点记录（输入摘要、答案、confidence、是否回落）入结构化
  日志，供后续校准与审计。
