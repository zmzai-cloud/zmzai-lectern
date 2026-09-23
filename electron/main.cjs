// Lectern — Electron 壳（原 zmzai agent harness）
// Web / App 同构：App 与浏览器加载同一个 Next.js 页面（默认 127.0.0.1:3100）。
// 生产模式（打包后）：壳内自动拉起内嵌的 Next standalone 服务（node .next/standalone/server.js），
// 数据/工作区落到系统用户数据目录（asar 内只读，不能写相对路径）。
// dev 模式：等待外部 dev server（pnpm dev 的 next dev）就绪。
// 壳内不跑业务逻辑；本地引擎能力（MCP/终端/git，见 legacy/）保留为后续增强。

const { app, BrowserWindow, dialog, ipcMain, session, utilityProcess, Tray, globalShortcut, Notification, nativeImage, shell } = require("electron");
const updater = require("./updater.cjs");
const fs = require("node:fs");
const path = require("node:path");

// Explicit profile isolation for packaged-app QA; never migrate real user data into it.
const userDataOverride = process.env.LECTERN_USER_DATA_DIR;
if (userDataOverride) {
  if (!path.isAbsolute(userDataOverride)) throw new Error("LECTERN_USER_DATA_DIR must be absolute");
  fs.mkdirSync(userDataOverride, { recursive: true });
  app.setPath("userData", userDataOverride);
}

const WEB_PORT = Number(process.env.LECTERN_WEB_PORT ?? 3100);
const WEB_URL = (process.env.LECTERN_WEB_URL ?? `http://127.0.0.1:${WEB_PORT}`).replace(/\/$/, "");
// SSO 登录页（与 muzhi /login 同一跳转目标）：GitHub OAuth / 邮箱密码都在这里完成
const AUTH_SSO_URL = (process.env.AUTH_SSO_URL ?? "https://auth.zmzai.cloud").replace(/\/$/, "");
// 共享会话 cookie 名（zmzai-auth SESSION_COOKIE_NAME 默认值，种在 .zmzai.cloud 父域）
const AUTH_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? "muzhi_session";

let webProcess = null;
let tray = null;
let pollTimer = null;
let authWin = null;
let gracefulDone = false;
let webLogStream = null;

/** 内嵌服务日志落盘（可观测性）：utilityProcess 的 stdio 在打包后无处可去，
 *  用户报障时拿不到任何服务端堆栈（如 SQLite disk I/O error 只打 stderr）。
 *  统一写入 <userData>/logs/web.log，超 5MB 归档为 web.old.log。 */
function webLogWrite(line) {
  if (!webLogStream) return;
  try {
    webLogStream.write(`[${new Date().toISOString()}] ${line}`);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function openWebLog(userData) {
  const logDir = path.join(userData, "logs");
  const logPath = path.join(logDir, "web.log");
  try {
    fs.mkdirSync(logDir, { recursive: true });
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024) {
      fs.renameSync(logPath, path.join(logDir, "web.old.log"));
    }
    webLogStream = fs.createWriteStream(logPath, { flags: "a" });
    webLogWrite(
      `---- lectern v${app.getVersion()} · electron ${process.versions.electron} · node ${process.versions.node} · ${process.platform}-${process.arch} ----\n`,
    );
  } catch {
    webLogStream = null;
  }
  return logPath;
}

/** 创建菜单栏托盘（macOS）：图标 + 状态文字点（绿●运行中 / 黄◐等待授权），
 *  点击唤起/聚焦主窗。仅打包时创建（dev 下反复重建托盘体验差，
 *  LECTERN_TRAY=1 可强制开启调试）。 */
function createTray() {
  if (process.platform !== "darwin") return;
  if (!app.isPackaged && process.env.LECTERN_TRAY !== "1") return;
  // 云剪影 template 图标：菜单栏明暗模式自动反色（黑底 app 图标在深色菜单栏会隐形）。
  // 注意 build/ 不会整体进 bundle（只有 icon.icns），资产必须放 electron/assets/ 才能打包。
  const iconPath = path.join(__dirname, "assets", "trayTemplate.png");
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 })
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("Lectern");
  tray.on("click", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return createWindow();
    if (win.isVisible()) win.focus();
    else win.show();
  });
}

/** 托盘状态：轻量轮询 /api/sessions（5s），running→绿点、等待授权→黄点。
 *  macOS 菜单栏 title 是标准的状态指示方式（iTerm/Typescript playground 同款）。 */
function startTrayPolling() {
  if (!tray) return;
  clearInterval(pollTimer);
  const update = async () => {
    try {
      const res = await fetch(`${WEB_URL}/api/sessions`, { signal: AbortSignal.timeout(3000) });
      const sessions = res.ok ? await res.json() : [];
      const waiting = sessions.some((s) => s.status === "waiting_permission");
      const running = sessions.some((s) => s.running || s.status === "running");
      tray.setTitle(waiting ? "◐" : running ? "●" : "");
      tray.setToolTip(waiting ? "zmzai harness — 等待授权" : running ? "zmzai harness — 任务运行中" : "zmzai harness");
    } catch {
      tray.setTitle("");
    }
  };
  void update();
  pollTimer = setInterval(update, 5000);
}

/** 全局快捷键 ⌘⇧H：唤起/隐藏主窗（桌面端区别于网页的存在感所在）。 */
function registerGlobalShortcut() {
  if (process.platform !== "darwin") return;
  globalShortcut.register("CommandOrControl+Shift+H", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return createWindow();
    if (win.isVisible() && win.isFocused()) win.hide();
    else {
      win.show();
      win.focus();
    }
  });
}

/** 主进程任务完成通知（Electron 下 Web Notification 未聚焦时不可靠，走主进程）。
 *  渲染进程通过 lecternNative.notifyTaskDone() 桥接触发。 */
function notifyTaskDone() {
  if (!Notification.isSupported()) return;
  new Notification({ title: "zmzai harness", body: "任务已完成，回来看看结果" }).show();
}

/** SSO 登录子窗口：加载 auth.zmzai.cloud/login（GitHub OAuth / 邮箱密码）。
 *  登录成功后 auth 在默认 session 的 .zmzai.cloud 父域种下共享会话 cookie，
 *  cookieWatch 把值回传主窗口渲染层，经 /api/auth/ingest 落成 127.0.0.1 的
 *  host-only cookie（父域 cookie 对 localhost 不可见，必须中转一次）。 */
function openAuthWindow(mainWin) {
  if (authWin && !authWin.isDestroyed()) {
    authWin.focus();
    return;
  }
  authWin = new BrowserWindow({
    width: 480,
    height: 720,
    title: "zmzai 用户登录",
    backgroundColor: "#ffffff",
    parent: mainWin ?? undefined,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  authWin.setMenuBarVisibility(false);
  void authWin.loadURL(`${AUTH_SSO_URL}/login?next=${encodeURIComponent("https://muzhi.zmzai.cloud")}`);
  authWin.on("closed", () => {
    authWin = null;
  });
}

/** 归一化为渲染层/comed 端约定的载荷。
 *  Electron 的 Cookie.expirationDate 是**秒级** Unix 时间戳；session cookie 该字段
 *  缺失（或为 0），转成 null 交给服务端按 30 天兜底。上游有效期必须一路传到
 *  /api/auth/ingest，否则本地 cookie 会比服务端 session 活得更久，用户会看到
 *  「已登录但请求全被拒」的怪状态。 */
function toSsoPayload(cookie) {
  const raw = cookie && cookie.expirationDate;
  const expiresAt = typeof raw === "number" && raw > 0 ? raw : null;
  return { value: cookie.value, expiresAt };
}

/** 默认 session 里找已有的 .zmzai.cloud 共享会话 cookie（此前登录过的兜底）。 */
async function findSsoCookie() {
  try {
    const list = await session.defaultSession.cookies.get({ name: AUTH_COOKIE_NAME });
    const hit = list.find((c) => c.domain && c.domain.includes("zmzai.cloud"));
    return hit ? toSsoPayload(hit) : null;
  } catch {
    return null;
  }
}

/** 监听 cookie 变化：auth 窗完成登录（含 GitHub OAuth 回调）→ 立即回传并收窗。 */
function startCookieWatch() {
  session.defaultSession.cookies.on("changed", (_event, cookie, _cause, removed) => {
    if (removed) return;
    if (cookie.name !== AUTH_COOKIE_NAME) return;
    if (!cookie.domain || !cookie.domain.includes("zmzai.cloud")) return;
    // 本地 /api/auth/login 也会种同名 cookie，但域是 127.0.0.1，已被上面的域过滤排除
    if (authWin && !authWin.isDestroyed()) authWin.close();
    // 动态取主窗：窗口可能被关闭重建，固定引用会失效
    const mainWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(WEB_URL));
    mainWin?.webContents.send("auth:ssoCookie", toSsoPayload(cookie));
  });
}

/** 解析 .env 注入 process.env（已存在的环境变量优先）。standalone server 不保证读 .env，显式注入最稳。 */
function loadEnvFile() {
  if (app.isPackaged) {
    require("./release-defaults.cjs").applyReleaseDefaults(process.env);
    return;
  }
  try {
    const raw = fs.readFileSync(path.join(app.getAppPath(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
      }
    }
  } catch {
    /* 无 .env，忽略 */
  }
}

/** 目录里是否已有真实数据（不只是空壳或子目录）。用于判断"老数据目录要不要沿用"。 */
function hasLecternData(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".db") || name.endsWith(".jsonl")) return true;
      if (name === "settings.json" || name === "projects.json" || name === ".secret") return true;
      if (name === "projects" || name === "deliveries" || name === "plugins") return true;
    }
  } catch {
    /* 读不到就当作没数据 */
  }
  return false;
}

/** 解析最终数据目录（注入为 LECTERN_DATA_DIR，语义=终点，见 lib/runtime-constants.ts）。
 *  新装： <userData>/data（与 next dev 一致，两边共享同一份会话）。
 *  老版本（≤ v0.4.2）实际落在 <userData>/data/data —— 那时候注入值被当成"根"、
 *  内部又补了一级。这里探测到老目录有货而新目录为空时继续沿用老目录：
 *  老用户零迁移、零丢数据，连 .secret 里的个人 key 也不用重新配。
 *  两边都有货（既跑过 dev 又跑过老打包版）时取新目录并向日志告警，
 *  老目录内容不删，可用 scripts/migrate-data.mjs --from <老目录> 合并。 */
function resolveDataDir(userData) {
  const fresh = path.join(userData, "data");
  const legacy = path.join(fresh, "data");
  const legacyUsed = hasLecternData(legacy);
  if (!legacyUsed) return fresh;
  if (hasLecternData(fresh)) {
    console.warn(`[lectern] 检测到新旧两份数据目录，已使用 ${fresh}；${legacy} 保留未删，可用 scripts/migrate-data.mjs --from "${legacy}" 合并`);
    return fresh;
  }
  console.warn(`[lectern] 沿用旧版数据目录 ${legacy}（含历史会话与个人设置，未做任何搬迁）`);
  return legacy;
}

/** 生产模式：用 utilityProcess 拉起内嵌 Next.js standalone 服务（.next/standalone/server.js）。
 *  不用 spawn + ELECTRON_RUN_AS_NODE：Electron 35+ 起 run-as-node 子进程也会向
 *  LaunchServices 注册 Foreground app → Dock 每次多弹一个无图标的「exec」图标；
 *  utilityProcess 是 Utility 类型（BackgroundOnly），天然无 Dock/GUI。
 *  dev 跳过（外部 next dev）。 */
function ensureWebServer() {
  if (!app.isPackaged) return;
  const serverEntry = path.join(app.getAppPath(), ".next", "standalone", "server.js");
  if (!fs.existsSync(serverEntry)) {
    console.error(`[harness] 找不到 ${serverEntry}，打包内容不完整`);
    app.exit(1);
    return;
  }
  loadEnvFile();
  const userData = app.getPath("userData");
  const logPath = openWebLog(userData);
  const dataDir = resolveDataDir(userData);
  // asar 化后 serverEntry 落在 app.asar 内（虚拟目录），不能当进程工作目录：
  // libuv 的 chdir 不吃 Electron 的 fs 补丁，会直接 ENOTDIR 崩掉（server.js 里
  // 原有的 process.chdir 已由 scripts/patch-standalone-for-asar.mjs 摘掉）。
  // Windows cwd 必须与安装包同盘：Next 15 用 join(cwd, relative(cwd, dir))
  // 定位路由资源；跨盘 relative 返回 D:\... 绝对路径，join 却将其拼到 C:\...
  // 后面，触发 Invalid package / 首页 500。resourcesPath 是 asar 外真实目录。
  // cwd 只用于资源定位；数据、工作区、日志仍用下方显式注入的用户目录，
  // 不在 Program Files 等安装目录创建用户数据。macOS 保持原来的 cwd。
  const serverCwd = process.platform === "win32" ? process.resourcesPath : userData;
  fs.mkdirSync(userData, { recursive: true });
  // standalone server.js 不解析 -p 参数，端口走 PORT 环境变量
  ensureHostProcess(userData, dataDir);
  webProcess = utilityProcess.fork(serverEntry, [], {
    cwd: serverCwd,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(WEB_PORT),
      // M2c-S15：armed 默认化——GATEWAY 指向 Host 握手文件（Host 未启动或
      // LEGACY 模式时不注入，网关休眠走进程内 Runtime）
      ...(hostJsonPath && fs.existsSync(hostJsonPath) ? { LECTERN_HOST_GATEWAY: hostJsonPath, LECTERN_HOST_BOOTSTRAP: hostJsonPath } : {}),
      HOSTNAME: "127.0.0.1",
      // 会话与工作区必须显式落用户目录，不依赖服务 cwd 或安装目录可写性。
      // LECTERN_DATA_DIR / LECTERN_WORKSPACE 是 lib/runtime-constants 实际读取的变量；
      // ZMZAI_* 为兼容别名保留（勿只写 ZMZAI_*：旧版曾因此把数据写进 app 包内）
      // 注意：LECTERN_DATA_DIR 是**最终数据目录**而非"根"（runtime-constants 不再补拼
      // data）。老版本注入值被当成根→实际落在 <userData>/data/data，resolveDataDir()
      // 会探测并沿用，保证老用户数据不丢。
      ZMZAI_DATA_DIR: dataDir,
      LECTERN_DATA_DIR: dataDir,
      ZMZAI_WORKSPACE: path.join(userData, "workspace"),
      LECTERN_WORKSPACE: path.join(userData, "workspace"),
      // 日志目录显式注入：Next 侧 instrumentation.ts 的请求级日志要落到这里，
      // 与下方 stdio pipe 写的进程日志合流为同一个 <userData>/logs/web.log。
      // 必须注入：instrumentation 在未注入时从 dataDir 反推 ".."，而沿用旧版数据
      // 目录时 dataDir 是 <userData>/data/data，会偏到 <userData>/data/logs，
      // 与 Electron 侧的 <userData>/logs 分裂成两处，报障时容易只拿到一半。
      LECTERN_LOG_DIR: path.join(userData, "logs"),
    },
    // pipe：stdout/stderr 接入日志文件（打包后 inherit 无处可看，报障无凭据）
    stdio: "pipe",
  });
  webProcess.stdout?.on("data", (chunk) => webLogWrite(chunk));
  webProcess.stderr?.on("data", (chunk) => webLogWrite(chunk));
  webProcess.on("exit", (code) => {
    webLogWrite(`[web] 内嵌服务退出 code=${code}\n`);
    if (code !== 0 && !app.isQuitting) console.error(`[harness] 内嵌服务退出码 ${code}`);
  });
  console.log(`[lectern] 内嵌服务日志：${logPath}`);
}

/** M2c-S13：Host 进程（Lectern Host，spec §5）。生产模式下与 Next 并行 fork；
 *  dev 由 scripts/dev-host.sh 外部拉起（Main 不 fork，next dev 保持纯 UI 模式）。
 *  armed 注入：GATEWAY/BOOTSTRAP 指向 host.json → Next 网关默认走 Host；
 *  LECTERN_LEGACY_RUNTIME=1 时不注入（回滚逃生门，旧进程内 Runtime 服务）。
 *  重启护栏（spec §5.2）：异常退出 60s 窗口内最多 3 次，超限弹窗报障不循环。 */
let hostProcess = null;
let hostRestartTimes = [];
let hostJsonPath = "";
// V1-S3：浏览器 verifier endpoint（Electron 主进程自带 Chromium 驱动；
// bootstrap 文件 hostDataDir/verifier.json 与 host.json 同模式，Main fork
// Host 时注入 env；dev-host.sh 模式由脚本手动指向同一文件）
let verifierHandle = null;
let verifierJsonPath = "";

function ensureVerifierServer(hostDataDir) {
  try {
    const { startVerifierServer } = require("./verifier.cjs");
    startVerifierServer().then((handle) => {
      verifierHandle = handle;
      verifierJsonPath = path.join(hostDataDir, "verifier.json");
      fs.writeFileSync(verifierJsonPath, JSON.stringify({ port: handle.port, token: handle.token }, null, 2));
      console.log(`[lectern] verifier endpoint 127.0.0.1:${handle.port}`);
    }).catch((err) => {
      // 起不来不阻塞应用：Host 侧读不到 bootstrap → 验证 run 如实 unavailable
      console.error("[lectern] verifier 启动失败（浏览器验证将 unavailable）:", err?.message ?? err);
    });
  } catch (err) {
    console.error("[lectern] verifier 模块加载失败:", err?.message ?? err);
  }
}

function ensureHostProcess(userData, dataDir) {
  if (!app.isPackaged) return;
  if (process.env.LECTERN_LEGACY_RUNTIME === "1") {
    console.log("[lectern] LECTERN_LEGACY_RUNTIME=1：跳过 Host，走进程内 Runtime（回滚模式）");
    return;
  }
  const hostEntry = path.join(app.getAppPath(), "host", "dist", "host", "src", "index.js");
  if (!fs.existsSync(hostEntry)) {
    console.error(`[lectern] Host 入口缺失：${hostEntry}（打包内容不完整）`);
    return;
  }
  const hostDataDir = path.join(dataDir, "host");
  fs.mkdirSync(hostDataDir, { recursive: true });
  hostJsonPath = path.join(hostDataDir, "host.json");
  const hostLog = openWebLog(userData); // 复用 web 日志通道（合流 <userData>/logs/web.log）
  ensureVerifierServer(hostDataDir);
  spawnHost(hostEntry, hostDataDir, hostLog);
}

function spawnHost(hostEntry, hostDataDir, hostLog) {
  hostProcess = utilityProcess.fork(hostEntry, [], {
    cwd: hostDataDir,
    env: {
      ...process.env,
      LECTERN_HOST_DATA: hostDataDir,
      LECTERN_WORKSPACE: path.join(path.dirname(hostDataDir), "workspace"),
      // V1-S3：浏览器 verifier bootstrap（文件由 ensureVerifierServer 异步写；
      // Host 侧惰性读取，时序天然解耦）
      ...(verifierJsonPath && fs.existsSync(verifierJsonPath) ? { LECTERN_VERIFIER_BOOTSTRAP: verifierJsonPath } : {}),
    },
    stdio: "pipe",
  });
  hostProcess.stdout?.on("data", (chunk) => hostLog(chunk));
  hostProcess.stderr?.on("data", (chunk) => hostLog(chunk));
  hostProcess.on("exit", (code) => {
    hostLog(`[host] Host 退出 code=${code}\n`);
    if (code !== 0 && !app.isQuitting) restartHostGuarded(hostEntry, hostDataDir, hostLog);
  });
}

function restartHostGuarded(hostEntry, hostDataDir, hostLog) {
  const now = Date.now();
  hostRestartTimes = hostRestartTimes.filter((t) => now - t < 60_000);
  if (hostRestartTimes.length >= 3) {
    hostLog("[host] 60s 内异常退出已达 3 次，停止自动重启（spec §5.2）\n");
    const { dialog } = require("electron");
    dialog.showErrorBox("Lectern Host 故障", "Host 进程在 60 秒内异常退出 3 次，已停止自动重启。\n请查看日志后重启应用（<userData>/logs/web.log）。");
    return;
  }
  hostRestartTimes.push(now);
  hostLog(`[host] 异常退出，自动重启（第 ${hostRestartTimes.length}/3 次）\n`);
  spawnHost(hostEntry, hostDataDir, hostLog);
}

/** Host 有序停止：HTTP graceful（停新命令/收终端）→ 8s 兜底 SIGKILL。 */
async function stopHostProcess() {
  if (!hostProcess) return;
  try {
    const lock = fs.existsSync(hostJsonPath) ? JSON.parse(fs.readFileSync(hostJsonPath, "utf8")) : null;
    if (lock?.port && lock?.token) {
      await fetch(`http://127.0.0.1:${lock.port}/v1/shutdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${lock.token}` },
        signal: AbortSignal.timeout(8000),
      }).catch(() => undefined);
    }
  } catch { /* 尽力而为 */ }
  try { hostProcess.kill(); } catch { /* 已退出 */ }
  await new Promise((r) => setTimeout(r, 500));
  try { if (hostProcess?.pid) process.kill(hostProcess.pid, "SIGKILL"); } catch { /* 已退出 */ }
}

/** 等待 Next.js 就绪（dev 下 next dev 编译首屏较慢，最长等 120s）。 */
async function waitForWeb(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 404) return;
    } catch {
      /* 未就绪，继续轮询 */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`[harness] ${url} 在 ${timeoutMs}ms 内未就绪，退出`);
  app.exit(1);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#ffffff",
    title: "zmzai agent harness",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    // macOS 集成红绿灯；Windows/Linux 保留原生边框、窗口按钮与系统缩放行为。
    // 渲染层只为 darwin 预留红绿灯空间，Windows 的控件不与页面操作区重叠。
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 17 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  // ⌘W 在 Electron/macOS 默认会关闭整个 BrowserWindow。这里优先把它交给
  // 工作台处理（例如焦点在 xterm 时关闭当前 terminal tab）；即使当前区域没有
  // 可关闭对象，也不能意外退出整个 Lectern。
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (!(input.meta || input.control) || input.key.toLowerCase() !== "w") return;
    event.preventDefault();
    win.webContents.send("workbench:close-focused-pane");
  });
  void win.loadURL(WEB_URL);
}

app.whenReady().then(async () => {
  // 单实例锁：双开会让两个内嵌 server 抢 3100 端口与同一个 SQLite 库
  // （node:sqlite 并发打开同一 WAL 库会报 disk I/O error，全站 API 裸 500）。
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) createWindow();
    else {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  // 主进程兜底崩溃日志（与内嵌服务同文件，报障一并收集）
  process.on("uncaughtException", (err) => {
    webLogWrite(`[main] uncaughtException: ${err?.stack ?? err}\n`);
    console.error("[lectern] uncaughtException:", err);
  });
  // 原生文件夹选择对话框（preload 暴露为 window.lecternNative.pickFolder）
  ipcMain.handle("dialog:pickFolder", async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      title: "选择项目文件夹",
      properties: ["openDirectory"],
    });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  // 任务完成通知桥（preload 暴露为 window.lecternNative.notifyTaskDone）
  ipcMain.on("notify:taskDone", () => notifyTaskDone());

  // 打开内嵌服务日志目录（报障收集 web.log 用；web 端无此桥自动隐藏入口）
  ipcMain.handle("logs:open", async () => {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    await shell.openPath(logDir);
    return logDir;
  });
  ipcMain.handle("update:state", () => updater.getState());
  ipcMain.handle("update:check", () => updater.check());
  ipcMain.handle("update:download", () => updater.download());
  ipcMain.handle("update:install", () => updater.install());

  // SSO 登录桥：打开 auth 子窗口；若默认 session 已有共享会话 cookie 直接返回（免再登）
  ipcMain.handle("auth:openSSO", async (event) => {
    const mainWin = BrowserWindow.fromWebContents(event.sender);
    openAuthWindow(mainWin);
    return findSsoCookie();
  });

  // 品牌改名迁移（一次性）：productName 从 "zmzai Harness" 改为 "Lectern" 后，
  // userData 目录随之变化；若旧目录存在且新目录还没有会话库，整体搬过来。
  {
    const userData = app.getPath("userData");
    const legacy = path.join(path.dirname(userData), "zmzai Harness");
    if (!userDataOverride && path.resolve(legacy) !== path.resolve(userData) && fs.existsSync(legacy)
        && !fs.existsSync(path.join(userData, "zmzai.db"))) {
      try {
        fs.cpSync(legacy, userData, { recursive: true });
      } catch (e) {
        // 迁移失败不能阻断启动（应用本身仍可用），但必须留下明确线索：否则用户会
        // 以为「改名升级后历史会话全部丢失」，而实际上数据仍完整躺在旧目录里。
        console.error("[migrate] 旧会话库迁移失败，历史数据仍留在:", legacy, e);
      }
    }
  }

  ensureWebServer();
  await waitForWeb(WEB_URL);
  createWindow();
  createTray();
  startTrayPolling();
  registerGlobalShortcut();
  startCookieWatch();
  if (updater.configure()) setTimeout(() => void updater.check(), 10_000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", (event) => {
  app.isQuitting = true;
  clearInterval(pollTimer);
  globalShortcut.unregisterAll();
  // 优雅收尾（会话稳定性 P2）：先经 HTTP 让内嵌 server 中止 running 会话
  // （正常收尾链：tool parts 归 error、事件落库、lease 清除）+ checkpoint，
  // 再杀子进程。已收尾过（重复 before-quit）直接放行；服务未就绪/超时
  // 走兜底（kill），不阻塞退出。
  if (gracefulDone) return;
  event.preventDefault();
  void (async () => {
    try {
      const res = await fetch(`${WEB_URL}/api/shutdown/graceful`, {
        method: "POST",
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        console.log(`[lectern] 优雅收尾完成：abort ${body.aborted ?? 0} 会话 / checkpoint ${body.checkpointed ?? 0} 库`);
      }
    } catch (err) {
      // dev 下 next dev 可能已退 / 生产下 server 未就绪：静默降级为硬杀
      console.warn(`[lectern] 优雅收尾未完成，硬杀兜底：${err?.message ?? err}`);
    }
    gracefulDone = true;
    await stopHostProcess().catch(() => undefined);
    try {
      verifierHandle?.closeAll();
      verifierHandle?.server.close();
    } catch { /* 已关闭 */ }
    webProcess?.kill();
    app.exit(0);
  })();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
