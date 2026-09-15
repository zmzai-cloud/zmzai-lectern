# 高优先工作流实施记录

用户于 2026-09-08 批准执行 `2026-09-07-lectern-high-priority-workflows.md`。
本清单记录实际完成项，不把 Epic 或存在依赖的工作标成已完成。

## 第一执行单元：F0-1 会话归属

- [x] 引入统一 session -> 已登记项目/真实会话库/worktree 解析，不回落活动项目。
- [x] 未知/歧义会话、不可用目录、损坏映射明确失败，不创建替代目录或数据库。
- [x] 固定 runtime 的 fs/git/terminal/sandbox 根目录，切换项目不改变已有运行。
- [x] 会话 API、文件/Git/预览/终端创建、交付 owner 采用同一归属解析与错误响应。
- [x] 会话创建跨 await 固定项目，搜索和列表返回项目归属。
- [x] 归属回归测试、全量单测、类型检查、生产构建及真实跨项目冒烟通过。

## 第二执行单元：F0-2 / F0-3 发送与消息一致性

- [x] 按会话与持久化 seq 去重；应用成功后推进游标。
- [x] 遇到序号缺口、异常帧或投影失败，保留游标退避重连；忽略已关闭连接的迟到事件。
- [x] 历史加载器按会话隔离，切换时 abort；即使传输忽略取消，也拒绝迟到响应。
- [x] 首屏和更早历史区分加载/失败/空状态，支持显式重试，失败不推进分页位置。
- [x] 新增 16 项客户端回归测试通过。
- [x] 浏览器故障注入、窄屏/桌面截图与当前生产构建验证。
- [x] prompt 与新会话创建均持久化 requestId；相同载荷返回原 receipt/session，不同载荷返回 409。
- [x] 请求、用户消息、附件 parts、完整队列载荷及首批事件在 SQLite 单事务登记；排队任务 FIFO 执行。
- [x] 队列保留模型、图片、附件、agent、effort、skill、references；未开始的消息不进入当前模型上下文。
- [x] run 状态和 revision 持久化；认领时同步执行租约，崩溃恢复进入 recovery_required，不自动重放未知副作用。
- [x] messageSeq 单调且不复用；窗口游标绑定 sessionId/historyRevision，rewind 原子递增 revision 并使旧游标 409。
- [x] 消息/parts 投影与 event log 原子提交；快照返回 snapshotSeq，客户端先装载快照再从水位续订。
- [x] v2 迁移前生成 SQLite 备份；旧记录按 `(created,id)` 确定性回填，迁移记录可重复启动。

F0-2 与 F0-3 的持久化和客户端接线已完成；本轮继续修复收尾验收发现的边界问题。
M 尚未全量验收，不能将搜索定位的完成等同于整个消息体验 Epic 完成。

## 第三执行单元：F0 收尾与 M 搜索定位

- [x] 服务端事件订阅保留缺口后的事件、按 seq 去重；已取消的订阅直接退出；完整历史批次连续补拉。
- [x] 初始化期间停止不调用模型、不执行后续队列、不遗留 running 租约。
- [x] 失败后的队列进入 recovery_required；终态与租约释放同事务，过期租约回收同时标记中断运行。
- [x] 中断恢复检查完整分页事件日志，不再遗漏第 1,000 条之后的授权/工具/待办；工具终态与事件同事务。
- [x] 消息窗口同事务返回状态事件及运行记录，恢复待授权、待办、小结、断点和最近/当前运行产物；恢复授权不自动重复审批。
- [x] 新增规范化消息搜索表，旧 parts 一次性回填；正文、工具名/摘要、附件名与 parts 同事务更新，rewind/delete 清理索引。
- [x] 会话搜索采用参数化 SQL 和稳定游标，绑定会话、查询、revision；排除推理、工具输入/完整输出、附件 URL/正文，并遮蔽常见凭据格式。
- [x] 新增 around/after 消息窗口接口，可定位首/中/末段历史，前后翻页；目标删除和回溯冲突明确报错。
- [x] 会话内搜索面板：匹配高亮、独立 50 条上下文窗口、前后翻页、长正文折叠、请求取消与迟到响应拒绝、失败重试、Escape 关闭与焦点恢复。
- [x] 授权到达不再强制将正在查看历史的用户滚到底部；保留回到最新消息入口。
- [ ] 主消息流 500 条缓存卸载与动态行高虚拟化，10,000 条消息 DOM 上限验收（M-01）。
- [ ] 全局搜索接入相同定位契约及分页。
- [ ] 服务端持久化已读游标、聚焦且尾部停留 500ms 判读、未读助手消息数（M-05）。
- [ ] 10,000 条消息/50 MiB 搜索数据集性能基线与 M-02 并发 100 条追加矩阵。
- [ ] 完整 M-03 故障矩阵及 Windows 原生/缩放验收。

实现沿用 frontend-design 的现有系统一致性原则，新增紧凑工具入口，不改变账户设置位置。
搜索上下文独立于实时消息投影，查看历史时后台流继续更新；关闭搜索返回原对话。
常见凭据遮蔽不是通用秘密识别保证，不宣称任意正文都能自动去敏。

本轮验证：

- Framework 34 文件 / 298 测试通过；最后运行终态补丁后 runner/workflow 36 项再次通过。
- Lectern 20 文件 / 162 测试通过，`pnpm typecheck` 通过；两仓库 `git diff --check` 通过。
- `/tmp/lectern-m-build-sgKE4o` 隔离生产构建通过（源码包括搜索长正文折叠）；没有覆盖原仓库 `.next`。
- `e2e/message-search-ui.mjs`：首/中/末段定位、替换查询拒绝迟到结果、失败重试、Escape、授权出现时滚动位置保持通过；1440x900 和 390x844 无横向溢出、无 pageerror，截图人工检查通过。
- `e2e/message-recovery-ui.mjs` 已升级为稳定游标 mock：初始/更早历史重试、切会话取消、重复 delta，以及 1440/1024/390 三种宽度通过。首次截图等待远程字体超时，复跑关闭截图阶段的字体等待后通过，不影响功能断言。
- `e2e/session-ownership-smoke.mjs`：真实 SQLite 索引查询、分页游标、around 上下文与 todo 水位、跨项目归属、重启后搜索持久化通过；原 Git/终端/缺失 worktree 场景亦通过。
- 浏览器截图：`test-results/message-search/`、`test-results/message-recovery/`。
- 隔离 fixture：`/var/folders/1y/qckskq813w97yvj6xm3qf5_40000gn/T/lectern-ownership-smoke-UBxHbm`；测试仅删除自身创建的 worktree，未删除用户文件。

本轮隔离预览：`http://127.0.0.1:3104`。不加载真实会话，外部模型地址指向不可用的本机测试端口。

## 验证证据（2026-09-08）

- `pnpm test`：19 个文件、156 项通过（包括 16 项消息恢复和 3 项错误包装测试）。
- `pnpm typecheck`：通过。
- `pnpm test:release`：33 项通过；没有构建或上传安装包。
- `pnpm build`：当前源码的隔离副本 `/tmp/lectern-message-build-FSePY9` 构建通过。
  原仓库 3101 服务和 `.next` 保持不动。
- `node e2e/session-ownership-smoke.mjs`：在上述生产构建下通过，覆盖真实 Git、
  SQLite、会话创建/切项目/重启/丢失 worktree 和未知会话读写/重命名/删除。
  fixture：`/var/folders/1y/qckskq813w97yvj6xm3qf5_40000gn/T/lectern-ownership-smoke-RiREqn`。
- `node e2e/message-recovery-ui.mjs`：Chrome 故障注入通过，首屏重试、分页失败保留历史、
  切会话时旧请求取消和重复 delta 均通过，无 pageerror。仅使用 mock API，不调用模型。
  检查 1440x900、1024x768、390x844，重试控件可见，无页面横向溢出；窄屏收起侧栏。
  截图：`test-results/message-recovery/`，已人工查看桌面、窄屏及分页错误状态。
- 新 UI 沿用 frontend-design 的现有系统一致性原则，只增加状态行和带 tooltip 的重试图标。
  browse 因缺少指定 Chromium 启动失败，改用项目已有 Playwright + 系统 Chrome 验证。
- Windows 原生、暗色/系统缩放矩阵与完整 M-03 未验收，不能由以上 Web 测试替代。
- `zmzai-framework pnpm build && pnpm test`：34 个文件、291 项通过。
- `zmzai-lectern pnpm typecheck && pnpm test`：19 个文件、156 项通过。
- 隔离目录 `/tmp/lectern-f0-build-oSrGaz` 的 `pnpm build` 通过；独立预览真实 HTTP 冒烟验证
  重复建会话返回同一 session、重复 prompt 返回同一 run/message receipt、转录仅一条用户消息、
  快照返回 messageSeq/historyRevision/snapshotSeq，不同载荷复用 requestId 返回 409。

本地预览：`http://127.0.0.1:3102`，使用独立临时数据目录，不加载真实会话。
fixture 仅移除了测试创建的隔离 worktree 来验证丢失目录场景；用户项目未删除或清理。

## 后续单元

- M/T/A：消息体验、任务中心、附件完整链路。
- D/R/B：交付、模型、充值；真实计费接口未确认前禁止虚构支付接入。

## 边界

本单元不声称完成 Origin/宿主认证、终端资源 ACL、文件路径竞态防护或整个 F0；
不上传应用包、不改版本号、不清理用户未提交文件；framework 变更仅重新打包本地 vendor 依赖。
