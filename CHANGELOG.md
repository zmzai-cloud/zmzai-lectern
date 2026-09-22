# Lectern 变更记录

## 0.9.0 —— M3/M4：子代理持久协调 + B0 收官

**本版本完成 B0 全部目标**（spec `2026-09-21-lectern-host-and-subagents-design.md`）：独立 Host、命令/状态边界、可并行可控可恢复的子代理能力。

- **子代理五工具（spec §8.1）**：`agent_spawn`（立即返回 childId 不等待）、`agent_list`、`agent_send`（mailbox 幂等投递、终态拒绝）、`agent_wait`（首个终态 ≤30s）、`agent_cancel`（幂等取消树）。旧 `task` 工具保持兼容（spawn+wait 串行语义）。
- **持久协调（spec §8.2）**：SubagentRecord 11 态状态机（CAS）+ mailbox 双 SQLite 表；限额队列（每根任务 3 / 全局 6，根间轮转根内 FIFO，env 可配）；spawn 幂等（同 requestId 同 child）。
- **父任务 parked 机制（spec §8.2 调度状态）**：父轮次结束但必要子代理未终态 → 释放父并发槽、Task 保持 running；子结果入邮箱与唤醒意图同事务、水位幂等合并（多子同时完成一个父唤醒）；终态父拒绝自动复活。
- **父验证门禁（spec §9.4）**：消费 ≠ 接受——`subagentPending` 进完成判定，子代理自称成功不能换来 delivered（A36）；consumeState（pending_review/accepted/rejected）与执行状态正交。
- **权限/取消**：子权限 = 父上限 ∩ preset；read_only 模式写路径全拒；取消沿协调器递归全后代。
- 内嵌 `@zmzai/agent-framework` 升至 0.11.0（子代理全模块 + M1 六单元拆分 + TOCTOU 修复 + CompactionStore + ToolContract）。

**M4 发版检查**：framework 579/579 + lectern 496/496 + gateway-check 十一项 + real-check 八项全绿；arch-check 门禁 0 违规；A01–A04/A08/A13/A14/A18/A24/A28/A29/A36 逐项落地。真实模型基线重测按评测后置决策归 E 阶段（不阻塞本发版，spec §17.0）。

## 0.7.0 —— M2c：独立 Lectern Host 上线（B0 进程架构切换）

**架构变更（本版本核心）**：Agent 运行时从 Next.js 进程整体迁入独立的 Lectern Host 进程。页面刷新、Next 服务重启不再中断任务；Electron 应用退出时有序收尾（Host 先停新命令、收任务树与终端，10s 上限强杀兜底）。

- **Host 生命周期**：`host.lock` 活锁互斥（不删锁接管）；异常退出 60s/3 次自动重启上限，超限弹窗报障；`/v1/shutdown` 有序停止。
- **路由族全量迁移（20 条）**：sessions 只读族（列表/消息/搜索/读状态/用量）、命令族（prompt/abort/permission/task）、状态操作族（compact/read-state/rewind——回溯复合流抽入 lib 双端共用）、附件族（字节流直通+安全头透传）、终端族（PTY 七端点）、MCP 状态。`pnpm arch:check` 架构门禁落地。
- **credentialRef 鉴权链（spec §5.3）**：网关只提取 `muzhi_session` 单值经内部头转发，Host 内存表→模型流按会话取用；不落日志/事件，进程重启即失效。
- **SSE 水位校验（A08）**：`since` 超过最新 seq 返回 409 CURSOR_STALE 显式重同步。
- **性能基线**：durable receipt p95 15.7ms（门槛 300ms）。
- **回滚逃生门**：`LECTERN_LEGACY_RUNTIME=1` 回退进程内 Runtime（已实测：flag off 时旧 handler 原样服务）。
- 内嵌 `@zmzai/agent-framework` 升至 0.10.0（M1：Runner 六单元拆分、TOCTOU 修复、CompactionStore 跨 Attempt、ToolContract+toolCallId 台账、modelCaps 键改 ModelRef）。

# Changelog

## 0.5.1 — 2026-09-07

- 增加账户菜单内的版本检查、用户主动下载、下载进度和 SHA-512 完整性校验。
- 无签名更新流程：macOS 下载后在 Finder 中显示，退出应用后手动替换；Windows 确认后启动安装器。不会静默安装或绕过系统安全检查。
- 0.5.0 用户需要手动安装本版一次，之后可使用应用内更新入口。
- 文本与代码附件使用独立数据契约传递和保存，以附件显示，不再将文件内容拼入用户消息；模型上下文仍可读取附件内容。暂不解析 PDF、Word 等二进制文档。
- 优化任务分组、未读标记与跨项目搜索，并补充发布包校验和隔离数据的启动检查。
- 发行目标：macOS Apple Silicon ZIP、Windows x64 安装版 EXE 和便携 ZIP。未提供可信代码签名，Windows 真机安装验证仍待完成。

## 0.5.0 — 2026-09-07

### 界面与交互

- 重整桌面顶栏，采用更简洁的任务标题与侧栏控制布局，减少重复标题和视觉干扰。
- 优化消息主界面的阅读宽度、用户消息、输入区与工具执行记录，支持折叠文件读取、任务计划及完成摘要。
- 保留阅读历史消息时的滚动位置，提供回到最新消息的入口。
- 精简任务侧栏，将次要操作收进菜单，保留运行、等待和错误状态提示。
- 设置入口收回账户菜单，恢复账户栏上方分隔线。
- 优化设置页分区和主题选择，并同步账户菜单与设置页的主题状态。
- 修正布局偏好在服务端渲染与客户端恢复时的不一致。

### 平台适配

- macOS 使用适配系统窗口按钮的顶栏间距与拖动区域。
- Windows 保留原生窗口控制，不套用 macOS 的窗口按钮留白。
- 按平台显示 Command / Ctrl 快捷键提示，并补充 Windows 系统字体回退。

### 发行包

- macOS：Apple Silicon（arm64）ZIP。
- Windows：x64 安装版 EXE 与便携 ZIP。
- 提供 SHA-256 校验文件。Windows 包通过交叉构建生成，仍需 Windows 真机验证。
- macOS 包采用 ad-hoc 签名，未做 Developer ID 签名及公证；Windows 包未做代码签名，首次运行可能出现系统安全提示。
