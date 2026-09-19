# Lectern 后续工作清单

**日期：** 2026-09-18
**适用仓库：** `zmzai-lectern`（第 3、4 项涉及 `zmzai-framework` 与运维侧数据）
**来源：** 三份 2026-09-17 规格验收报告的「后续工作」章节，加上本轮 CI 实测后的新增判断

三份规格（对话优先视觉 / 文件附件与引用 / 持续任务执行与可信交付）已全部落地、快进合并进
main，渲染层 CI 两轮全绿。**本文只收仍然开着的项。** 每项给出可直接粘贴执行的 prompt。

改任何一块之前，先读对应的验收报告——它们记录的是「为什么这样做」和「刻意没做什么」，
比代码更能防止反向重构：

| 规格 | 验收报告 |
|---|---|
| 对话优先视觉 | `2026-09-17-lectern-conversation-first-visual-design.verification.md` |
| 文件附件与引用 | `2026-09-17-lectern-file-attachments-and-references-spec.verification.md` |
| 持续任务执行 | `2026-09-17-lectern-continuous-task-execution-spec.verification.md` |

## 总览

| # | 项 | 前置 | 量级 | 建议 |
|---|---|---|---|---|
| 1 | `ui-e2e.yml` 升格为发版门禁 | 无 | 小 | **先做** |
| 2 | 打包版「硬杀重启」任务恢复 E2E | 无 | 中 | **先做** |
| 3 | `task_block` 调用率观察 | 需真实会话数据 | 长期 | 顺带 |
| 4 | `MessageAttachmentCard` 组件级测试 | 需先引入前端测试基础设施 | 中 | 单独决策 |
| 5 | 真机触摸屏拖拽 | 需硬件 | 小 | 挂着 |

不属于本文范围：`docs/p0-p1-tracker.md` 里 0.5.0 时代的 P0/P1（macOS/Windows 代码签名、
跨版本更新回滚、原生 Windows 安装器验收等）是另一条线，其中签名仍卡在外部依赖
（本机 keychain 无有效签名身份）。

---

## 1. `ui-e2e.yml` 升格为发版门禁

> **已完成（2026-09-19），按方案 A。** 判定是纯函数 `judgeRuns`，IO 是 `checkUiE2eGate`
> （`scripts/ui-e2e-gate.mjs`），接在 `scripts/upload-oss.mjs` 的上传前路径上，规则写进
> `docs/release-gates.md` 的「Release gate: rendering-layer E2E」一节。
> 证据：对真实的 `f81a69d`（failure）与 `7a5e808`（cancelled）拒绝、对 `382a038`（success）
> 通过；把门禁接进 uploader 后，未通过时**一个对象都不写**（`test:release` 里有断言钉住顺序）。
> 30 项单测覆盖判定矩阵与三条 fail-closed 路径。

**背景。** `ui-e2e.yml` 已连续两轮全绿（run 35320438902、35322890964），稳定性够格当门禁。
但发版流程目前只看 `docs/release-gates.md` 里那几条本地检查，**渲染层 E2E 绿不绿不影响发版**。
也就是说：改坏了 UI 仍然能发出一版。

**设计决策点（需要实施者选一个，别两个都不做）：**

- **方案 A｜本地侧查 API。** 在发版步骤前（`scripts/upload-oss.*` 或 release 脚本链）用
  `gh api` 查目标 commit 的 `ui-e2e` 结论，非 `success` 就拒绝上传。
  优点：改动小、fail closed、不碰 CI 结构。缺点：引入对 GitHub API 与网络的依赖。
- **方案 B｜CI 侧串联。** 把 `ui-e2e.yml` 的 job 抽成 `workflow_call` 可复用 workflow，
  发版 workflow 调用它并在失败时中止。
  优点：无本地网络依赖、与构建同源。缺点：要动 CI 结构，`ui-e2e.yml` 现在的三个 job 都要重构。

**推荐 A**——本仓 public、main 无分支保护，所以**不能**靠 GitHub required status checks 实现
门禁（那需要先在仓库设置里开分支保护）。A 用最小改动拿到 fail-closed。

**禁止。** 不要通过改 `ui-e2e.yml` 的触发条件（加 `paths-ignore`）来「让门禁更好过」——
本仓 public，CI 分钟免费，加忽略规则只会在将来开分支保护时把 docs-only PR 的 required check
永远卡在 pending。

**验收。** ① 故意改坏一个 E2E 断言，确认发版流程被拦住；② 恢复后确认流程通过；
③ `docs/release-gates.md` 有对应条目。三项都要留证据，不要只写「已加门禁」。

```
给 zmzai-lectern 加发版门禁：渲染层 E2E 未在目标 commit 上全绿时，发版必须失败关闭。

先读 docs/release-gates.md、.github/workflows/ui-e2e.yml 与 desktop-release-check.yml，
再读 docs/superpowers/specs/2026-09-18-lectern-follow-up-backlog.md 的第 1 节（含两个方案
与推荐）。

按推荐方案 A 实施：在发版链的上传步骤之前用 gh api 查目标 commit 的 ui-e2e 结论，
非 success 则拒绝继续；同时把这条写进 docs/release-gates.md 的 Local Checks 一节
（文档与代码都要，不要只写文档）。

约束：
- 不要改 ui-e2e.yml 的触发条件，不要加 paths-ignore。
- 不要依赖 GitHub required status checks。
- 门禁必须 fail closed：API 查询失败（网络/权限/查不到 run）时按「未通过」处理，
  而不是默认放行；错误信息里说清是「查不到」还是「查到了但失败」。

验收并留证据：① 改坏一个 E2E 断言 → 发版被拦住（贴出拦截输出）；
② 恢复 → 发版通过；③ release-gates.md 有对应条目。
```

---

## 2. 打包版「硬杀重启」任务恢复 E2E

**背景。** `e2e/packaged-smoke.mjs:137-141` 已经有重启检查，但那是 `desktop.close()` 的
**优雅关闭**——租约正常释放，根本走不到恢复路径。而 framework 侧的 `lease-recovery.test.ts`
覆盖的是租约语义（恢复 / `unsafe_replay`），没有接到真实的应用启动路径上。这是验收报告
§4(3) 里明确记下的缺口。

两者之间的缝正好是危险的地方：**应用被硬杀（断电、崩溃、任务管理器结束进程）时任务会怎样**，
目前没有任何端到端证据。

**做什么。** 在 packaged-smoke 里加一条：直接把「一条 running 状态的任务 + 未释放的租约」种进
SQLite，然后**硬杀**进程（不调 `desktop.close()`，直接 kill），重启应用，断言任务状态被正确
恢复，或明确落成 `blocked` / 需要 `unsafe_replay` 确认，并且界面文案与状态一致。

**不需要真模型调用。** `release-gates.md` 明确打包冒烟不依赖模型与账号，种数据即可——这也是
这条用例能进 CI 的前提。

**禁止。** 不要为了让它通过而放宽 `lease-recovery` 的语义，也不要动 framework 侧的租约常量与
`RESET_GUARDS_ON_RESUME`（验收报告 §1.2 标了它们是承重的）。

**验收。** 用例进 `pnpm test:packaged`（于是自动进 `desktop-release-check.yml` 的 Windows 与
macOS job），并且**故意破坏恢复逻辑时它会失败**——不能是一条永远绿的用例。

```
给 Lectern 打包版加一条「硬杀重启」的任务恢复 E2E。

先读 e2e/packaged-smoke.mjs（注意 137-141 行的重启检查是优雅关闭，走不到恢复路径）、
zmzai-framework 的 lease-recovery.test.ts，以及
docs/superpowers/specs/2026-09-17-lectern-continuous-task-execution-spec.verification.md
的 §4(3) 与 §1.2。

做什么：在 packaged-smoke 里种一条 running 状态的任务 + 未释放租约进 SQLite，硬杀进程
（不调 desktop.close()），重启应用，断言任务被正确恢复或明确落成 blocked/unsafe_replay，
且界面文案与任务状态一致。

约束：
- 不依赖真实模型调用或账号，种数据即可（release-gates.md 要求打包冒烟可离线跑）。
- 不要放宽 lease-recovery 的租约语义；不要动 framework 的租约常量与 RESET_GUARDS_ON_RESUME。
- 保持这条用例能进 CI 的 desktop-release-check.yml（macOS + 原生 Windows 两个 job）。

验收并留证据：① 用例通过并写进 test-results/；② 故意破坏恢复逻辑（例如让恢复跳过租约检查）
时用例必须失败——把这次失败也贴出来，证明它有牙；③ 在验收报告里补记这条覆盖。
```

---

## 3. `task_block` 调用率观察

**背景。** 验收报告 §4(1) 记下一条无法靠代码根除的限制：`waiting_input` / `waiting_external`
依赖模型**主动调用** `task_block` 工具。工具本身可用且可执行，但如果模型只是用文字说
「我缺一份凭据」而没调工具，系统仍按正常收尾自动续跑，三轮后落 `blocked(no_progress)`，
真实原因被替换掉。

**这条的补法不在代码里，先取数据。** 需要统计真实会话里：① `task_block` 实际被调用的次数；
② 文本里出现明确缺信息陈述、却没调用工具的次数。两者一比才知道问题有多大。

**根据数据再选方向：** 若调用率低，优先级次序应是「先改工具 description 的措辞」→「再把
『缺信息』的识别前移到 Completion Gate（例如连续两轮文本里出现明确的缺信息陈述时给一次
`waiting_input`）」→ 最后才考虑继续加提示词。**不要跳过数据直接改提示词。**

**验收。** 拿到一段时间的统计 + 一个明确判断（改 description 还是前移识别），以及改动前后的
对比。没有数据的「我觉得」不算。

> 数据源提示：Lectern 本地会话存储在 `LECTERN_DATA_DIR` 下的 SQLite；运维侧还有 relay 平台的
> 会话记录（此前用 `sre-cli` 按组织维度查过 `custom_agent` / `super_agent`）。选哪边取决于要
> 观察的是自有使用还是线上用户。

---

## 4. `MessageAttachmentCard` 组件级测试

**背景。** 消息里的附件卡有三条降级路径没有 DOM 级断言，目前靠代码审查 + framework 侧的 part
契约测试保障（验收报告 §3.3）。

**这不是「顺手补一个测试」。** 本仓 `pnpm test` 的 39 个文件**全在 Node 环境下跑纯逻辑**
（`lib/**/*.test.ts`），既没有 jsdom 也没有 `@testing-library/react`。加组件测试等于**先引入
一套前端测试基础设施**并改 vitest 配置——那是独立决策，不该夹在功能收尾里做。

这也正是渲染层的验收一直压在 E2E 上的原因，以及「E2E 必须进 CI」比往常更重要的原因。

**做之前先回答一个问题：** 引入 jsdom + testing-library 之后，是只写这三条降级路径，还是要
把整个 `components/` 逐步迁到组件测试？答案不同，配置方式不同（vitest 的 projects 分区 vs 全局
换环境）。**先定这个，再动手。**

---

## 5. 真机触摸屏拖拽

**背景。** 触摸路径已在 Chromium 的触摸事件路径上实测（`e2e/touch-drag-ui.mjs`，注入真实触摸
事件流），并做了反证：把 `.wb-splitter` 的 `touch-action: none` 运行时改回 `auto`，8 次触摸
移动只送达 2 次、`pointercancel` 触发、宽度只改 145px 就停住。用例已在 CI 跑绿。

**缺的是硬件。** 没有真机触摸屏，所以硬件驱动与系统级边缘手势不在覆盖范围内。**这一项不着急，
但在找到设备之前，任何地方都不要声称「已在触摸屏设备上验证」。**
