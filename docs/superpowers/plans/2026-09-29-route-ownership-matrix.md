# API 路由归属清单（T09 交付物，2026-09-29）

对应 production-chain-closure T09（spec 2026-09-28 §4.3）：逐路由记录 owner 去向；
armed 网关命中的路由由 Host 执行（Next 只做形状适配），未迁移路由在过渡期由
进程内 handler 服务（legacy 回滚模式保留），R0 验收后按 S16 清零计划处置。

## Host owner（网关化，armed 下 Host 执行）

| 路由 | Host 端点 | 归属解析 | 迁移批次 |
| --- | --- | --- | --- |
| GET /api/sessions（?all=1 / 缺省 active） | /v1/sessions | 全项目聚合 / active projectId 注入；未知项目 404（T08/T09 回归，撤下原因已修复） | T09 |
| GET /api/sessions/:id/messages | /v1/sessions/:id/messages | 会话归属（sessionRuntime） | M2b |
| GET /api/sessions/:id/search | 同名 | 会话归属 | M2b |
| GET/POST /api/sessions/:id/read-state | /v1/commands/read-state | 会话归属 | M2b |
| GET /api/sessions/:id/usage | 同名 | 会话归属 | M2b |
| GET /api/sessions/:id/events（SSE） | /v1/events | 会话归属；since 重放 + CURSOR_STALE 409 同构 | T09 |
| GET /api/sessions/:id/command/:rid | /v1/commands/receipt | 会话归属；PC10 回执查询 | T07 |
| POST /api/sessions/:id/prompt | /v1/commands/prompt | 会话归属；真实 runtime（T08 修复 fixture 假模型缺口） | M2b/T08 |
| POST /api/sessions/:id/abort、/task、/compact、/permission | /v1/commands/* | 会话归属 | M2b |
| GET /api/sessions/:id/attachments/:aid（含 ?raw=1） | /v1/attachments/:id(/raw) | 附件 scope（会话归属） | M2b-B4 |
| GET/POST /api/terminal、/api/terminal/:id（input/resize/DELETE/read/read-all） | /v1/terminal* | 终端管理器 Host 单例；cwd 按会话归属解析 | M2b-B4 |
| GET/POST /api/mcp | /v1/mcp | 按项目（projectId 参数；缺省默认项目——UI 侧显式传参属 R0 后续） | M2b-B4/T08 |
| GET/POST /api/sessions/:id/worktree | /v1/sessions/:id/worktree | 会话归属；动作层与进程内同一实现（workspace-actions） | W1-S27 |

网关行为（T07）：armed 是进程启动快照；命中路由 Host 不可达 → 结构化 503
HOST_UNAVAILABLE（带 requestId/结果未知语义），绝不回落进程内；未命中路由 →
进程内 handler（legacy 模式的合法服务路径）。

## 纯 Next（无执行语义，不迁移）

- /api/auth/*（登录交互/代理，鉴权更新同步 Host 的 credentialRef 通道）
- /api/projects（项目注册/projects.json 管理——Host 控制面迁移属 T08 后续批次）
- /api/models、/api/settings（个人 key/降级端点配置——模型目录缓存灌入链路）
- /api/agents、/api/skills 列表（工作区文件读，无运行时状态）
- 静态资源 / _next

## 尚未迁移（进程内执行，R0 后续批次）

| 路由族 | 状态 | 说明 |
| --- | --- | --- |
| POST /api/sessions（会话创建，含 worktree 隔离创建） | 未迁移 | 创建链含 resolveModel/settings 读与 workspace 创建序列；Host 化需装配侧搬家 |
| PATCH/DELETE /api/sessions/:id | 未迁移 | 归属已按会话解析（进程内），Host 化随创建批次 |
| /api/fs/*、/api/git/* | 未迁移 | 文件/仓库读写；Host 化需 Host 挂 workspace 文件面 |
| /api/deliveries/*、/api/preview | 未迁移 | 交付验证（含浏览器 QA）；T13/T14（R1）一并 |
| /api/skills（执行/加载）、/api/plugins、/api/repomap | 未迁移 | 工具执行类；随 fs 族批次 |
| 浏览器验证 / CUA 相关 | 明确受限 | R1（T13–T16）前不在 armed 网关暴露 |

## 架构检查

scripts/arch-check.mjs：MIGRATED 清单路由禁止 import runtime 有状态实现
（豁免条目=legacy 回滚 handler，清零条件见脚本注释）；R3 环境变量读取仅限
lib/host-gateway.ts。本清单与 MIGRATED 数组保持同步。
