# M2c 设计：恢复/回收、启动器联动、生产入口切换（B0 收口冲刺）

- 日期：2026-09-22；状态：**S13–S16 全部实施完成**（见 §5 实施结果）
- 对应规格：§5.2（重启/退出/失联）、§5.4（迁移收官：Next 禁止导入 runtime 有状态实现）、§9.6（资源回收子集）、§15（打包/回滚）、§17 M2c 行
- 前置：M2b B1–B4 收官（14 路由 Host 通路全通，gateway-check 十一项）

## 1. 范围与硬目标

M2c 是 B0 的最后冲刺，四件事按依赖顺序：

1. **Host 生命周期**：启动器协议（Electron Main / dev 脚本分别拉起 Host+Next）、互斥（数据目录单 Host）、正常退出序列（停新命令→取消任务树→终进程树→落库→退出）、异常重启上限（3 次/60s）；
2. **Next 去 runtime 化收官**：架构断言落地——迁移路由的旧 handler 内不再 import `sessionRuntime/runtimeFor/terminalManager`（可执行 grep 门禁），lib/runtime 的有状态装配只活在 Host 进程；
3. **生产入口切换**：`LECTERN_HOST_GATEWAY` 从验证 flag 转正为默认 armed（Electron Main 注入），保留环境变量逃生门（不设=旧进程内模式，回滚即关）；
4. **打包与发版**：host dist 进 standalone 资源、双平台 smoke（A25 子集：Host 启动/重启/取消/退出无孤儿）、0.7.0。

## 2. 关键设计

### 2.1 启动器协议（§5.1/5.2 子集）

- **host.json 握手已就绪**（M2a）；补 `lock`：Host 启动即写 `<data>/host.lock`（pid+hostInstanceId+启动时刻），退出删除；发现活锁（进程存在且 health 可达）则拒绝启动并报错，**不删锁接管**（spec §5.1）；
- **Electron Main**：`utilityProcess.fork` Next（现状）+ 新增 Host fork；`LECTERN_HOST_GATEWAY/BOOTSTRAP` env 注入 Next；Main 退出 → 逐个有序停（Host 先停新命令再收任务树，10s 上限强杀）；
- **dev**：`scripts/dev-host.sh` 一键（起 Host → 写 env 文件 → 起 next dev）；`pnpm dev` 保持纯 Next（不 armed，兼容 UI-only 开发）。

### 2.2 异常重启护栏

Main 侧：Host exit 非 0 → 重启计数（60s 窗口 3 次上限），超限弹窗报障不循环。Host 内部不自我重启（保持简单，重启决策归启动器）。

### 2.3 架构断言（可执行门禁）

`scripts/arch-check.mjs`：
- 迁移清单内路由文件（B1–B4 的 14 个）不得含 `sessionRuntime|runtimeFor|terminalManager|mcpStatusFor` import——命中即 exit 1（CI/发版前置）；
- `app/**` 不得 import `host/src/**`；`lib/host-gateway.ts` 之外不得读 `LECTERN_HOST_GATEWAY`。
- **豁免清单显式列出**（旧 handler 未删的 worktree POST/multipart 上传路由），逐条注明去向。

### 2.4 生产切换与回滚

- Electron Main 默认注入 armed env → 打包版全量走 Host；
- 回滚 = Main 不注入（一个 build flag `LECTERN_LEGACY_RUNTIME=1`），旧 handler 全部仍在（M2c 不删旧代码，只断言迁移路由不再引用 runtime——**回滚即关 flag**）；
- 旧进程内 Runtime 与 Host 不同时写生产数据的保证：armed 模式下 Next 不再构造 runtimeFor（arch-check 保证 import 缺席）。

### 2.5 资源回收子集（§9.6 的 M2c 份）

- Host 退出序列中：`terminalManager().disposeAll()` + MCP pool 关闭 + 租约结算（registerLeaseRecovery 已有）；
- A39（100 轮资源归零）完整验证留 E 阶段 harness，M2c 做 smoke 级（反复 create/kill 终端 ×20 + 任务跑批 ×10 → Host heap/句柄无持续增长，诊断记录）。

## 3. Slice 计划

| # | 内容 | 验收 |
| --- | --- | --- |
| S13 | host.lock 互斥 + dev-host.sh + Main fork Host + 退出序列 | 双开 Host 第二个拒绝；Main 退出无孤儿（ps 断言） |
| S14 | arch-check.mjs + 迁移路由去 runtime import 清理 | 脚本 exit 0；豁免清单落档 |
| S15 | armed 默认化（Main 注入）+ 旧 handler 保留回滚验证 | 打包版 gateway-check 全过；LEGACY flag 回滚后 UI smoke 过 |
| S16 | 双平台打包 + A25 子集 smoke + 0.7.0 发版 | build:mac 实测；Windows 交叉构建标记未验证（无环境如实记录）；CHANGELOG |

## 4. 风险

- R-1 Electron utilityProcess 双 fork 的 stdio/信号语义（SIGTERM 传递）——S13 用真 Main 冒烟，不 mock；
- R-2 armed 默认后生产 UI 走 Host 的第一晚——LEGACY flag 是硬逃生门，发版说明写明回滚步骤；
- R-3 Windows 真机不可得（本机 darwin）——A25 的 Windows 项如实标未验证，不跨平台编译冒充（spec §15.8）。


## 5. 实施结果（2026-09-22，均已推送）

| Slice | 提交 | 结果 |
| --- | --- | --- |
| S13 生命周期 | `5dadb62` | host.lock 活锁互斥（探测先于 startHostServer——冒烟抓到第二实例覆盖 host.json 的顺序 bug）；/v1/shutdown 有序停止；Main fork Host + 重启护栏（60s/3）+ before-quit Host 先收尾 + armed env 注入；dev-host.sh；m2c-smoke 5/5 |
| S14 arch-check | `7315194` | R1/R2/R3 三规则；20 迁移路由 + 21 条豁免（S16 切换验收后清零——回滚此后按 §15.6 走旧二进制）；exit 0 |
| S15 回滚实测 | `2e263ca` | LEGACY（无 GATEWAY env）旧 handler 原样服务（数组形状/name 字段）、ARMED Host 形状——3/3；顺序单实例模式（双 next dev 就绪互卡）；就绪探测改根路径（LEGACY 下 m2a/health 500） |
| S16 发版配置 | `f721e0b` | files 白名单 host/dist；build-mac.sh [0/5] host:build；0.7.0-rc + CHANGELOG；发版前检查全绿（496/496 + arch 0 + smoke 5/5） |

M2c 放行条件对照：A11 子集（退出无孤儿=before-quit 序列+强杀兜底）；A25 macOS 项随实打包验收（Windows 本机不可验证如实标注）；A10（强杀 Host）的完整恢复流属 §5.2 深水区，注册到 M3/M4 恢复验证一并做——Host 崩溃后由 Main 重启护栏 + lock 清理 + SQLite 租约恢复三重兜底，本轮不声称完整 A10 通过。
