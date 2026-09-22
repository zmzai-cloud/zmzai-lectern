# M2a 设计：最小 Host 链路（发送 → Host → 工具 → 持久化 → Next 重启 → 页面恢复）

- 日期：2026-09-22；状态：**S9–S12 全部实施完成**（见 §7 实施结果）
- 对应规格：§3（单一 Host 渐进抽离）、§5.1（启动/握手/token）、§6（命令/事件协议子集）、§17 M2a 行
- 前置：M1 已收口（framework 0.10.0，lectern 484/484）；runnerFor 装配在 `lib/runtime.ts:200`
- 硬约束（§17）：**独立 fixture 数据目录**，不允许未迁移路由与 Host 对同一生产数据双写；dev 拓扑先行，Electron/生产拓扑归 M2c

## 7. 实施结果（2026-09-22）

| Slice | 提交 | 结果 |
| --- | --- | --- |
| S9 Host 骨架 | `f582007` | 随机端口/token/401 零副作用；进程实测 token 零泄漏 |
| S10 fixture 链路 + 端点 | `f939939` | 491/491；session/prompt/SSE 三端点 |
| S11 Next 代理 + smoke | `c05b29e` | dev 模式 A01–A04/A24 **6/6** |
| S12 standalone + 性能 + 长连接 | `65d98a6` + 本笔 | start 模式 **6/6**；receipt p95=15.7ms（门槛 300）；SSE 60s/540 帧无缺口 |

放行条件核对：A01–A04、A24 在 fixture 内通过（双模式）；性能门槛基线留档
`evals/results/m2a-receipt-perf-baseline.json`（p50 7.8 / p95 15.7 / max 36.3ms）；
SSE 长连接双模式验证（含跨 Next 重启的 27 帧连续重放）。

实施踩坑（已进 commit message）：
1. 自定义工具必须与 `builtinTools` **并存**——替换默认表会让 task_deliver 缺席，
   交付门禁打回续跑直到 no_progress 阻塞；
2. pnpm 包装进程必须**整进程组** kill，否则 next dev 孤儿化并占用端口污染
   后续测试（A02 场景尤其）；
3. 本机 `next build` 需 6144MB 堆（沿用 7ec0ec9 结论，裸 4096 会 OOM）。

遗留（M2b 处理）：m2a 实验路由与生产路由并存期间 UI 不接 m2a 通道；
credentialRef/Origin 完整规则随路由族迁移。

## 1. M2a 拓扑（dev）

```
scripts/dev-host.sh ──spawn──> node host/dist/index.js（Host，长驻）
    env: LECTERN_HOST_DATA=<fixture 数据目录>
    Host: 127.0.0.1:0 随机端口 → 写 <data>/host.json{port, hostInstanceId, token, protocolVersion}（600）
Next（dev / standalone）
    实验路由 app/api/m2a/* 读 LECTERN_HOST_BOOTSTRAP=<host.json 路径>（受控通道）
    代理 POST prompt / GET events(SSE) → Host（Bearer token）
浏览器/测试脚本 ──> Next m2a 路由 ──> Host ──> framework runtimeFor(fixture 项目)
```

关键决策：

- **Host 是 Lectern 仓的新顶层 `host/` 包**（独立 tsc 构建，`host/dist/index.js`；Node ≥22，node:http 零框架零新依赖）。它 import `lib/runtime.ts` 等纯 Node 模块，**禁止** import `app/**`、`lib/request-cookie.ts`（ALS 留在 Next 侧，M2b 改造）。
- **token 走文件通道**（M2a dev）：高熵 32B hex 写 fixture 数据目录的 `host.json`，Next 经 env 指定的路径读取。进程通道/env 直传是 M2c（Electron Main fork Host）的事。token 不进日志、不进 URL。
- **credentialRef 豁免到 M2b**：M2a 的被测对象是进程边界与恢复语义，不是用户鉴权——fixture 目录 + 本机 token 即边界。§5.3 的 cookie→credentialRef 随 M2b 路由迁移做。
- **不改任何现有生产路由**：UI 对话仍走旧进程内 Runtime；M2a 用 `app/api/m2a/*` 实验路由，验证后 M2b 才开始逐族迁移。

## 2. 最小协议（M2a 仅三端点，全部需 Bearer token）

| 端点 | 行为 |
| --- | --- |
| `GET /health` | 200 `{protocolVersion:"1", hostInstanceId, schemaVersion, capabilities:{commands:["prompt"],events:true}, uptimeMs}`；无/错 token → 401，且**不产生任何副作用**（A24 探针：fixture 文件不变） |
| `POST /v1/commands/prompt` | body=`{sessionId, requestId?, text, ...PromptInput 子集}`；直接调 `runner.prompt`（幂等/409 由 framework requestId 承担）；返回 receipt。响应丢失后客户端以同 requestId 重试 → A03 |
| `GET /v1/events?sessionId&since` | SSE（text/event-stream）：先 `eventLog.read(since)` 重放，再订阅 live；每帧 `id: <seq>`。断开重连以 `Last-Event-ID`/`since` 续传 → A01 |

Origin 头校验（§5.1）M2a 仅实现骨架（同 Host token + loopback 判定），完整规则随 M2b 固定端口策略落地。

## 3. fixture 工具链

`scripts/m2a-fixture.mjs`：一键准备隔离环境——

1. `mkdtemp` 项目工作区（含一个可写文件与 git init）+ 独立数据目录；
2. 向数据目录的 projects 注册表登记该 fixture 项目（复用 `lib/projects.ts` 的注册格式，不碰生产 projects.json）；
3. 产出 `m2a-env.json`（两个路径 + 断言用的探针文件路径），供 smoke 脚本与 dev-host.sh 消费。

Host 启动时只装配**这一个** fixture 项目的 runtime（M2a 不做多项目/归属索引——那是 M2b 路由迁移的内容）。

## 4. Slice 计划（每步后 lectern vitest 全绿 + host 单测）

| # | 内容 | 验收 |
| --- | --- | --- |
| S9 | Host 骨架：`host/`（index/server/protocol 三文件 + tsc 构建 + `pnpm host:build`/`host:dev` 脚本）；随机端口、token 生成与 `host.json` 握手文件、/health、无 token 401 | host 单测：握手形状、错 token 拒绝、无副作用 |
| S10 | fixture 工具链 + `POST /v1/commands/prompt`（runner 装配进 Host，scripted provider 可用 mock 模型跑真工具）+ `GET /v1/events`（since 重放 + live） | host 集成测：prompt→工具落盘→SSE 收到事件；A03/A04 在 host 层通过 |
| S11 | Next 实验路由 `app/api/m2a/{prompt,events}`（代理 + SSE 流转发）+ `e2e/m2a-smoke.mjs`：A01（断线重连去重）、A02（**kill next 进程重启，Host PID 不变**，工具探针完成、页面恢复）、A24 | smoke 全绿（dev 模式） |
| S12 | standalone 模式（`next build && next start`）跑同一 smoke；性能基线首测（mock 命令 durable receipt p95 ≤300ms，样本 ≥100，留档 `evals/results/`——注：性能门槛不依赖 E 阶段 harness，针对性脚本即可）；设计文档补实施结果 | A01–A04、A24 fixture 内通过；性能数据落档 |

## 5. SSE 长连接（M2a 的显式验证项）

两模式各跑一次长连接（≥5 分钟）观察：无静默断流、无事件缺口、慢消费不撑爆 Host 内存（M2a 用有界缓冲 256 帧上限，超限断开要求重同步——骨架实现，完整 §6.4 投影幂等归 M2b）。结果写实施结果章节。

## 6. 风险

- R-1 `lib/runtime.ts` 可能隐含 Next 语境（MCP/终端管理器挂 globalThis）——host tsc 编译时即暴露；若有耦合，M2a 允许在 host 内做薄适配层而不改 lib（改动归 M2b）。
- R-2 Next 代理 SSE 的背压（dev 与 standalone 行为差异）——S12 显式覆盖。
- R-3 scripted provider 跑「真工具+mock 模型」：framework 的 faux harness 在 runner.test 有先例，Host 集成测复用其 streamFn 形状；真模型不在 M2a 范围。
- R-4 双写红线：m2a 路由与旧路由**物理隔离**（不同 sessionId 前缀 + fixture 数据目录），review 时用一条断言钉住「Host 数据目录 ≠ 生产数据目录」。
