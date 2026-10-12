# K1 设计：Lectern × memory.zmzai.cloud 记忆集成

- 日期：2026-10-12
- 输入：spec §13（`2026-09-21-lectern-host-and-subagents-design.md`）、closure plan T17–T19（`2026-09-28-production-chain-closure-plan.md`）、K1 盘点（`2026-09-21-k1-memory-api-inventory.md`）
- 状态：设计定稿（用户逐节确认，含两轮修订：PAT 自动接通、项目自动建库），待实施切片
- 范围：T17+T18+T19 全量；T20 评测后置（既有拍板不变）

## 1. 已拍板决策

| # | 决策点 | 结论 |
| --- | --- | --- |
| D5 | 桌面端鉴权 | PAT 一步到位：zmzai-memory 自建 `zmk_` token，Bearer 与 cookie 并行；**接通全自动**（登录即签发，无手动连接动作） |
| 范围 | 本轮切片 | T17+T18+T19 全量，T20 后置 |
| 接入形态 | framework 改动 | **零改动**：`memoryContextFor` 钩子经 createAgentRuntime runnerOptions 注入，vendored 0.17.2 已可用（createServer 转发修复在 0.17.3，Lectern 不走该路径，勿为此升 vendor）+ Lectern 侧 memory-service |
| 落库 | binding/outbox 位置 | 每项目 `projects/<id>/zmzai.db` 新表；outbox 消费跟随 runtime 进程（armed=Host，否则 Next） |
| 提炼 | 候选产生时机 | task_delivered 后异步小模型提炼；manual 待审为默认档 |
| bank | 绑定策略 | **项目维度自动建库**（`lec_` 幂等前缀、懒创建）；绑已有=高级路径（含 agent `ws_` bank 跨端共享） |

### 1.1 spec 偏差记录（对 2026-09-21 spec §13 的显式修订）

1. **自动建库**：spec「禁止客户端猜测 bankId 自动建库」→ 本设计改为确定性幂等 bankId（`lec_` + sha256(projectId) 截断）+ 懒创建（首个根目标才建）+ 用户可换绑、网页管理台可见可撤销。理由：该红线在 PAT 缺失前提下防的是垃圾库；幂等 + 懒创建 + 可见性满足同一目的，零摩擦产品形态优先。
2. **401 自动重连**：spec「401 暂停该账号同步并等待重新登录」→ 保留暂停语义，增加自动重签自愈（cookie 有效时无感恢复；连续失败才显示需重登）。
3. 召回预算（800ms/12 条/2000 token）、候选父验证、outbox 语义、tombstone、来源展示等其余条目**严格遵循 spec §13.2–13.4**。

## 2. 总体架构

### 2.1 改动面

| 仓 | 改动 |
| --- | --- |
| zmzai-memory | PAT（模型/端点/管理页/Bearer 鉴权）、`GET /api/capabilities`、retain 幂等、async+operationId、expectedVersion 影子版本、bank 创建端点与 `lec_` 前缀规则、bank 来源标识、契约测试 |
| zmzai-lectern | 项目库新表 ×4、`lib/memory/`（client/recall-cache/候选管线/outbox）、`memoryContextFor` 两形态接线、PAT 自动接通（Next 侧）、UI（设置状态/项目记忆节/会话记忆行）、per-project 路由 |
| zmzai-framework | 零改动 |

### 2.2 召回链（读）

```
runner ContextBuilder（每 attempt 调 memoryContextFor）
  → Host/lib memory-service.recallSection(session, text)
    → 根目标级缓存命中 → 返回背景块
    → 未命中 → PAT Bearer POST /api/banks/:bankId/recall（deadline 800ms）
      → 命中事实（≤12 条、≤2000 估算 token）→ 格式化背景块 + 落 recall_log
  → 未绑定 / 无 PAT / 超时 / 401 / 403 → undefined（任务无记忆照常运行）
```

- 背景块以 user message 注入历史头部（framework 现行为，`context-builder.ts` buildAttemptContext），带固定声明「项目记忆，来源 memory.zmzai.cloud，可能过期需核对」+ 逐条 memoryId。
- **根目标级缓存**：`memoryContextFor` 每个 attempt 都会被调（钩子语义如此），Lectern 实现内部按 `sessionId + 根目标摘要` 缓存命中结果（内存 LRU）；内部续跑/重试复用，rewind 或新根目标才重召。失效/撤销（state≠active）事实不注入。

### 2.3 写入链（写）

```
task_delivered（交付回执落地后，异步 fire-and-forget）
  → 候选提炼（flash 级小模型；输入=项目库会话尾部交付说明+验证结论，不依赖 Next 侧 deliveries.db）
    → ≤5 条结构化候选：statement + kind(convention|command|decision|pitfall) + evidence{files, commit, taskRevision} + scope(project|branch)
  → syncPolicy 门控：off=丢弃；manual=进待审表；auto=直接入 outbox
  → outbox（项目库，幂等键=sha256(bindingVersion + 内容 digest + 来源 revision)）
    → PAT POST retain（idempotencyKey 同键）→ async 返回 operationId → 轮询 operationStatus
  → succeeded / failed（3 次指数退避后保留供手动重试）/ unknown（只查不盲重发）
```

- 纯问答型任务（无交付证据）跳过提炼；syncPolicy=off 时不发起模型调用。
- 子代理结论不直接入长期记忆：候选提炼以父会话为源（父验证语义），子代理分支结论仅当被父交付引用时才可能进入候选。

### 2.4 PAT 自动接通（零点击）

- **触发点（Next 侧，全部后台静默）**：登录成功事件、应用壳启动检查、记忆状态=未连接时的下一次请求。
- **动作**：Next 用请求内 muzhi_session cookie 调 `POST /api/tokens`（name=`lectern-<设备短标识>`，本机持久随机 id，多设备互不顶号）→ 明文一次返回 → 加密落盘（与 relay key 同款保存机制，独立字段）。
- **服务端 upsert-by-name**：同名签发自动撤销该设备旧 token，反复重签不堆积。
- **分工**：cookie 只在 Next 的接通动作里出现；Host 全程只见 PAT（文件惰性现读，verifier.cjs 同款——设置换 token 即时生效，不受启动 env 快照限制）。
- **失效自愈**：Host 侧 PAT 调用 401 → 报告未连接 → Next 下个触发点自动重签（cookie 有效则无感恢复；cookie 亦失效则状态显示「需重新登录」）。
- 登录即签发意味着可能存在休眠 token（用户从未用记忆）——可接受：用户级权限、网页可见可吊销。

### 2.5 项目自动建库（default-on）

- 项目跑**第一个根目标**时，若该项目无 binding → 后台自动创建专属 bank 并绑定 → 召回立即可用，用户无感知。
- **幂等确定性 bankId**：`lec_` + sha256(projectId) 截断（长度实施时定，服务端校验前缀与字符集）。重复触发、删绑重开都落在同一 bank。
- **懒创建**：项目从未跑任务不建库；bank 名=项目名（网页管理台可直接辨认）。
- **默认 syncPolicy=manual**：读零门槛，写要过审；项目设置一键切 auto。
- **换绑（高级路径）**：项目设置可改绑任意有权 bank（含 agent `ws_` bank，跨端共享）；换绑后旧 auto 库云端保留不动；旧待上传记录标 orphaned 不发新 bank。
- **跨设备边界**：Lectern projectId 是本机随机 id，两台机器的「同一项目」各建各的 bank；跨设备共享需手动换绑到同一 bank（如实告知，不做云项目身份对齐）。

## 3. 服务端设计（zmzai-memory，T18）

### 3.1 PAT

- `TokenModel`：`{ name, prefix, tokenHash(sha256), userId, scopes:["memory"], status, lastUsedAt, createdAt }`；token=`zmk_`+32B 随机，明文仅签发响应返回一次。
- 鉴权收口：`requireApiUser()` 扩 Bearer 分支——`Authorization: Bearer zmk_…` → sha256 查库 → 复用现有 `CurrentUser` 路径；未命中/撤销返回同码 `UNAUTHENTICATED`（401）。`lastUsedAt` 节流更新（如 ≥5 分钟才写）。cookie 分支保持不变，两路并行。
- `app/api/tokens`：`GET`（列表：name/prefix 掩码/status/lastUsedAt）、`POST`（签发，body `{name}`，**upsert-by-name**：签发即撤销同 userId 同名旧 token）、`DELETE`（按 id，仅 owner）。cookie 或已有 PAT 均可鉴权。
- 网页管理页：memory.zmzai.cloud 新增 tokens 管理页（@zmzai/theme 组件），展示/吊销。

### 3.2 capabilities

`GET /api/capabilities`（登录或 PAT）：版本化能力矩阵 `{ protocolVersion, retain: { idempotency, async }, revise: { expectedVersion }, recall: { maxTokensCap: 16384, param: "maxTokens" }, bankIdPrefixes: ["ws_", "lec_"] }`。客户端免硬编码，后续能力演进靠版本协商。

### 3.3 retain 可靠写契约

- **幂等**：`POST /api/banks/[bankId]/memories` 增加 `idempotencyKey` 字段 → Mongo 去重表（key→首次响应快照），同键重放返回原结果（含原错误），**不动 hindsight**。
- **async + operationId**：请求 `async:true` 时 SDK 透传，响应带 `operationId`；`GET .../operations/[opId]` 已有（盘点确认），补通 retain→轮询闭环。同步 retain（现状）继续支持。
- **expectedVersion**：`PATCH /api/banks/[bankId]/memories/[memoryId]` 增加可选 `expectedVersion`（整型）→ Mongo 影子版本表（memoryId→version，缺省视为 1）；不匹配返回 `409 CONFLICT`（携带当前版本）；成功自增。
- **invalidate**：PATCH `state` 软删已有；补 `reason` 必填 + 审计记录（who/when/why 落 Mongo）。
- 权限：写/纠错沿用 `canDeleteBank`（owner/admin）；成员只读——成员读权限不自动变写权限（spec 红线）。

### 3.4 bank 创建端点

- `POST /api/banks`：body `{ bankId?, name }`；带 `bankId` 时校验 `lec_` 前缀与字符集（幂等 create-or-update 语义，hindsight createBank 已天然幂等）；不带则服务端生成（网页手建路径）。
- bank 列表（`GET /api/banks`）对 `ws_`/`lec_` 前缀打来源标记（agent-link.ts 扩展：`lec_` → Lectern 项目，展示名即 bank name）。

### 3.5 契约测试

- vitest 路由级：PAT 签发/Bearer 鉴权/撤销/cookie 并行、upsert-by-name、capabilities 快照、幂等重放（成功与失败两种首结果）、async operationId 闭环、expectedVersion 409/成功、tombstone+审计、bankId 前缀校验、越权（成员写→403）。
- 错误码族快照：`UNAUTHENTICATED / FORBIDDEN / VALIDATION / CONFLICT / UPSTREAM_ERROR`。
- 部署纪律（closure plan T18 原文）：部署前提供 migration/回滚说明与原始结果，**未经授权不部署**（HK GitHub Actions + pm2 管线）。

## 4. Lectern 设计（T17+T19）

### 4.1 数据模型（项目库 `projects/<id>/zmzai.db` 新表 ×4）

- `memory_bindings`：`projectId, origin, bankId, bankName, accountUserId, bindingVersion, enabled, syncPolicy(off|manual|auto), source(auto|manual), permission, lastRecallAt, createdAt`。每项目一行。
- `memory_outbox`：`id, projectId, bindingVersion, idempotencyKey, payload(content/context/tags), state(pending|sending|accepted|succeeded|failed|unknown|orphaned), attempts, lastError, operationId, createdAt, updatedAt`。
- `memory_candidates`：`id, projectId, statement, kind, evidence(json), scope, status(pending|approved|discarded), createdAt`（manual 待审队列）。
- `memory_recall_log`：`id, projectId, sessionId, goalDigest, hitCount, hits(json), usedTokens, at`（会话记忆行与「最近召回」UI 的数据源；不经事件流）。

多进程约定：两进程（Host/Next）开同一 sqlite，WAL + busy_timeout；outbox 消费跟随 runtime 进程（armed=Host，否则 Next），双发由服务端幂等键兜住。

### 4.2 memory-service（`lectern/lib/memory/`，Host bundle 连带编译，R-1 先例）

- `MemoryClient`：fetch + Bearer PAT；recall（默认 800ms deadline）/ retain（5s）/ operations / capabilities / createBank；AbortController 超时，超时或失败静默降级（agent provider 的 withTimeout 哲学）。
- recall-cache：内存 LRU，key=`sessionId+goalDigest`。
- candidate-pipeline：task_delivered 挂点 → 提炼调用（模型可配，默认 flash 级）→ syncPolicy 门控 → candidates/outbox。
- outbox 状态机：pending→sending→accepted→succeeded；网络失败同键指数退避 3 次→failed（手动重试）；提交后不明→unknown（只查 operationStatus，不盲重发）；Host/Next 启动时恢复扫描（pending/sending 悬置记录重对账）。

### 4.3 接线

- Host 装配（real-runtime）与 Next 进程内 runtime **两形态**都注入 `memoryContextFor = (session, text) => memoryService.recallSection(session, text)`。
- 未绑定项目首根目标触发自动建库+绑定（§2.5）；PAT 缺失时先走接通状态检查，不为建库阻塞任务。建库失败无需专门重试机制——懒创建下失败不落 binding，下个根目标自然重触发，幂等 bankId 保证重试安全。

### 4.4 PAT 存取

- Next 写（接通动作产出）、Host 惰性现读同一落盘文件（加密）；文件读取失败/不存在=未连接，全链降级为无记忆。

## 5. UI / 产品面

- **全局设置「记忆」分区**（与 relay key 并列）：纯状态展示（已连接：账号/设备名/lastUsedAt；未连接：提示登录）+「撤销本设备 token」；**无连接按钮**（自动接通）。
- **项目设置「记忆」节**：当前绑定（auto 建库的 bank/换绑的目标）、bank 选择器（有权列表，`ws_` 带 Agent 来源标记、`lec_` 带 Lectern 标记）、换绑（区分解除绑定 vs 服务端删除——删 bank 跳网页管理台）、syncPolicy 三档、最近召回（recall_log）、待审候选列表（manual：编辑/采纳/丢弃）、outbox 状态（failed 可重试、orphaned 可清理）。
- **会话流记忆行**：注入了记忆的任务显示一条轻量行（命中条数+来源 bank，点击展开逐条 memoryId/score）——按 ZCode 式会话流弱化过程行风格；「本次未使用记忆（凭据失效/超时）」如实显示，不静默。
- 组件全部 @zmzai/theme；洋红只用于行动、红色只用于破坏性确认。

## 6. 错误处理与降级

| 场景 | 行为 |
| --- | --- |
| 401（PAT 失效/撤销） | 暂停 outbox 与 recall；Next 自动重签自愈一次，连续失败→设置页「需重新登录」；任务继续无记忆运行，会话如实标注 |
| 403（权限撤销/降级） | 清空召回缓存、binding 标记 revoked、阻断读写；任务继续 |
| recall 超时（>800ms） | 无记忆继续，不重试不阻塞 |
| outbox 网络失败 | 同幂等键指数退避 3 次→failed 保留手动重试 |
| retain 提交后不明 | unknown：只查 operationStatus 等对账，不盲重发 |
| 纠错 409 | 重读最新版本，UI 提示重新编辑 |
| 退出登录/换账号 | 清内存召回缓存与凭据、暂停 outbox；outbox 记录锁定账号+bindingVersion，原账号重授权才续传 |
| 重绑新 bank | 旧待上传记录标 orphaned 不发新 bank，供用户清理 |
| 服务端不可达 | 任务照常（旁路）；状态可见 |
| dev/兜底模式 | Next 进程内同样装配（落库决策 A：binding 在项目库，两进程皆可达） |

## 7. 测试与验收

### 7.1 映射

- **PC20**（真实域名鉴权/越权/超时/退出登录/重新绑定，召回范围与缓存正确）→ §4 全部 + §6 场景在真实域名联调。
- **PC21**（retain 重试/上游 unknown/纠错版本冲突/权限撤销，可靠回执与作用域不乱）→ §3.3/§3.5 服务端契约 + §4.2 outbox 联调。

### 7.2 Lectern 侧测试

- 单测：memory-service（缓存 key/超时降级/outbox 状态机/幂等键构造/binding 解析/自动建库幂等）、候选管线（mock 模型、syncPolicy 门控、manual 待审）。
- 装配测试：memoryContextFor 两形态（armed Host + 进程内）。
- 路由测试：binding CRUD、候选/outbox 状态端点。
- **测试总数只增不减**（既有硬门禁）。

### 7.3 真实联调（spec 红线：无凭据不宣称接通）

- 授权测试 bank（不触碰真实项目 bank，测试对象显式清理）。
- 本地全链：本地 zmzai-memory + ssh 隧道 8888 hindsight（个人工作空间联调法）。
- 必验项：PAT 端到端（cookie→token→Bearer recall）、**agent 写入的 bank 由 Lectern 召回（跨端共享）**、自动建库幂等、outbox 重试与 unknown 对账、401 撤销→自动重签、退出登录暂停。

### 7.4 版本与发版

- K1 占独立 minor：**0.14.0**（当前 0.13.0）。
- 发版链沿用既有 gates：typecheck 0 / arch 0 / 全量测试 / packaged-smoke 增记忆链路项。

## 8. 实施切片建议（对齐 closure plan）

| 切片 | 内容 | 对应 |
| --- | --- | --- |
| T17a | 服务端 PAT + capabilities + Bearer 鉴权 + **bank 创建端点（`lec_` 前缀规则）** + 契约测试 | T17/T18 部分 |
| T17b | Lectern：项目库四表 + memory-service 骨架 + PAT 自动接通 + 自动建库/绑定 | T17 |
| T17c | 召回接线：memoryContextFor 两形态 + 缓存 + recall_log + 会话记忆行 | T17 → PC20 只读面 |
| T18b | 服务端写契约：幂等/async/operationId/expectedVersion/tombstone | T18 → PC21 |
| T19a | 候选管线 + 待审 | T19 |
| T19b | outbox 状态机 + 恢复 + unknown 对账 | T19 |
| T19c | UI 收口（项目设置记忆节/待审/outbox）+ 真实联调 + 0.14.0 发版验收 | T19 收口 |

依赖：T17a 可先行；T17b/c 依赖 T17a；T18b 可与 T17b/c 并行；T19* 依赖 T18b。

## 9. 非目标（本轮不做）

- `memory_search` 主动查询工具（候选后续项）。
- 离线持久召回缓存（spec 明示首期不做）。
- expectedVersion 之外的 hindsight 上游版本机制升级。
- 跨设备自动 bank 对齐（云项目身份）。
- Lectern 内删 bank（跳网页管理台）。
- T20 评测（后置既有拍板）。
