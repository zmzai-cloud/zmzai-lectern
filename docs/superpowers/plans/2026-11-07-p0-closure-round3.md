# P0 收口执行记录（第三轮，2026-11-07）

依据：2026-09-28 production-chain-closure spec/plan；承接 `2026-11-04-p0-progress.md` 与
`2026-11-04-p0-build-and-blocking.md`。用户授权：本地合并 main；不推送、不发布、不部署。
模型限定 glm-5.3-flash（DeepSeek 额度耗尽，不切换）。

状态口径：**已实施**（代码落地）/ **已验证**（实际运行过的检查，写明命令与结果）/
**待验证**（未实际运行）/ **受阻**（附证据）。

## 阶段 1：整合上一批成果

- 已实施：`feat/p0-build-closure` 三个提交（b947b52/e561145/b94d3bc）以 `--no-ff`
  本地合入 main，合并提交 **c4febfb**；worktree 分支快进到同一提交继续工作。
- 已验证（合并前在分支上重跑，非引用历史）：typecheck、arch:check（违规 0）、
  `pnpm test` 72 文件 656 通过 1 跳过、`pnpm test:release` 111 通过、`pnpm host:build`。

## 阶段 2：剩余 Host 迁移（提交 e685612）

### 盘点发现（文档落后于实现）

逐条核对清单与代码后，以下项此前记为已迁移，实际未生效或有缺陷：

1. messages/search/usage/events 四个读路由壳从未调用 `hostGateway`——armed 下仍由 Next
   执行。Host 旧端点形状与 UI 不符（messages 忽略 `view=window`；search 缺游标与
   projectId；usage 字段不同），`/v1/events` 读 fixture runtime 的日志。
2. 事件流在 Next 执行的后果：`subscribeEventLog` 的 live 扇出只在执行进程触发，
   Next 侧订阅退化为 1s 轮询——打包产物（armed）流式输出实际约 1 秒一批。
3. PUT read-state 网关条目方法（POST）与字段（messageSeq/revision）都与 UI 不符。
4. rewind 壳调用网关但表中无模式；Host `/v1/commands/rewind` 是死代码。
5. Host SSE 未 `flushHeaders`：空闲会话要等 15s 心跳才收到响应头。
6. Electron 退出的优雅收尾只打到 Next（armed 下空操作），Host 内运行中任务无收尾。

### 已实施

- 15 个 lib 服务（标准 Request/Response，兼容 `/api` 与 `/v1` 两种挂载）：会话改删、
  会话读面（messages/search/usage/read-state）、事件流、全局搜索、fs、git、交付概览与
  动作、截图证据、预览、plugins、repomap、skills、优雅收尾；`lib/project-scope.ts`。
- Next 壳统一为 `(await hostGateway(request)) ?? handleX(request)`；legacy 进程内执行同一
  服务，两条路径同契约；app 层零 runtime 有状态 import。
- Host：`SERVICE_ROUTES` 直通表（缺实现向下匹配，最终 404）；事件流按会话归属取日志并
  流式透传、客户端断开中止订阅；SSE 立即发头；rewind 登记凭据引用。
- 网关：新增 22 条映射；plugins/repomap 入口固定活动项目（覆盖客户端自带 projectId）；
  非会话路由不用捕获组（避免 503 详情伪造 sessionId）；透传头加 ACAO。
- 架构检查：迁移路由 21→37，豁免 21→16（读族五条清零）。归属清单按实现重写。

### 已验证

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 退出 0 |
| `pnpm arch:check` | 迁移 37、豁免 16、违规 0 |
| `pnpm test` | 74 文件，695 通过、1 跳过（原 656 + 新增 39） |
| `pnpm test:release` | 111 通过 |
| `pnpm host:build` | 通过 |
| `host/src/service-routes.test.ts`（生产装配：真实 buildRealRuntimeFace + startHostServer + 双项目 SQLite） | 12 通过：归属正确、越界拒绝、git 快照→列表→回滚、读面 UI 契约、预览字节、skills/plugins、全局搜索、改删、事件流 404/409、live 推送延迟 <600ms（轮询兜底 1s）、空闲会话 2s 内拿到响应头、断开中止订阅 |
| `lib/host-gateway-p0.test.ts` | 27 通过：22 条映射、rewind 凭据、项目固定、字节透传、不可达 503 不回落、legacy null |
| `node scripts/m2b-real-check.mjs`（独立进程跑打包 Host bundle，临时数据目录） | PASS；usage 断言随服务化改为 UI 契约 |

测试改动说明：preview/read-state 旧测试用无路径 URL 靠 ctx 传参，改为真实请求路径
（断言不变）；read-state 测试按仓库惯例加 node:sqlite 透传；截图测试的 runtime-constants
部分 mock 改为在原模块上覆盖 dataDir。

### 待验证 / 未收口

- armed Next→Host 进程级端到端（UI 真实路径经网关，尤其 SSE 实时性）：放到发行物验收
  阶段用生产 standalone 构建实测，尚未运行。
- multipart 附件上传仍进程内；failover 日志在 armed 下读 Next 空表（观测缺口）；
  16 条命令/终端族 legacy 豁免待 S16 清零。见归属清单「尚未收口」。
