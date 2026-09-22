# Lectern 评测基线（M0 冻结物）

对应规格 `docs/superpowers/specs/2026-09-21-lectern-host-and-subagents-design.md` §4。两类评测严格分开：

- **deterministic/**：确定性可靠性套件（A 类）。scripted provider + 可计数工具 + 副作用探针，不依赖真实模型回答，验证状态与副作用。
- **real-model/**：真实模型任务集（B 类）。固定模型标识、端点、参数、fixture 仓库 commit、允许工具和预算，对比 lectern-before / lectern-after / zcode。

## 目录

```
evals/
  deterministic/cases.yaml   # A01–A40 案例定义（含分层与升级前可执行性标注）
  real-model/cases.yaml      # R01–R12 任务案例定义
  fixtures/                  # fixture 仓库规划与构建状态
  results/                   # 机器可读结果（results.schema.json 约束）
  harness/                   # 执行器（M0 起逐步建设，见下）
```

## Harness 分层

| 层 | 载体 | 现状 |
| --- | --- | --- |
| L1 | Framework 进程内集成（scripted provider + 临时 SQLite，参照 `e2e/smoke.mjs` 先例） | M0 建 skeleton |
| L2 | Lectern HTTP/SSE API 级（Next dev/standalone + 独立数据目录） | M0–M2a 建 |
| L3 | 进程/打包级（启动器、强杀、发行包；复用 `e2e/packaged-smoke.mjs` 等既有脚本） | M2a–M2c 建 |

案例的 `level` 字段声明所需层。harness 未建到的层，对应用例结果记 `not_run`，不假装通过。

## 结果纪律

- 每例至少 3 次独立运行（真实模型案例），隔离 fixture，禁止对用户实际项目做基准写入。
- token/费用缺失记 `null`，不能视为 0；`unverified`（环境/凭据不可用）与 `fail` 是不同结论。
- 结论同时给原始计数（如 2/3），不用小样本百分比。
- 结果文件必须通过 `results/results.schema.json` 校验。
- 与 ZCode 的比较是追赶报告，不作为“体验差不多”的验收。

## 版本化

- 案例文件带 `schema:` 版本头；内容变更即递增。
- 每轮基线报告（Markdown）与原始结果（JSON）一起提交，报告引用受控 fixture 证据，不复制用户工作区数据。
- 真实模型结果只在相关运行时/工具改动与发版时重跑（规格 §4.2）。
