# K1 前置盘点：memory.zmzai.cloud（zmzai-memory / Tome）API 现状

- 日期：2026-09-21
- 性质：M0 交付物，只读盘点（源码 + 无凭据线上探测），非联调声明
- 输入规格：`2026-09-21-lectern-host-and-subagents-design.md` §13
- 结论速览：**服务在线、域名已迁（k. → memory.，308 跳转），可作 K1 目标；但 retain 幂等、expectedVersion、capabilities 端点缺失，最大架构级缺口是桌面端鉴权方案。** K1 排期以本报告为准，不基于乐观假设。

## 1. 服务框架与部署

- 框架：Next.js 15.5 App Router（`package.json:20`），端口 3015，Caddy 反代，GitHub Actions + pm2 部署。
- 记忆引擎是 hindsight（`@vectorize-io/hindsight-client` 0.9.2，loopback `127.0.0.1:8888`，`.env.example:11`）；zmzai-memory 是 UI + BFF 代理层（`README.md:15`）。
- 域名：README 写 `k.zmzai.cloud` 已过时；commit `e2afa2f`（2026-08-31）迁移到 `memory.zmzai.cloud`（`lib/origins.ts:8`）。
- 鉴权：仅 `muzhi_session` cookie（父域 .zmzai.cloud 共享，`lib/session.ts:38-60`），无 Bearer/API token。页面未登录跳 `auth.zmzai.cloud`；API 返回 401 JSON（`lib/api-auth.ts:13`）。
- 权限模型：bankId=workspaceId；view=owner∪成员，manage=owner/admin（`lib/route-helpers.ts:11-27`）。

## 2. 线上探测（无凭据 GET，2026-09-21）

| 路径 | 结果 |
| --- | --- |
| `GET /` | 200，重定向 `auth.zmzai.cloud/login?redirect=...`（登录门禁生效） |
| `GET /api/health` | 200 `{"ok":true,"deps":{}}`（唯一公开路由） |
| `GET /api/banks`、`/api/evals`、`/api/banks/x/{memories,operations/x,config}` | 401 `{"error":"UNAUTHENTICATED"}` |
| `GET /api/banks/x/recall` | 405（仅接受 POST） |
| `GET /login` | 404（登录入口在外域 auth） |

## 3. 对照规格 §13.2 契约表

| 规格契约 | 结论 | 差距 |
| --- | --- | --- |
| listBindings | 部分具备 | `GET /api/banks` 返回 `{banks:[{bankId,name,memoryCount,canDelete}]}`（`app/api/banks/route.ts:17-53`），语义等价 |
| capabilities | **缺失** | 无能力/版本发现端点；health 只回 ok |
| recall（query+scope+tokenBudget） | 部分具备 | `POST /api/banks/[bankId]/recall` 收 `{query, maxTokens}`，服务端钳制 ≤16384（`recall/route.ts:36-39`）；scope 即路径 bankId；参数名 maxTokens 非 tokenBudget |
| retain（idempotencyKey→operationId） | 部分具备 | `POST .../memories` 同步 retain（批量 ≤20 条/单条 ≤8000 字符）；**全仓无 idempotency**；SDK 有 `async` 标志但路由未暴露，不返回 operationId |
| revise（expectedVersion） | 部分具备 | `PATCH .../memories/[memoryId]` 可改 text/fact_type/entities/state/reason；**无 expectedVersion/If-Match，零命中** |
| invalidate | 部分具备 | 无专门端点，靠 PATCH `state` 软删 |
| operationStatus | 已具备 | `GET .../operations/[opId]`（透传 hindsight）；但操作对象是后台任务，同步 retain 不产生 operationId |
| 错误码版本化 | 部分具备 | 有稳定码（UNAUTHENTICATED/FORBIDDEN/VALIDATION/CONFLICT/UPSTREAM_ERROR），未版本化、无 schema 文档 |

四项重点：**retain 幂等=缺失；operationStatus=已具备（retain 不走它）；expectedVersion=缺失；tokenBudget=部分具备（maxTokens 硬上限 16384）。** 契约测试：无（`tests/` 仅 3 个单元测试，无 API 契约测试）。

另注意：recall 是 POST 语义、bank 作用域在路径而非请求体——规格 §13.2 若按 GET+body 理解需对齐实际形状。

## 4. K1 排期风险（缺口按工作量排序）

必须先做（阻塞桌面端）：

1. **桌面端鉴权方案（大，架构级，需先决策）**：现仅浏览器 cookie。Lectern 需 PAT token、OAuth/device flow，或退化为嵌 webview 复用 cookie。
2. `GET /api/capabilities`（小）：新增特性矩阵端点，客户端免硬编码。
3. retain idempotencyKey（中）：可在 zmzai 层做 Mongo 去重表（key→结果缓存），不动 hindsight。
4. async retain + operationId 透传（小-中）：SDK 已支持 `async:true`，路由透传即闭环 retain→轮询。

可后置：

5. expectedVersion 乐观锁（中-大）：hindsight 未见版本字段，需影子版本表或升级上游。
6. tokenBudget 命名对齐（小）：路由层加 alias。
7. 契约测试补齐（中）：vitest 已就位，补路由级测试 + 错误码快照。
