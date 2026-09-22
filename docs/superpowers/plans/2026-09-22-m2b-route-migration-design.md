# M2b 设计：路由族分批迁移到 Host

- 日期：2026-09-22；状态：**B1–B4 全部实施完成，路由迁移主体收官**（见 §6）
- 对应规格：§5.4（路由迁移清单）、§5.3（credentialRef）、§6（命令/事件协议）、§17 M2b 行
- 前置：M2a 收口（S9–S12 全绿）；spec M2 纪律——**批次在隔离验证环境跑，未全部迁完不切生产入口**（双写红线）

## 1. 总体决策

### 1.1 Host 装配真实 runtime（不再是 M2a fixture）

`host/src/runtime.ts` 之外新增 `host/src/assembly.ts`：把 `lib/runtime.ts` 的
`runtimeFor/projectRuntime` 装配搬进 Host 进程——含 projects 注册表、设置读取
（模型端点/密钥）、MCP 懒启动、终端管理器、租约恢复。**lib/ 代码不搬不改**
（S6 设计已验证 host 可直接 import lib 的纯 Node 模块）；Next 侧对应能力随
批次下线。

### 1.2 网关模式：`app/api/[...slug]/route.ts` 反代 + 路由表

M2a 的 m2a 专用路由泛化为 **`lib/host-gateway.ts`**：一张静态路由表
（`method + path 模式 → Host 端点`），未命中表的路径走原有 Next 处理器
（生产 UI 在 M2c 前不受影响）。迁移即"路由从旧 handler 删除条目、在表中加
条目"——diff 可 review，回滚 = 删表条目。

### 1.3 credentialRef：随批次渐进

- **批次 1（只读查询）**：模型调用不发生，cookie 不需要进 Host——网关只带
  Host token；
- **批次 2+（写命令/会话创建）**：Next 在网关提取 `muzhi_session` cookie 的
  **单一值**作为 `x-lectern-credential` 头转发（不转发全部 cookie，§5.3）；
  Host 存内存 credentialRef 表（sessionId → cookie），runner 的 streamFn 装配
  从表取。凭据不落日志/不进事件。

### 1.4 双写红线（M2 期间）

批次验证全部跑 fixture 数据目录（复用 M2a 的 `m2a-fixture` 机制，项目指向
fixture workspace）；生产数据只在 M2c 单一切换时被 Host 接管。生产 UI 的旧
路由在 M2c 前保持现状（§17 M2 纪律）。

## 2. 批次计划（B1–B4，每批一个 slice 提交）

| 批 | 路由（14 个 runtime 依赖路由的子集） | Host 端点 | 验收 |
| --- | --- | --- | --- |
| B1 只读查询族 | sessions 列表/搜索、[id]/messages、[id]/events、[id]/search、[id]/read-state、[id]/usage | GET /v1/sessions、/v1/sessions/:id/messages、/v1/events（已有）、… | A07（快照+订阅无缺口）、A09（切项目/缺失挂载不串库）、既有 vitest 回归 |
| B2 会话命令族 | POST sessions（创建）、[id]/prompt、[id]/abort、[id]/permission、[id]/task | /v1/commands/*（prompt 已有雏形） | A03/A04/A05/A06/A27；credentialRef 生效（模型经 cookie 走 relay） |
| B3 状态操作族 | [id]/compact、[id]/rewind、[id]/read-state 写、[id]/worktree 查询 | /v1/commands/compact、/v1/commands/rewind… | A08（无效游标显式重同步） |
| B4 终端/MCP/附件族 | terminal 6 路由、mcp、attachments 全族（含上传下载流式） | /v1/terminal/*、/v1/mcp、/v1/attachments/* | A22（附件状态可恢复） |

fs/git/repomap/projects/settings/models/agents 8 族不依赖 runtimeFor
（自开 SQLite/走设置）——归 B5 或 M2c 统一收口（实施时按依赖图微调，迁移表
逐路由闭环是硬约束）。

## 3. Host 端点契约（B1 形状）

```
GET /v1/sessions?projectId=…            → 会话列表（store.listSessions + 任务投影）
GET /v1/sessions/:id/messages?before…   → 消息分页（store.getMessageSnapshot）
GET /v1/sessions/:id/search?q=…         → searchMessages
GET /v1/sessions/:id/read-state         → getReadState
GET /v1/sessions/:id/usage              → usage 聚合
GET /v1/events?sessionId&since          → SSE（已有）
POST /v1/commands/session               → createSession（已有）
```

错误映射沿用 m2a：REQUEST_ID_REUSED→409、SESSION_NOT_FOUND→404 等
（§6.3 的 `{code,message,retryable,requestId,details}` 完整形状在 B2 引入）。

## 4. 测试与验收策略

- Host 侧：每批 vitest 集成（fixture 目录 + faux/真实装配双模式）；
- 网关侧：smoke 扩展 `e2e/host-gateway-smoke.mjs`——B1 后断言「旧路由 handler
  不再 import sessionRuntime/runtimeFor」（架构检查脚本 grep 断言，spec §5.4
  验收后禁令的可执行形态）；
- A 用例映射：A07/A09 → B1；A03/A04/A05/A06/A27 → B2；A08 → B3；A22 → B4。

## 5. 风险

- R-1【✅ 已解决，2026-09-22】spike→codemod→装配加载全链路完成：
  lib 186 处相对导入补 `.js`（含 2 处目录导入→`/index.js`）、3 处 `@/lib`
  别名改相对（emit 后的 JS 才能被 Node 解析）；host 构建改 bundler 解析
  （emit 仍带后缀）+ DOM lib + dist 自挂 `type:module`。**实测**：
  `host/dist/host/src/assembly.js` 在 Node 进程加载成功（runtimeFor/
  sessionRuntime/listProjects/dataDirFor/resolveSessionOwner 全导出），
  M2a smoke 6/6 + perf 基线复跑通过。globalThis/设置读取的真实拉起验证
  随 B1 第一批端点实施。
- R-2 事件/快照协议 B1 即需版本化 envelope（§6.4）——最小实现：帧加
  protocolVersion 字段，不动既有形状；
- R-3 附件/终端是流式+长连接大户，B4 单独一轮做，不与 B1–B3 混排。


## 6. 实施结果（2026-09-22）

| 批 | 提交 | 结果 |
| --- | --- | --- |
| R-1 前置 | `8d1e844` | lib 186 处导入补 .js + 3 处别名改相对；host 连带编译真实装配（bundler 解析 + dist type:module） |
| B1 只读族 | `32cbda6`/`2891025` | 五端点经真实 runtimeFor；网关路由表 + /api/sessions 接线；进程级双验证 |
| B2 命令族 | `aa16098`/`fcc938a`/`305b1d0`/`b8565ac` | prompt/abort/permission/task 四命令端点 + 网关 POST（rewriteBody + cookie 单值提取）；credentialRef 全链（内存表→streamFnFor→ALS 回退优先级）；495/495 |
| B3 状态操作 | `42b227e`/`b7886a2` | compact/read-state 端点；SSE 水位 409 CURSOR_STALE（A08）；rewind 复合流抽 lib/rewind-flow（守卫→截断→事件→重发→重绑）双端共用；496/496 |
| B4 附件/终端/mcp | `4b76809`/`93b0713`/`9c62a7f` | 附件三端点（字节流直通+安全头白名单）；terminal 七端点（PTY）；mcp 状态/rescan；worktree 查询；gateway-check 十一项全过 |

实测与验证：real-check（五只读端点）、gateway-check（五项：列表/隔离/prompt
带 cookie/abort/task）、M2a smoke 双模式 6/6、credential 优先级 2 单测、
进程级 token/credential 零泄漏。

实施踩坑（commit 可溯）：
1. 自定义工具必须与 builtinTools 并存（S10）；
2. pnpm 包装进程必须整进程组 kill（孤儿 next dev 占端口）；
3. 行号删除误吞 modelProvider——装配静默降级，被进程级脚本当场抓获；
4. 网关检查须插到目标 method 的 handler（task 路由 GET 有 POST 漏）。

遗留（按设计有意留旧面，非遗漏）：worktree 写操作（merge/discard，spec §10
归 W1 重做）；multipart 上传适配（UI 通路，随 M2c）；terminal/stream（UI
现用轮询读，迁移收益低，随 M2c 评估）。relay 真实凭据的 credential 端到端
联调待有凭据环境。

B4 排障记录（commit 可溯）：gateway 检查曾被误插进 JSDoc 注释块（create
静默走旧 handler，靠响应形状差异定位）；kill 为发信号语义，status 收敛
依赖 shell 退出时序，不进验证硬门槛。
