# zmzai-harness 能力差距分析

> 信息源：`.research/harness-src/` 五个参考实现（opencode / pi-mono / deepseek-harness / gemini-cli / codex）的真实包结构与 README 能力清单，逐一对照 `@zmzai/agent-framework + zmzai-harness` 现状。
> 基准日期：2026-08-27。状态标注：✅ 已具备 · ⚠️ 部分 · ❌ 缺失。

## 一、核心运行能力（Harness 本体）

| 能力 | 参考实现 | 现状 | 状态 |
|---|---|---|---|
| Agent 循环 + 事件流 | 全部 | SessionRunner + compaction + lease-recovery | ✅ |
| 权限/审批 | opencode permission/policy、gemini confirmation-bus | PermissionEngine + ruleset + 桌面弹窗（pi 甚至没有权限系统） | ✅ |
| 工具集 | opencode 16+、codex tools/ | read/glob/grep/write/edit/bash/todo/task/webfetch/qa-check + git_status/diff/log/commit + terminal_start/read/write/kill/list + **websearch + apply_patch（2026-08-27 全部落地，工具面 16 个）** | ✅ |
| 上下文压缩 | opencode、codex context-fragments | compaction.ts | ✅ |
| 文件监视 | codex file-watcher、opencode filesystem | 无 | ❌ |
| Hooks 生命周期 | codex hooks/、gemini hooks/、opencode event.ts | ✅ 2026-08-27 落地（framework `core/runtime/lifecycle.ts` 四钩子 onRunStart/onBeforeToolCall/onAfterToolCall/onRunEnd；before 可拦截并反馈模型，钩子抛错只告警不中断） | ✅ |
| Git 集成 | opencode git.ts、codex git-utils | ✅ 2026-08-27 结构化 status/diff/log/commit 落框架 builtins，commit 真实写仓库（非沙箱快照副本）；diff 渲染视图已落地（ReviewPane/DiffView/ChatView） | ✅ |

## 二、模型层（差距最大的一档）

> 2026-09-02 刷新：原表 5 项 ❌ 里 4 项已落地，文档曾长期落后于代码。以下为真实状态。

| 能力 | 参考实现 | 现状 | 状态 |
|---|---|---|---|
| 多提供商 | pi ai/ 统一 API、opencode llm/+credential/+oauth | `ModelProvider` 接口（`adapters/index.ts`），`createOpenAiModelProvider` 是唯一实现；Ollama 经 `providerWithOllama` 分流 | ✅(抽象已就位) |
| 模型目录 | opencode models-dev.ts、pi 构建期生成、codex models-manager | relay `/models` 动态拉取 + Ollama `/api/tags` 探测（2s 超时），非硬编码 | ✅ |
| 路由/降级 | gemini routing/+fallback/+availability | framework `failoverEndpoints`（N 个）+ 首事件判健康 + `onFailover` 环形日志透出；设置页可增删改（2026-09-02 UI 化） | ✅ |
| 本地模型 | codex ollama/+lmstudio/ | Ollama 分流 + 设置页 UI（ollamaUrl）+ Composer「本地 · Ollama」分组 | ✅ |
| 凭据管理 | codex keyring-store+secrets、opencode credential.ts | 个人 key AES-256-GCM 加密落盘（dataDir/.secret 0600）+ 旧明文自动迁移 + 密钥轮换 | ✅ |

**模型能力真实值链路（2026-09-02 闭合）**：relay `/models` 返回每模型 `maxInputTokens` / `maxOutputTokens` / `allowedReasoningEfforts`，经进程级缓存（`lib/model-caps.ts`）灌入 provider 的 `modelCaps` 回调——上下文窗口、最大输出、推理档位白名单三者全部跟模型目录走，UI 档位选择器按白名单禁用不支持的档位，从源头杜绝 `REASONING_EFFORT_NOT_ALLOWED` 400。

## 三、插件与生态

| 能力 | 参考实现 | 现状 |
|---|---|---|
| 插件架构 | deepseek「一切皆插件」（Cordis）、opencode plugin/ | ✅(基础) parseAgentPlugin（plugin.json+skills+mcp.json）+ 信任安装 + 运行时热加载（mcp.json/plugins 目录 watcher 去抖 800ms 自动 rescan）；无 per-plugin 生命周期沙箱 |
| MCP 客户端 | gemini mcp/、opencode integration/、codex mcp-server | ✅ 2026-08-27 三传输全落地：stdio（NDJSON JSON-RPC）+ streamable-http（单端点 POST、SSE/json 双应答、mcp-session-id）+ sse 遗留传输；插件面板状态 UI + 配置热加载 |
| 插件市场/目录 | opencode catalog.ts+installation/ | ❌ |
| Skill 体系 | opencode skill/、gemini skills/ | ✅ 独立发现/选择/注入已落地：listSkills 三源发现（工作区 .zmzai/skills、~/.codex/skills、~/.agents/skills）+ Composer Skill 选择器 + 选中后按条注入 + 设置页技能面板；安装仍走插件目录 |

## 四、前端形态

| 形态 | 参考实现 | 现状 |
|---|---|---|
| 桌面 | opencode desktop/（BETA）、本仓 Electron | ✅ 已有（opencode 是 Web 壳 + 本地 server 思路，可借鉴其多端复用） |
| TUI | opencode tui/、pi tui/、codex tui/ | ❌ |
| Web | deepseek apps/web、opencode web/ | ❌（框架可 serve 但无 UI） |
| IDE 集成 | gemini vscode-ide-companion/、codex app-server | ❌ |
| 语音 | gemini voice/ | ❌（可不做） |

## 五、平台化（对齐 opencode 的核心差距）

| 能力 | 参考实现 | 现状 |
|---|---|---|
| 开放协议 + SDK | opencode protocol/+sdk/+client/+server、pi protocol/+client/+rpc-entry、codex app-server | ❌ Electron IPC 仅本机 GUI 用 |
| 会话快照/分享 | opencode snapshot.ts+share/、pi 会话发布 HF | ❌ |
| 遥测 | pi telemetry/（vendor-neutral）、codex otel/+analytics/ | ❌ |
| Agent 评估 | pi evals/、gemini evals/、codex rollout-trace | ❌ 仅 vitest + smoke，无真实任务评估集 |
| 会话存储后端 | pi session-backends/、opencode SQLite（drizzle） | ✅ 2026-09 升级 SQLite（N4）：单文件 zmzai.db（会话+事件同库 WAL），首次自动导入旧 JSONL；租约恢复/跨重启 SSE 续传均基于此 |
| 远程协作 | codex collaboration-mode-templates、opencode slack/ | ❌ |

## 优先级路线图

**P0 — Harness 立身之本**
1. ~~MCP client~~ → **✅ 全完成（2026-08-27）**：stdio（NDJSON JSON-RPC）+ **streamable-http（单端点 POST、SSE/json 双应答形态、mcp-session-id 回传）+ sse 遗留传输（endpoint 握手、GET 流承载数据）**三种客户端与本地 fixture 测试全过；插件面板状态 UI。**P0 第 1 项无遗留。**
2. ~~git 工具集 + pty 交互终端~~ → **全部落地（2026-08-27）**：git 四件见上表；终端为框架 `core/tools/terminal.ts` 五工具（TerminalManager 环形缓冲 + 游标续读）+ 宿主后端动态探测 node-pty（真 PTY）/管道降级。**坑位记录：node-pty@1.1.0 prebuilds 的 spawn-helper 丢可执行位 → posix_spawnp failed，harness postinstall 脚本已固化修复；其 signal=0 需归一化为无信号；prebuilds 跨运行时（本地实测 Node 直接可用），打包 Electron 时如有 ABI 报错跑 `pnpm rebuild:native`**
3. ~~hooks 生命周期扩展点~~ → **2026-08-27 落地**（`core/runtime/lifecycle.ts` 四钩子 onRunStart/onBeforeToolCall/onAfterToolCall/onRunEnd；before 可拦截并反馈模型，钩子抛错只告警不中断；createServer/hooks 透传）
4. ~~websearch / apply_patch 工具补齐~~ → **2026-08-27 落地**（websearch：Tavily/Serper/DuckDuckGo-Lite 三后端自动选择、fetch/env 可注入零网络测试；apply_patch：统一 diff 多文件多 hunk 两阶段应用，走 workspace 门面出可回滚版本）

**P1 — 模型层扩展**
5. ~~多 provider 抽象（pi-ai 式统一层）+ 路由/降级~~ → **✅ 已落地**：`ModelProvider` 接口 + failover N 端点降级 + 设置页 UI（2026-09-02 闭环）
6. ~~本地模型（Ollama）接入，内测期零成本跑通~~ → **✅ 已落地**：Ollama `/api/tags` 探测 + 分流 + 设置页

**P2 — 平台化**
7. 把 Electron IPC 抽象成独立协议层（opencode protocol 思路），桌面/CLI/Web 共用 + headless 可编程
8. telemetry 契约 + evals 最小集

**P3 — 生态**
9. 插件市场（本地 catalog 起步）、会话快照/分享、SQLite 存储升级

## 2026-08-27 附带修复

- 安全：harness IPC 文件接口（listDir/readFile）增加 workspaceRoot 越界防护——渲染进程传 `../` 或绝对路径一律拒绝（引擎单测覆盖）
- 竞态：会话切换时历史转录载入与实时事件流的覆盖竞态改为缓冲合并（订阅先建立、转录就绪后按序并入）
- UX：消息区自动跟随滚动；prompt 后刷新会话元数据
- 基建：framework 三个测试文件里历史遗留的 `@/packages/...` 别名导入修正为相对路径（此前 typecheck 常红）

## 维护约定

- 框架改动必须：`corepack pnpm typecheck && test && build` 全绿后在 harness 里重跑 `pnpm install`（file: 依赖是安装期拷贝）→ harness typecheck/test/smoke。
- 本文档随路线图推进更新状态列，不另开 issue 清单。
