# Lectern（原 zmzai-harness）

> **Web / App 同构的 Agent 工作台**：浏览器（Web）与 Electron（App）加载同一套 Next.js 页面，推理走 relay 云端，执行在本机沙箱。

你给一句想法，内置编程智能体（`@zmzai/agent-framework`）在云端推理、在本机沙箱完成文件读写 / 命令执行 / git 操作并交付；旧版 Electron 本地引擎（MCP 等剩余能力）保留为 App 增强（见 `legacy/`）。

## 形态与同构架构

```
浏览器 (Web)  ─┐                    ┌─→ relay (relay.zmzai.cloud)  ─→  OpenAI 兼容模型
               ├─ HTTP / SSE ─→  Next.js (3100)      ─┤   （cookie 透传鉴权）
Electron (App) ┘  同一套页面           │
                                    └─→ muzhi (muzhi.zmzai.cloud)  登录 / 会话配额
```

- **一份代码，两个入口**：`app/` + `components/` + `lib/` 是唯一 UI；浏览器直接访问 `http://127.0.0.1:3100`，App 由 `electron/main.cjs` 壳加载同一 URL（`pnpm dev:app`）。页面完全一致，无需平台分支。
- **推理云端 + 执行本机**：服务端 `lib/runtime.ts` 跑 agent-framework 运行时（JSONL 会话存储 + 内存事件总线），推理全走 relay；登录 cookie 经 `AsyncLocalStorage` 请求级透传（`lib/request-cookie.ts`），模型目录由 relay 下发（默认 `deepseek-chat`）。执行环境为本机沙箱：builtin 文件工具（read/write/edit/glob/grep）直接落 `ZMZAI_WORKSPACE`（默认 `./.workspace`），bash 走本机子进程沙箱（程序白名单），git / 终端工具绑定本机工作区（与 legacy 引擎同策略）。
- **实时事件流**：`/api/sessions/[id]/events` SSE 推送（`session.status` / `message.part.delta` / 授权询问），UI 的 `client.subscribe` 订阅渲染，跨会话历史从 JSONL 转录恢复。
- **App 增强（后续）**：旧版 Electron 本地引擎（MCP 插件池等剩余能力）完整保留在 `legacy/`，通过 `window.lecternNative` 渐进增强接入（App 多入口、Web 隐藏），详见 `legacy/README.md`。
- **品牌图标**：**白底墨云**（底 `#FFFFFF`，云 `#111115`）。`app/icon.png`（512 满幅）供 Web favicon（Next 自动识别）；`build/icon.png`（512 满幅）供 Windows 安装器/任务栏与窗口图标（`electron/main.cjs`）；`build/icon-mac.png`（1024）供 dmg / `.app`——**必须是 824 居中的 macOS 网格版**，满幅会被系统自动套一圈白玻璃边框。托盘另有 `electron/assets/trayTemplate.png`（云剪影 template 图，系统按明暗自适应，与底色无关；放 `build/` 不会进 bundle）。三张位图同源于一份画，改一张要同步另两张。
- **桌面打包**：`pnpm build:mac` 产出 dmg/zip（arm64）；打包应用内嵌 Next standalone 服务（`electron/main.cjs` 自动拉起 `node .next/standalone/server.js`），会话与工作区落系统用户数据目录，双击即用。

## 能力一览

- **多 Agent**：agent 名来自 relay 模型目录（如 `deepseek-chat`）；工作区 `.zmzai/agents/*.md` 自定义 Agent 自动加载
- **权限与审批**：工具授权分类（读写/执行/联网/git/终端），「总是允许」沉淀规则，UI 内确认弹窗
- **本机沙箱执行**：bash 子进程沙箱（程序白名单 `EXEC_ALLOWED_PROGRAMS` 可配）+ 本机工作区文件工具，产物/版本可追溯（`file.edited` 事件 + `.fw-revisions.json`）
- **跨会话恢复**：JSONL 转录持久化（`data/`），重开会话完整还原历史 + 实时事件缓冲合并
- **登录**：`/login` 页 email+password → 代理 muzhi 登录（透传 `Set-Cookie`），`/api/auth/status` 校验会话

## 开发

```bash
corepack pnpm install        # 首次或 @zmzai/agent-framework / @zmzai/theme 更新后必跑（file: 依赖是安装期拷贝）
corepack pnpm dev            # Web（next dev -p 3100）+ Electron 壳 同时启动
corepack pnpm dev:web        # 仅浏览器模式 http://127.0.0.1:3100
corepack pnpm dev:app        # 仅 Electron 壳（自动等待 Web 就绪）
corepack pnpm typecheck      # tsc --noEmit
corepack pnpm test           # vitest 单测
corepack pnpm build          # next build（Electron 壳可加载生产构建）
corepack pnpm build:mac      # 打包 macOS dmg + zip（arm64，产物在 dist/）
```

### 环境（默认接正式环境）

`.env` 默认连正式环境（用户只有一个环境，dev 即用生产）：`OPENAI_BASE_URL=https://relay.zmzai.cloud/api/v1`（relay 推理/模型目录）+ `MUZHI_URL=https://muzhi.zmzai.cloud`（登录）。本地调试可切回 `http://127.0.0.1:3003` / `http://127.0.0.1:3000`（需自起 mongod 27017 / muzhi / relay）。会话持久化 `ZMZAI_DATA_DIR`（默认 `./.harness-data`）、Agent 工作区 `ZMZAI_WORKSPACE`（默认 `./.workspace`）；打包应用内两者自动重定向到系统用户数据目录。

### 发布（构建 → OSS 上传 → 直链）

1. `cp scripts/.env.release.example .env.release` 并填写 OSS 配置（bucket 保持私有，脚本按**对象级 public-read** 上传，直链不过期；KEY/SECRET 可复用 muzhi 的）
2. macOS：`bash scripts/release.sh`（构建 + 上传 + 生成 SHA256SUMS 与直链清单）；Windows：`powershell -File scripts\build-win.ps1 -Upload`
3. 上传完成后 `dist/release-links.md` 里有全部直链（`releases/harness/v<version>/…`），更新到 landing page 下载区
4. 辅助：`node scripts/upload-oss.mjs --dry` 只列清单不上传；`--skip-build` 补传现有产物

### macOS / Windows 打包

- **macOS**（scripts/build-mac.sh）：next build（standalone）→ 组装静态资源 → npm 实体化生产 node_modules（pnpm symlink / file: 依赖不可直接打包）→ electron-builder（无签名证书）→ ad-hoc 深度签名（`codesign --force --deep --sign -`，封印 Bundle 资源保证完整性校验通过）。产物：`dist/Lectern-0.3.0-arm64.dmg`（历史产物仍为 zmzai Harness-*） + zip（arm64）。
  - **下载后提示「已损坏，无法打开」**：未做 Developer ID 签名与公证，浏览器下载会带隔离标记，Gatekeeper 对未签名包直接判损坏（Apple Silicon 标准行为，包本身没坏）。解法：`xattr -cr "/Applications/Lectern.app"`（历史包路径为 `"/Applications/zmzai Harness.app"`）。彻底消除需付费 Apple Developer 账号做签名 + 公证。
- **Windows**（`pnpm build:win`，在 Windows 机器上跑）：同构流程（scripts/build-win.ps1），产物：NSIS 安装器 exe（可选安装目录 + 桌面快捷方式）+ zip（x64）。未签名，SmartScreen 首次运行提示「仍要运行」属预期。

## 相关仓库

`zmzai-agent`（agent-framework 核心）· `zmzai-relay`（模型目录/推理/计费）· `zmzai-theme`（设计系统三件套）。
