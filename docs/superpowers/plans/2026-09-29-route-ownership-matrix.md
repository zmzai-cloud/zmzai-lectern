# API 路由归属清单（T09 交付物，2026-09-29；2026-11-07 P0 收口更新）

对应 production-chain-closure T09（spec 2026-09-28 §4.3）：逐路由记录 owner 去向；
armed 网关命中的路由由 Host 执行（Next 只做形状适配），启动锁定 legacy 时由进程内
同一服务执行；R0 验收后按 S16 清零计划处置剩余过渡豁免。

## 2026-11-07 盘点结论（先读）

本轮逐条核对实现后发现：清单此前把部分读路由记为「Host owner」，实际并未生效——

- `GET /api/sessions/:id/{messages,search,usage}`、`GET .../events`：网关表有条目，
  但 Next 壳从未调用 `hostGateway`，armed 下一直由 Next 进程执行。且 Host 旧端点
  不能直接打开：messages 忽略 `view=window`、search 缺游标与 projectId、usage 字段
  不同；`/v1/events` 读的是 fixture runtime 的事件日志（非会话所属 runtime）。
- 事件流由 Next 服务的后果：`subscribeEventLog` 的 live 扇出只在执行进程（Host）
  触发，Next 侧订阅退化为 1s 轮询——打包产物的流式输出实际约 1 秒一批。
- `PUT /api/sessions/:id/read-state`：UI 用 PUT `{lastReadMessageSeq, historyRevision}`，
  网关条目是 POST `{messageSeq, revision}`，方法与字段都对不上，从未命中。
- `POST /api/sessions/:id/rewind`：壳调用了网关，但网关表无匹配模式，Host
  `/v1/commands/rewind` 是死代码。
- Host SSE 只 `writeHead` 不 `flushHeaders`：空闲会话要等 15s 心跳才收到响应头。
- Electron 退出先打 Next `/api/shutdown/graceful`（armed 下 Next 无运行中任务，空操作），
  再直接结束 Host——Host 内运行中任务没有优雅收尾，只能靠下次启动租约恢复。

处置：上述全部改为「lib 服务 + 薄壳」模式（见下），新增生产装配测试
`host/src/service-routes.test.ts` 与网关映射测试 `lib/host-gateway-p0.test.ts`。

## 迁移模式（2026-11-07 起）

业务逻辑抽到 `lib/*-service.ts`（标准 Request/Response，服务自解析 URL 路径参数与
body，兼容 `/api/...` 与 `/v1/...` 两种挂载路径）。Next 壳 =
`(await hostGateway(request)) ?? handleX(request)`：armed 代理 Host，legacy 进程内执行
**同一服务**——两条路径同一契约，app 层零 runtime 有状态 import（架构检查无豁免）。
Host 侧 `SERVICE_ROUTES` 直通表把 `/v1/...` 交给 `realRuntime` 上的同名服务面。

## Host owner（网关化，armed 下 Host 执行）

| 路由 | Host 端点 | 归属解析 | 批次 |
| --- | --- | --- | --- |
| GET /api/sessions（?all=1 / 缺省 active） | /v1/sessions | 全项目聚合 / active projectId 注入；未知项目 404 | T09 |
| POST /api/sessions | /v1/session-create | 网关入口固定 projectId；完整 cookie 原样传递；未知项目 404 | P0 2026-11-04 |
| PATCH/DELETE /api/sessions/:id | /v1/sessions/:id | 会话持久归属（sessionStoreFor）；删除含隔离副本清理与遗留 JSONL 清扫 | P0 2026-11-07 |
| GET /api/sessions/:id/messages | /v1/sessions/:id/messages | 会话归属；session-read-service（窗口快照/尾页/全量） | P0 2026-11-07（修正） |
| GET /api/sessions/:id/search | /v1/sessions/:id/search | 会话归属；游标绑定 sessionId/query/revision | P0 2026-11-07（修正） |
| GET /api/sessions/:id/usage | /v1/sessions/:id/usage | 会话归属；以 step-finish 为准 | P0 2026-11-07（修正） |
| GET/PUT /api/sessions/:id/read-state | /v1/sessions/:id/read-state | 会话归属；PUT CAS 冲突 409 | P0 2026-11-07（修正） |
| GET /api/sessions/:id/events（SSE） | /v1/events | 会话归属取事件日志（不再读 fixture）；since 重放 + CURSOR_STALE 409；立即发头 | P0 2026-11-07（修正） |
| GET /api/sessions/search | /v1/session-search | 跨项目聚合，结果带 projectId | P0 2026-11-07 |
| GET /api/sessions/:id/command/:rid | /v1/commands/receipt | 会话归属；PC10 回执查询 | T07 |
| POST /api/sessions/:id/prompt | /v1/commands/prompt | 会话归属；真实 runtime | M2b/T08 |
| POST /api/sessions/:id/abort、/task、/compact、/permission | /v1/commands/* | 会话归属 | M2b |
| POST /api/sessions/:id/rewind | /v1/commands/rewind | 会话归属；带凭据通道（重发 prompt） | P0 2026-11-07（补缺） |
| GET /api/sessions/:id/attachments/:aid（含 ?raw=1） | /v1/attachments/:id(/raw) | 附件 scope（会话归属） | M2b-B4 |
| GET/POST /api/terminal、/api/terminal/:id（input/resize/DELETE/read/read-all） | /v1/terminal* | 终端管理器 Host 单例；cwd 按会话归属解析 | M2b-B4 |
| GET/POST /api/mcp | /v1/mcp | 按项目（projectId 参数；缺省默认项目） | M2b-B4/T08 |
| GET/POST /api/sessions/:id/worktree | /v1/sessions/:id/worktree | 会话归属；动作层与进程内同一实现 | W1-S27 |
| GET/PUT /api/fs/file、GET /api/fs/search、GET /api/fs/tree | /v1/fs/* | 根目录按 sessionId 持久归属（隔离会话落 worktree） | P0 2026-11-07 |
| GET/POST/PUT /api/git/checkpoint、GET /api/git/diff | /v1/git/* | cwd 按 sessionId 持久归属 | P0 2026-11-07 |
| GET /api/deliveries | /v1/delivery-overview | owner 由 sessionId 服务端推导 | P0 2026-11-07 |
| POST /api/deliveries/attempt | /v1/delivery-attempt | owner 由 sessionId 推导；attemptId 与会话 delivery join | P0 2026-11-07 |
| POST /api/deliveries/browser-qa | /v1/browser-qa | 会话归属；长连接豁免超时 | P0 2026-11-04 |
| POST /api/deliveries/computer-use | /v1/computer-use | 租约归属校验；根 task 服务端推导 | P0 2026-11-04 |
| GET /api/deliveries/browser-screenshot | /v1/browser-screenshot | dataDir 内路径守卫 | P0 2026-11-07 |
| GET /api/preview/:sessionId/* | /v1/preview/:sessionId/* | 根目录按 sessionId（`_` = 活动项目）；字节流透传 | P0 2026-11-07 |
| GET/POST /api/plugins | /v1/plugins | 网关入口固定活动项目为 projectId（客户端自带值被覆盖）；未知项目 404 | P0 2026-11-07 |
| GET /api/repomap | /v1/repomap | 同上（入口固定 projectId） | P0 2026-11-07 |
| GET /api/skills | /v1/skills | 根目录按 sessionId 持久归属 | P0 2026-11-07 |
| POST /api/shutdown/graceful | /v1/graceful-shutdown | 在 run 所在进程中止 running 会话 + checkpoint | P0 2026-11-07 |

网关行为（T07）：armed 是进程启动快照；命中路由 Host 不可达 → 结构化 503
HOST_UNAVAILABLE（带 requestId/结果未知语义），绝不回落进程内；未命中路由 →
进程内 handler（legacy 模式的合法服务路径）。非会话路由的模式不使用捕获组
（groups[0] 会被当作不可达响应里的 sessionId）。

## 纯 Next（无执行语义，不迁移）

- /api/auth/*（登录交互/代理，鉴权更新同步 Host 的 credentialRef 通道）
- /api/projects（项目注册/projects.json；Host 每请求重读 projects.json，无需代理）
- /api/models、/api/settings/*（配置与模型目录；failover 日志字段见下方缺口）
- /api/agents（工作区文件读，无运行时状态）
- /api/memory/*（K1 视图：绑定/候选/outbox/召回记录读项目库，无执行；R2 范围）
- /api/m2a/*（M2a 实验路由，仅 LECTERN_HOST_BOOTSTRAP 验证环境）
- 静态资源 / _next

## 尚未收口

| 项 | 状态 | 说明 |
| --- | --- | --- |
| POST /api/sessions/:id/attachments（multipart 上传） | 进程内 | UI 上传通路暂留（过渡豁免）；Host 有 /v1/commands/attachment（base64）但 UI 未切 |
| failover 日志（/api/settings/failover GET、/api/models 的 failover 字段） | 观测缺口 | 降级发生在执行进程；armed 下 Next 读到的是自身空表。不影响执行，待加 Host 只读面 |
| 16 条过渡豁免（命令族/终端族/mcp/列表 GET 的 legacy handler） | 已接网关 | armed 下由 Host 执行；legacy 回滚 handler 仍直接 import runtime，S16 按服务化模式清零 |
| 浏览器验证 / CUA 模型工具与 PC15–PC19 全链路 | 待验收 | 控制端点已 Host 化；模型工具与原生验收另行记录 |

## 架构检查

scripts/arch-check.mjs：MIGRATED 清单路由禁止 import runtime 有状态实现
（豁免条目=legacy 回滚 handler，清零条件见脚本注释）；R3 环境变量读取仅限
lib/host-gateway.ts。2026-11-07：MIGRATED 21→37，豁免 21→16（读族五条清零）。
本清单与 MIGRATED 数组保持同步。
