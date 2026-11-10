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

## 阶段 3：浏览器 / CUA（PC15–PC19）

### 盘点发现

- 两类能力都没有模型工具，模型无法调用 Host 能力（PC17 前提缺失）。
- F07 仍在：默认合成计划（goto + body）通过即 `ready_for_review`，smoke 被当成业务验收。
- **真实缺陷**：编排调用驱动时未传 `serviceOrigin`，真实 Electron 驱动下相对路由
  `goto "/"` 恒为 unavailable——浏览器验收在真实环境从未能打开被测页面（单测假驱动
  忽略该参数）。goto 失败后后续 DOM 步骤在 about:blank 上挂满 60s 通道超时。
- CUA：动作前不核对真实前台窗口；接管只有 API 无真实输入检测；进行中 osascript
  不可取消；重启后 executing 动作不对账；observe 与 act 未串行。

### 已实施（提交 21a89db、aa74dc3）

- CUA：观察后真实键鼠输入（HIDIdleTime）→ 租约暂停、动作不执行、须用户恢复；
  观察时窗口身份随动作下发，同一 AppleScript 内激活后、输入前核对真实前台窗口；
  紧急停止中止进行中 osascript（结果 unknown）；首次使用时对账遗留 executing；
  observe/act 同队列；无法识别用户输入时拒绝无人值守 acquire；`computer_use` 工具
  （身份取 ToolContext，acquire 与改界面动作需审批，仅 macOS 注册）。
- 浏览器：计划 smoke/acceptance 分级与守卫；smoke 通过返回 `smoke-only`；
  `browser_verify` 工具（acceptance 计划、结构化证据、按任务持久修复预算、源码
  变化自动新 attempt、run 需审批）；修复 serviceOrigin 漏传、required 不可用后
  中止本视口、verifier 未加载页面立即失败。

### 已验证

| 验收项 | 证据 | 层级 |
| --- | --- | --- |
| PC15 smoke 通过但表单失败 → 业务验收不通过；required 不降级 | `lib/browser-acceptance-p0.test.ts`（真实编排/计划/SQLite，可编程驱动） | 模块+装配 |
| PC16 真实浏览器：交互→失败证据→一次修复→重验 | `BROWSER_NATIVE_TEST=1 vitest run lib/browser-native.test.ts`：Electron 44 Chromium（隐藏窗口、临时 userData）在隔离 fixture 站点执行 表单提交/错误提示/路由 × 1280x800+390x844；首次 #result 断言在两视口失败并生成 2 张真实 PNG；真实修改 worktree 源码后重验 16 项 required 通过；新 SQLite 连接读回 runs=failed→passed、attempt=ready_for_review | 原生（macOS） |
| PC17 工具经 ToolDef 调用 broker；会话/租约越权拒绝 | `lib/computer-use-tool.test.ts`（真实 broker/服务/工具，平台 adapter 假件）：A 取得租约，B 借用 403 且动作未执行；takeover/resume 不对模型开放 | 装配 |
| PC18 同租约动作串行 | `lib/computer-use-service.test.ts`（并发两次 act，最大并发 1） | 模块 |
| PC18 真实窗口变化拒绝旧观察 | `CUA_NATIVE_TEST=1 vitest run lib/computer-use-native.test.ts`：Calculator 打开「关于」后，同一观察（TTL/revision 仍有效）的只读动作被窗口核对拦下并作废 | 原生（macOS） |
| PC18 用户接管 | 同上：观察后 1501ms 时 HID 空闲 250ms（真实人工输入）→ user-takeover、租约暂停、动作未执行 | 原生（macOS） |
| PC18/PC19 紧急停止、结果未知不盲重发、重启对账 | `lib/computer-use-p0.test.ts`（真实 broker + SQLite，adapter 假件）：停止中止在飞动作记 unknown、值不落库、撤租约后重发被拒；unknown 同目标重发被拒；遗留 executing 对账为 unknown 且幂等 | 模块 |
| 全量回归 | typecheck 0；arch 违规 0；`pnpm test` 77 文件 714 通过 5 跳过（跳过=原生门控）；test:release 111；host:build | — |

原生测试约束：只用 Calculator 菜单点击与读值，不发键盘输入；清理改为退出
Calculator（原用例向前台发 Escape，可能落到用户正在用的窗口，已改）。

### 未验证（明确记录）

- **真实模型**调用 `computer_use` / `browser_verify`：工具已注册，尚未有真实模型
  运行证据（并入 PC22 评测阶段）。
- 原生环境下紧急停止中止**真实进行中**的 osascript：只有假件证据。
- Host 进程在动作进行中被杀后的原生恢复：只有对账单元证据。
- 浏览器验证进行中 Next/Host 进程真实重启：只验证了结果持久化可由新连接读回。
- Windows：未运行；能力代码路径返回 unavailable，工具不注册。
- 安装包内（packaged）的浏览器/CUA 流程：待发行物验收阶段。

## 阶段 5（先于 4 执行）：发行物验收

### 已验证

| 检查 | 结果 |
| --- | --- |
| `NODE_OPTIONS=--max-old-space-size=6144 pnpm build` | 退出 0，real 486s（8.1 分钟）；日志 test-results/p0-release/build.log |
| `node scripts/check-standalone-clean.mjs` | 退出 0：无 .secret/会话库/本机数据，追踪图无越界 |
| `node scripts/native/armed-e2e.mjs`（打包 Host bundle + 生产构建 next start，隔离数据，relay 指向关闭端口） | **25/25**：会话建/列/改/删、窗口快照/用量/搜索/已读、全局搜索、fs 读写、git diff/检查点、预览字节、skills、plugins、repomap、交付概览、经网关 SSE 6ms 建立、事件 11ms 实时到达、优雅收尾在 Host 中止 1 个运行中会话并 checkpoint 2 库、Host 停止后 503 HOST_UNAVAILABLE 且命令带回 requestId |

### 端到端发现并修复（提交 5e9a533）

- **Host 崩溃**：`/api/repomap` 迁入 Host 后，框架 `resolveFrameworkVendorDirs` 拼出的嵌套
  wasm 路径不存在（pnpm 同级 / npm 去重扁平布局都不成立），emscripten 加载失败直接
  结束 Host 进程（exit 1）；该目录写入框架进程级全局，模型的 repo_map 工具同样受害。
  修复：`lib/repomap-vendor.ts` 按 Node 解析规则定位并核对 wasm 存在，不可用时面板 503、
  runtime 关闭 repo_map 能力。回归：`lib/repomap-vendor.test.ts`、生产装配 repomap 用例（Host 存活）。
- **SSE 延迟 15s**：Next/Node 等首个 body 块才发响应头，空闲会话首块是 15s 心跳
  （经网关实测 15008ms）。修复：开流即发注释帧（6ms）。进程内旧路径同样受益。

### 未验证 / 限制

- 安装包形态：standalone 依赖实体化（build-mac 的 `npm install`，需联网）与 asar 补丁未执行，
  端到端用 `next start` 运行同一生产构建产物；未生成 DMG、未启动安装后的桌面应用。
- Electron 主进程支持 `LECTERN_USER_DATA_DIR` 隔离 userData，可用于后续隔离启动桌面应用验收。
- 全量测试有一次运行在并发负载下 6 个计时敏感用例失败（实时推送 <600ms、SSE 重放、git
  序列），单独运行与再次全量运行均通过（78 文件 716 通过）。记为负载敏感，未改阈值。

## 阶段 4：PC22 真实模型评测（准备完成，待凭据）

- 已实施：`evals/harness/pc22-host-runner.mjs`（提交 373dc40），驱动打包 Host 进程走真实 runtime；
  before 版 Host bundle 由 c4febfb 构建（临时 worktree，未入库）用于前后对照。
- 已验证（dry-run，不调模型）：after 与 before 两版管线的会话创建、隔离副本、权限设置、
  浏览器驱动就绪；worktree 空改动合并被 `.lectern/verification.json` 组合验证拦下且目标未推进
  （PC13 语义在真实仓库可见）。
- 受阻：本机无可复用模型凭据（已安装 Lectern 的 settings.json 仅有 memoryInstallNonce，
  无个人 key；环境变量未设；登录 cookie 在 Chromium 加密库中，不读取）。需用户提供。
- 项目记忆类：无授权测试 bank，按规格不向真实记忆库写测试数据，记 blocked。

## 收尾：最终构建与复验（提交 3a2d7e1）

- 新发现并修复：Host 启动只回收已过期租约（10 分钟），强杀重启后会话最长约 10 分钟仍
  显示「执行中」。`host/src/lease-takeover.ts` 在持锁后、预热前把已死前任（`node:<pid>`
  且 pid 不存活）的未过期租约标为过期，交给框架官方扫描收尾；存活/非本机格式保守跳过。
  回归：`host/src/lease-takeover.test.ts`（真实 SQLite store/event log）。
- 最终生产构建：`NODE_OPTIONS=--max-old-space-size=6144 pnpm build` 退出 0，real 391s；
  `pnpm host:build` 通过；`check-standalone-clean` 退出 0。
- `node scripts/native/armed-e2e.mjs`（最终产物）：**28/28**。新增强杀重启阶段：运行中
  SIGKILL Host（running=true）→ Next 未重启 216ms 接上新 Host（读新握手）→ 遗留运行 1424ms
  收尾（中断事件 + running=false）。结果 JSON：test-results/p0-release/armed-e2e.json（本地，未入库）。
- 全量：typecheck 0；arch 迁移 37 / 豁免 16 / 违规 0；`pnpm test` 79 文件 717 通过 5 跳过
  （原生门控）；test:release 111；`git diff --check` 通过。

## 验收总表（本轮口径）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 上批合入 main | 已验证 | c4febfb，合并前分支全量复跑 |
| Host 迁移：改删/fs/git/delivery/预览/plugins/repomap/skills/搜索/关停 | 已验证 | 生产装配 13 项、网关 27 项、armed 端到端 |
| 读族归属修正（messages/search/usage/read-state/events） | 已验证 | 同上；live 推送 10–13ms |
| PC10/PC11（不回落、单 owner、重启） | 已验证（armed 进程级） | 端到端：Host 停止 503 带 requestId；强杀重启 Next 不重启接续 |
| PC13（组合验证失败不推进目标） | 已验证（管线级） | PC22 dry-run：空改动合并被 verification.json 拦下 |
| PC15 | 已验证（装配级） | browser-acceptance-p0 |
| PC16 | 已验证（原生 macOS） | browser-native：真实 Chromium 首败→修复→重验 |
| PC17 工具接线与越权 | 已验证（装配级） | computer-use-tool；**真实模型调用未验证（缺凭据）** |
| PC18 串行/窗口变化/接管 | 已验证（原生 macOS） | computer-use-native：窗口核对拦截、真实人工输入触发接管 |
| PC18/PC19 紧急停止/unknown/重启对账 | 部分 | 模块级（假 adapter + 真 broker/SQLite）；原生中止在飞 osascript 未验证 |
| PC19 Windows unavailable | 未验证 | 未在 Windows 运行，代码路径返回 unavailable |
| PC22 六类真实模型 ×3 + 前后对照 | **受阻** | 本机无可复用模型凭据；执行器与 before/after 管线 dry-run 已就绪 |
| P0-BLOCK-INPUT 严格格式复测 | **受阻** | 同上（并入 PC22 执行器，可直接复跑） |
| PC23 发行物一致 | 部分 | 生产构建 + 打包 Host bundle 端到端通过；DMG/实体化依赖/asar/安装后启动未执行 |

## PC22 解阻后的执行命令

```sh
# 凭据只经环境变量进入执行器进程（不落盘、不入结果）
LECTERN_EVAL_COOKIE="muzhi_session=…" node evals/harness/pc22-host-runner.mjs --samples 3
# 前后对照（before = 本轮开始时 main c4febfb；先在临时 worktree 构建其 Host bundle）
git worktree add --detach /tmp/lectern-before-c4febfb c4febfb && ln -s "$PWD/node_modules" /tmp/lectern-before-c4febfb/node_modules
(cd /tmp/lectern-before-c4febfb && node scripts/build-host.mjs)
LECTERN_EVAL_COOKIE="…" node evals/harness/pc22-host-runner.mjs --samples 3 --label before --host-bundle /tmp/lectern-before-c4febfb/host/dist/host/src/index.js
```

## 剩余缺口（未在本轮关闭）

- PC22 全部真实模型运行与失败归因（受阻：凭据）；项目记忆类另需授权测试 bank。
- 真实模型调用 computer_use / browser_verify 的证据（随 PC22）。
- multipart 附件上传仍在 Next 进程内；failover 日志 armed 下读 Next 空表（观测缺口）。
- 16 条命令/终端族 legacy 豁免待按服务化模式清零（S16）。
- 安装包（DMG）构建与安装后启动验收；Windows 全部平台项。
- 框架侧 `resolveFrameworkVendorDirs` 的嵌套路径假设应在 framework 修正（本轮在 Lectern 侧绕开）。

## 本轮提交（feat/p0-build-closure，均已本地合入 main）

e685612 Host 迁移与读族修正 · 21a89db CUA · aa74dc3 浏览器 · b3d481b 记录 · 5e9a533 wasm/SSE/端到端 ·
373dc40 PC22 执行器 · d0141eb 记录 · 3a2d7e1 租约接管

## 第四批：收尾与发行物链路（2026-11-09）

用户确认“直接干”。闸门不变：npm 发布 / 发版 / 推送需另行授权；PC22 等凭据（复核时
`~/.config/lectern-eval/cookie` 仍不存在）。

### 已实施

| 提交 | 内容 |
| --- | --- |
| 4d04552 | 只读模式拒绝清单补 `computer_use`、`browser_verify`（第三轮加工具时遗漏，readonly 会话可控制桌面/启动开发服务）；状态行动词补新工具。主题包 PermissionCard 对所有权限键本就显示英文裸键（仅 bash 有专属文案），非回归，未改主题包 |
| 框架 3227ee86（分支 fix/repomap-wasm-resolution） | 框架 **0.18.1**：`resolveFrameworkVendorDirs` 按 嵌套→scope 同级（pnpm）→祖先（npm 提升）逐候选并核对 wasm 存在，找不到仍抛错（签名不变）；新增导出 `resolveVendorDirsFrom`；加载失败统一 `WasmUnavailableError`，`renderRepoMap` 不再伪装成空地图；fs 工作区默认注册 repo_map 前探测资源 |
| 0247f99 | Lectern vendor 换 0.18.1 tarball（本地构建，**未发 npm**） |
| b17dd7a | 打包应用内 repo_map：主进程 fork Host 时注入 `LECTERN_REPOMAP_VENDOR`（指向 app.asar 内 standalone node_modules，照 node-pty 注入先例）；packaged 冒烟新增“写入代码文件后地图须解析出其符号” |
| 84e87e3 | 冒烟中 repo_map 步骤移到更新器小节之后（见下方发现） |

### 已验证

| 检查 | 结果 |
| --- | --- |
| 框架 `pnpm test` / `pnpm build` / `pnpm typecheck` | 62 文件 612 通过；构建、类型检查通过；新增布局测试 6 项（嵌套/pnpm/npm 提升/半残布局/全缺失/仓内真实布局） |
| Lectern typecheck / arch / test / test:release / host:build | 0 / 违规 0 / 81 文件 731 通过 5 跳过 / 111 / 通过 |
| 生产构建（vendor 0.18.1） + `armed-e2e.mjs` | 构建退出 0；**28/28** |
| `bash scripts/build-mac.sh`（两次，第二次含注入修复） | 退出 0：DMG/zip 各 217MB；standalone 清洁、asar 原生解包 5 个、ad-hoc 签名完整性、发布清单校验通过 |
| `pnpm test:packaged`（打包后的 Lectern.app，隔离 profile） | **14/14**（更正：此处原误写 15/15，提交 84e87e3 的说明同误）：启动与原生桥、Host 握手、带空格项目建会话、文件读写、真实 PTY+git、更新器（本地假源：自动下载/SHA-512/更新日志 hover/延迟安装）、**app.asar 内 repo_map 解析出夹具符号**、强杀后租约与运行中任务落盘、重启恢复、中断任务收敛为 waiting_input / blocked(unsafe_replay)、恢复卡片文案 |

### 发现

- **安装包内 repo_map 此前不可用**：首个安装包实测 `/api/repomap` 诚实 503（第三轮修复后不再崩溃，但定位不到资源）。wasm 在 `app.asar/.next/standalone/node_modules`，Host bundle 在 `app.asar/host/dist`，框架被 esbuild 打卷、cwd 是 hostData，任何自然解析都无从命中——已由 b17dd7a 修复并进冒烟回归。
- **界面小问题（未修，记录）**：工作区文件变更唤醒的文件监视器重渲染会打断正在显示的更新日志 hover 弹层（同构建 A/B 实测：去掉写文件步骤即通过）。真实场景：Agent 写文件时用户悬停更新图标，弹层可能被打断。
- 产物文件名仍为 0.18.0（版本号提升属于发版步骤），这批 DMG/zip **只用于本地验收，不可发布**。

### 仍在闸门内

- framework 0.18.1 发 npm、Lectern 0.19.0 版本号/更新日志/发版全链、推送 main：需用户授权。
- PC22 六类 ×3 + 前后对照：等凭据。
- 安装包内的浏览器验收与桌面控制：未在打包应用内实测（桌面控制需对该 ad-hoc 签名的应用单独授予辅助功能权限，不在验收里替用户授权）。

## 第五批：PI 运行时升级 0.84.1 → 1.5.0（2026-11-09）

依据：同日 PI 升级调研（上游 22 个版本、跨 1.0；框架 PI 用法面小）。闸门不变：
framework npm 发布与 Lectern 发版需授权。

### 已实施

| 提交 | 内容 |
| --- | --- |
| 框架 33d78c66（分支 feat/pi-1.5.0，基于 0.18.1 修复） | pi-agent-core / pi-ai 升 1.5.0，版本 **0.19.0**。迁移：`shouldStopAfterTurn` → `finishTurn`（先挡 error/aborted，保持旧钩子仅正常响应计数的语义）；自定义 streamFn 入参 `Context` → `TranscriptContext`；测试经 `getCurrentSystemPrompt` 读系统提示 |
| 同上 | **升级引入的回归 1**：pi ≥0.86 把系统提示+工具声明 unshift 成前导系统消息，run 收尾 `slice(baseline)` 整体左移一条，**记忆注入段混进 onRunEnd 的 newMessages 与总结素材**（框架测试 2 项抓到）。收尾按实际前导 system 数补偿 |
| 框架 6ec229d1 | **升级引入的回归 2**：`streamOneText` 给流函数传 `{systemPrompt, messages}` 并在调用方 `as never` 硬转——pi 1.x 只读前导系统消息，**会话总结与标题生成静默丢失系统提示**（类型检查只在 Lectern 侧暴露）。改经 `normalizeContext` 构造 transcript，签名对齐 pi `StreamFn`，加回归测试 |
| Lectern 9519e80 | vendor 0.19.0；**Lectern 直接依赖的 pi-ai 0.84.1 顶掉框架带的 1.5.0**（agent-core 1.5.0 配 pi-ai 0.84.1 版本劈叉，fixture faux 序列化崩溃、Host 路由测试 5 项挂起）——同步到 1.5.0；去掉 session-title 的过时强转 |

### 已验证

| 检查 | 结果 |
| --- | --- |
| 框架 typecheck / test / build | 0 / 62 文件 **613** 通过 / 通过 |
| Lectern typecheck / arch / test / test:release / host:build | 0 / 违规 0 / 81 文件 731 通过 5 跳过 / 111 / 通过 |
| 生产构建（PI 1.5.0） + `armed-e2e.mjs` | 退出 0（real 615s）；**28/28** |
| 安装包链路（build-mac + test:packaged） | 打包退出 0（依赖实体化从 npm 拉取 pi 1.5.0 与新增的 pi-schema，签名/asar/清单校验通过）；packaged 冒烟 **14/14**（含 app.asar 内 repo_map） |

### 升级带来、未单独验证的上游收益

流式工具参数 O(n²)→线性、网关瞬时错误重试扩充（含 Zhipu 1308 不再重试）、`durationMs`、
`Usage.cost.totalFromProvider`、输出预算 15% 预留、MCP 工具参数统一 coerce——均为上游行为，
本批只验证了“升级不破坏现有链路”，未做针对性压测（如 200KB 工具参数内存对比），
真实模型收益需 PC22 凭据到位后随评测观察。

### 尚未接入（需小开发，后续批次）

`thinkingLevel` 落消息、`onProviderStreamEvent` 观测、复用上游 `isRetryableAssistantError`/
`isContextOverflow` 替换框架自写的字符串匹配、`finishTurn`/`prepareRequest` 替换 drain/steering 链路、
会话中工具变更走 transcript（保 prompt cache）。

## 第六批：PI 1.5 能力接入·第一/二档（2026-11-10）

用户确认一二档全做。闸门不变（framework npm 发布 / Lectern 发版 / 推送 / PC22 凭据）。

### 已实施

| 提交 | 内容 |
| --- | --- |
| 框架 196c3a54（0.19.0，未发 npm） | ①投影：assistant 消息 info 与 step-finish 落 `durationMs`/`thinkingLevel`/`cost{total,totalFromProvider}`，工具完成/错误态落单调时钟执行耗时；②F6 重试判定新增 `upstreamRetryable`（pi-ai `isRetryableAssistantError` 优先，本地字符串列表兜底）；③`RunnerDeps`/`createServer` 新增 `onProviderStreamEvent` 透传（经 Agent 进流函数 options；`createAgentRuntime` 经既有 `runnerOptions` 全量透传自动获得） |
| Lectern 541eb57 | usage 端点聚合会话累计费用（providerReported 口径）+ Composer 费用展示；轮次时间线优先单调耗时；收尾区回显实际推理档位；provider 错误类原始流事件环形日志（50 条）随 `/api/settings/failover` 透出；PC22 执行器记 `cost`/`cost_provider_reported` |

**第二档迁移评估（决策=不迁）**：排队/steering 不迁 pi 内存队列——框架排队经 WorkflowStore 持久化（spec §4.2「内存队列仅缓存」），pi steering/followUp 是进程内 PendingMessageQueue 且语义为 run 中注入（框架为 run 间 drain）；迁移丢持久化契约。已采纳官方钩子：finishTurn（第五批）。

### 已验证

- 框架：typecheck 0；**620** 测试通过（+7：投影 3、上游重试分类 3、事件透传 1）；build 通过。
- Lectern：typecheck/arch(违规 0)/**731** 测试/test:release 111/host:build；生产构建退出 0（490s）；**armed 28/28**。
- 测试钉住的上游精度收益：`server_busy` 上游判可重试而本地列表不认；Zhipu `1308` 用量超限判不可重试。

### 待真实模型验证

费用/耗时/档位三者的**真实数值**需模型调用才会产生——armed 端到端用挂起假 relay（零模型调用），
只能验证字段链路不破坏既有契约。PC22 凭据到位后随评测一并观察（cost 从 null 变真值即为本批生效证据）。

## 第七批：界面与字体（2026-11-10）

用户要求「整体界面和字体优化一波」。约束沿用：@zmzai/theme 组件与视觉系统不动（纯白/墨黑/洋红点睛、IDE 密度），只做应用层。

### 已实施（0510f49）

- **字体自托管**（此前经 theme/fonts 从 jsDelivr CDN 加载——桌面离线字体失效、弱网首帧回退闪烁，且是全应用唯一外部资源依赖）：
  - MiSans 四字重 pyftsubset 子集化（Latin-1+通用标点+货币+箭头/几何+CJK 标点+假名+CJK 统一表意 U+4E00-9FFF 全保留+全角形式；区间外字符逐字回退 PingFang/雅黑），每字重切 **latin(~33KB)/CJK(3.5MB)** 两片，CJK 走 unicode-range 懒生效；
  - JetBrains Mono 400/700 本地（各 21KB）；**Noto Serif SC 停载**（全站无 font-serif 使用）；
  - 字族名与 theme `--font-sans/--font-mono` 栈一致，令牌零改动；layout 预加载 regular/medium latin 片。
  - 代价：仓库与安装包 +约 14MB（DMG 217→231MB）。
- **排版**：body `tabular-nums`（时间戳/token/费用数字纵向对齐，CJK 无影响）。
- **更新日志弹层修复**（第六批记录在案的界面缺陷）：可见性改 CSS `group-hover` 保活 + `data-open`（focus 键盘路径保留 state）——纯 state 在工作区文件变更触发重渲染时丢 hover 态。

### 已验证

| 检查 | 结果 |
| --- | --- |
| 全量回归 | typecheck 0；test 731；test:release 111；arch 违规 0 |
| 生产构建 | 退出 0（503s）；**构建产物 CSS 零 CDN/字体外链** |
| next start 实测 | /fonts/*.woff2 200；HTML 含两个 preload link |
| armed-e2e | 28/28 |
| DMG 打包 + packaged 冒烟 | 退出 0；standalone public/fonts 10 文件；**14/14**（含 changelog hover 断言） |

### 诚实口径

- 弹层修复的验证 = hover 断言通过 + CSS :hover 对重渲染免疫的结构保证；「写入文件与 hover 交错」的原始时序（第五批 A/B 复现场景）未单独重测——冒烟里该步已被移到更新器之后（84e87e3）。
- 字体观感（子集覆盖、字重渲染）属主观项，未做视觉截图评审；CJK 统一表意全保留，理论上无缺字，生僻扩展区按字形回退。
