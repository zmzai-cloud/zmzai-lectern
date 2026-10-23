const { app, BrowserWindow } = require("electron");
const { mkdir, open, rename, rm, stat, unlink } = require("node:fs/promises");
const { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { dirname, join, resolve } = require("node:path");
const { selectRelease } = require("./update-contract.cjs");

const RELEASE_HOST = "https://zmzai.oss-cn-beijing.aliyuncs.com/releases/harness";
const MANIFEST_ATTEMPTS = 3;
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_BASE_MS = Math.max(1, Number(process.env?.LECTERN_UPDATE_RETRY_MS) || 600);
const PARTIAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let state = { status: "idle", version: null, percent: 0, error: null, releaseNotes: null, installError: null };
let release = null;
let downloaded = null;
let installing = false;
/** 手动确认过「重启并更新」：退出收尾后必须安装（不受 autoUpdate 开关限制）。 */
let installRequested = false;
/** 本次进程已拉起替换脚本：防止手动安装与退出安装各拉一次（双脚本互相 rm/mv）。 */
let installStarted = false;
let dataDir = null;
let paused = false;
let downloadAbort = null;
let downloadJob = null;

function publish(next) {
  state = { ...state, ...next };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("update:status", state);
  }
  return state;
}
function configure() {
  return app.isPackaged && ((process.platform === "darwin" && process.arch === "arm64") || (process.platform === "win32" && process.arch === "x64"));
}
function fail(error) { return publish({ status: "error", error: error?.message ?? String(error) }); }
function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }

/** main 进程注入数据目录（settings.json 所在地），用于读取自动更新偏好。 */
function setDataDir(dir) { dataDir = dir; }

/** 自动更新偏好（settings.json 的 autoUpdate，缺省开启）。读不到按开处理：
 *  宁可多下一次安装包，也不让"用户以为开了"静默失效。 */
function autoUpdateEnabled() {
  if (!dataDir) return true;
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    return raw.autoUpdate !== false;
  } catch { return true; }
}

function updatesRoot() { return join(app.getPath("userData"), "updates"); }
function installResultPath() { return join(updatesRoot(), "last-install.txt"); }
function installLogPath() { return join(app.getPath("userData"), "logs", "update-install.log"); }

function isRetryable(error) {
  const status = error?.status;
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

/** 清单请求带有限重试：断网/5xx 重试，404 等确定性错误立即失败。 */
async function request(url, timeout) {
  let lastError;
  for (let attempt = 0; attempt < MANIFEST_ATTEMPTS; attempt++) {
    try {
      const result = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeout), cache: "no-store" });
      if (!result.ok || !result.body) {
        const error = new Error(`更新服务请求失败 (${result.status})`);
        error.status = result.status;
        throw error;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt + 1 === MANIFEST_ATTEMPTS) break;
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }
  throw lastError;
}

async function check() {
  if (!configure()) return publish({ status: "unavailable", error: "当前运行环境不支持更新" });
  if (["checking", "downloading", "paused", "ready"].includes(state.status)) return state;
  publish({ status: "checking", error: null });
  try {
    const result = await request(`${RELEASE_HOST}/latest-desktop.json`, 30000);
    const chunks = []; let size = 0;
    for await (const chunk of result.body) {
      size += chunk.length;
      if (size > 65536) throw new Error("更新清单过大");
      chunks.push(Buffer.from(chunk));
    }
    release = selectRelease(JSON.parse(Buffer.concat(chunks).toString("utf8")), app.getVersion(), process.platform, process.arch);
    const next = publish({
      status: release ? "available" : "current",
      version: release?.version ?? app.getVersion(),
      percent: 0,
      error: null,
      releaseNotes: release?.releaseNotes ?? null,
    });
    // 自动更新第一级：检查到新版即静默后台下载（不打扰；下载不中止任务，
    // 重启安装才需要用户确认/空闲）。关闭偏好时退回手动下载。
    if (release && autoUpdateEnabled()) void download();
    return next;
  } catch (error) { return fail(error); }
}

async function verify(file, artifact) {
  const hash = createHash("sha512"); let size = 0;
  for await (const chunk of createReadStream(file)) { size += chunk.length; hash.update(chunk); }
  if (size !== artifact.size || hash.digest("base64") !== artifact.sha512) throw new Error("更新包校验失败，请重新下载");
}

async function fileSize(file) {
  try { return (await stat(file)).size; } catch { return 0; }
}

function percentOf(size) {
  return Math.max(0, Math.min(99, Math.floor(size / release.size * 100)));
}

/** 分段写入一个下载源。offset 是磁盘上已有的字节数；服务端不支持 Range 时
 *  从头覆盖。返回写完后的总字节数。调用方负责最终哈希校验。 */
async function fetchInto(url, partialPath, offset) {
  const controller = new AbortController();
  downloadAbort = controller;
  const timer = setTimeout(() => controller.abort(new Error("下载超时")), 30 * 60 * 1000);
  let file;
  try {
    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
    const result = await fetch(url, { redirect: "error", cache: "no-store", headers, signal: controller.signal });
    if (result.status === 416 && offset > 0) {
      const size = await fileSize(partialPath);
      if (size === release.size) return size;
      // 服务端认为 Range 无效且本地并不是完整包：丢掉残片从头再来一次，
      // 这不该计入「校验失败」次数。
      await unlink(partialPath).catch(() => {});
      return fetchInto(url, partialPath, 0);
    }
    if (!result.ok || !result.body) {
      const error = new Error(`下载源请求失败 (${result.status})`);
      error.status = result.status;
      throw error;
    }
    let start = offset;
    if (result.status === 206) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(result.headers.get("content-range") ?? "");
      if (!match || Number(match[1]) !== offset || Number(match[3]) !== release.size) {
        throw new Error("下载源返回的分段范围无效");
      }
      start = offset;
    } else if (result.status === 200) {
      start = 0;
    } else {
      throw new Error(`下载源返回了意外的状态 (${result.status})`);
    }
    file = await open(partialPath, start > 0 ? "a" : "w", 0o600);
    let received = 0;
    for await (const chunk of result.body) {
      if (paused) { controller.abort(); throw new Error("下载已暂停"); }
      received += chunk.length;
      if (start + received > release.size) throw new Error("更新包大小超出清单");
      await file.writeFile(chunk);
      const percent = percentOf(start + received);
      if (percent !== state.percent) publish({ percent });
    }
    const total = start + received;
    if (total !== release.size) throw new Error(`下载不完整（${total}/${release.size}），将续传`);
    return total;
  } finally {
    clearTimeout(timer);
    if (file) await file.close().catch(() => {});
    if (downloadAbort === controller) downloadAbort = null;
  }
}

async function runDownload() {
  const dir = join(updatesRoot(), `v${release.version}`);
  const partial = join(dir, `${release.name}.partial`);
  const finalPath = join(dir, release.name);
  let offset = 0;
  let hashFailures = 0;
  let lastError = new Error("下载失败");
  /** 暂停时以磁盘上已落盘字节为准——fetchInto 抛错前返回不了 offset。 */
  const publishPaused = async () => publish({ status: "paused", percent: percentOf(await fileSize(partial)), error: null });
  try {
    await mkdir(dir, { recursive: true });
    offset = await fileSize(partial);
    if (offset > release.size) { await unlink(partial).catch(() => {}); offset = 0; }
    if (offset === release.size) {
      try {
        await verify(partial, release);
        downloaded = finalPath;
        await rm(finalPath, { force: true });
        await rename(partial, finalPath);
        return publish({ status: "ready", percent: 100, error: null });
      } catch {
        offset = 0;
        await unlink(partial).catch(() => {});
      }
    }
    publish({ status: "downloading", percent: percentOf(offset), error: null });
    for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
      if (paused) return publishPaused();
      const sources = [`${RELEASE_HOST}/${release.path}`, ...release.mirrors];
      for (const url of sources) {
        try {
          offset = await fetchInto(url, partial, offset);
          try {
            await verify(partial, release);
          } catch {
            hashFailures += 1;
            await unlink(partial).catch(() => {});
            offset = 0;
            throw new Error(hashFailures >= 2 ? "更新包校验失败，请稍后重试或手动下载安装包" : "更新包校验失败，正在重新下载");
          }
          if (paused) return publishPaused();
          downloaded = finalPath;
          await rm(finalPath, { force: true });
          await rename(partial, finalPath);
          return publish({ status: "ready", percent: 100, error: null });
        } catch (error) {
          lastError = error;
          if (paused) return publishPaused();
          if (hashFailures >= 2) throw error;
          offset = await fileSize(partial);
          if (offset >= release.size) { await unlink(partial).catch(() => {}); offset = 0; }
          await sleep(RETRY_BASE_MS * 2 ** Math.min(attempt, 3));
        }
      }
    }
    throw lastError;
  } catch (error) {
    if (paused) return publishPaused();
    return fail(error);
  }
}

async function download() {
  if (!release || state.version !== release.version) return state;
  if (!["available", "paused", "error"].includes(state.status)) return state;
  if (downloadJob) return downloadJob;
  paused = false;
  downloadJob = runDownload().finally(() => { downloadJob = null; downloadAbort = null; });
  return downloadJob;
}

/** 暂停只中止当前网络请求；已写入的 .partial 留给下次续传。 */
function pause() {
  if (state.status !== "downloading") return state;
  paused = true;
  downloadAbort?.abort();
  return publish({ status: "paused", error: null });
}

/** mac 的 .app 安装根（execPath = Lectern.app/Contents/MacOS/Lectern，需退三级）。 */
function macAppRoot(execPath = process.execPath) {
  return resolve(execPath, "..", "..", "..");
}

function installErrorMessage(code) {
  const detail = {
    1: "安装未完成",
    2: "安装程序未找到",
    5: "没有权限写入安装目录，请以管理员身份运行 Lectern 后重试",
    32: "安装目录被占用，请先完全退出 Lectern 再重试",
    112: "磁盘空间不足",
    1223: "你取消了系统安装确认",
  }[code];
  const suffix = `诊断日志：${installLogPath()}`;
  return detail ? `${detail}（退出码 ${code}）。${suffix}` : `更新安装失败（退出码 ${code}）。${suffix}`;
}

/** 替换脚本在退出后才运行，失败信息只能留给下一次启动读。 */
function readInstallResult() {
  const file = installResultPath();
  let raw;
  try { raw = readFileSync(file, "utf8").trim(); } catch { return; }
  rmSync(file, { force: true });
  const [status, version, code] = raw.split(/\s+/);
  if (status === "fail") {
    state.installError = installErrorMessage(Number(code));
  } else if (status === "ok" && version && app.getVersion() !== version) {
    state.installError = `更新 v${version} 已下载，但当前仍运行 v${app.getVersion()}。${installErrorMessage(1)}`;
  }
}

/** 启动清理：
 *  - mac 旧版备份：能运行到这里即新版确认成功；新版起不来时备份仍在，可手动改回原名。
 *  - 下载目录：保留 7 天内的 .partial 供断点续传，删除已完整的包（进程内状态不跨启动，
 *    没有清单指纹的完整包无法安全复用）与过期残留。 */
function cleanupOnStartup() {
  if (!app.isPackaged) return;
  readInstallResult();
  if (process.platform === "darwin") {
    try {
      const backup = `${macAppRoot()}.old`;
      if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[updater] 清理旧版备份失败（不影响使用）：${error?.message ?? error}`);
    }
  }
  const root = updatesRoot();
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const age = Date.now() - statSync(dir).mtimeMs;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".partial")) rmSync(join(dir, file), { force: true });
      }
      if (age > PARTIAL_MAX_AGE_MS || readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn(`[updater] 清理旧更新包失败（不影响使用）：${error?.message ?? error}`);
  }
}

function shq(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function winq(value) { return `"${String(value)}"`; }

/** 执行替换（detached，宿主进程随后退出）。relaunch=true 仅用于用户确认过的
 *  「重启并更新」；用户主动退出触发的后台安装不重启应用，下次打开即新版。
 *  - mac：解压 ZIP → 核验解压产物 → 旧 .app rename 为 .old 备份 → 新 .app 就位
 *    （失败回滚）→ 按需 open。子 shell set -e 保证任何一步失败立即中止——解压
 *    核验通过之前绝不动旧 app。结果写 last-install.txt / logs/update-install.log，
 *    下次启动据此提示失败原因。
 *  - win：安装器 /S 静默装回原路径，记录退出码；成功才按需启动新 exe。 */
function performInstall({ relaunch = false } = {}) {
  mkdirSync(updatesRoot(), { recursive: true });
  mkdirSync(dirname(installLogPath()), { recursive: true });
  if (process.platform === "darwin") {
    const root = macAppRoot();
    const steps = [
      "set -e",
      `rm -rf ${shq(`${downloaded}.extract`)}`,
      `mkdir -p ${shq(`${downloaded}.extract`)}`,
      `ditto -x -k ${shq(downloaded)} ${shq(`${downloaded}.extract`)}`,
      `test -d ${shq(`${downloaded}.extract/Lectern.app`)}`,
      `rm -rf ${shq(`${root}.old`)}`,
      `mv ${shq(root)} ${shq(`${root}.old`)}`,
      `if ! mv ${shq(`${downloaded}.extract/Lectern.app`)} ${shq(root)}; then mv ${shq(`${root}.old`)} ${shq(root)}; exit 1; fi`,
    ];
    const script = [
      "sleep 1",
      `( ${steps.join("; ")} ) >> ${shq(installLogPath())} 2>&1`,
      "code=$?",
      `if [ "$code" -eq 0 ]; then echo "ok ${release.version}" > ${shq(installResultPath())}; else echo "fail ${release.version} $code" > ${shq(installResultPath())}; fi`,
      ...(relaunch ? [`[ "$code" -eq 0 ] && open ${shq(root)}`] : []),
      "exit \"$code\"",
    ].join("\n");
    const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }
  const scriptPath = `${downloaded}.install.cmd`;
  const relaunchLine = relaunch ? [`if "%CODE%"=="0" start "" ${winq(process.execPath)}`] : [];
  writeFileSync(scriptPath, [
    "@echo off",
    "ping -n 3 127.0.0.1 >nul",
    `${winq(downloaded)} /S --updated >> ${winq(installLogPath())} 2>&1`,
    "set CODE=%ERRORLEVEL%",
    `if "%CODE%"=="0" (echo ok ${release.version})>${winq(installResultPath())} else (echo fail ${release.version} %CODE%)>${winq(installResultPath())}`,
    ...relaunchLine,
    "exit /b %CODE%",
  ].join("\r\n") + "\r\n", { mode: 0o600 });
  const child = spawn("cmd.exe", ["/d", "/s", "/c", scriptPath], { detached: true, stdio: "ignore" });
  child.unref();
}

/** 手动「重启并更新」入口：确认框在渲染层（应用内 Dialog），这里只做最终校验。
 *  真正替换统一放到 before-quit 收尾链末尾执行：此时内嵌服务与任务已停，
 *  替换脚本不会和退出中的进程抢应用目录，也能被 installStarted 防重。 */
async function install() {
  if (state.status !== "ready" || !downloaded || installing) return false;
  installing = true;
  try {
    await verify(downloaded, release);
    installRequested = true;
    app.quit();
    return true;
  } catch (error) { fail(error); return false; }
  finally { installing = false; }
}

/** 退出时安装（第二级，无对话框）：手动确认过，或用户开启了自动更新且主动退出。
 *  由 main 的收尾链在子进程全部停止后调用；失败不阻塞退出。
 *  只拉起一次替换脚本；手动更新时脚本负责重启，自动更新不重启（下次打开即新版）。 */
async function installOnQuitIfReady() {
  if (installStarted) return false;
  if (state.status !== "ready" || !downloaded || installing) return false;
  if (!installRequested && !autoUpdateEnabled()) return false;
  installing = true;
  try {
    await verify(downloaded, release);
    installStarted = true;
    performInstall({ relaunch: installRequested });
    return true;
  } catch (error) {
    console.warn(`[updater] 退出时安装未执行：${error?.message ?? error}`);
    installing = false;
    return false;
  }
}

function getState() { return state; }
module.exports = {
  configure, check, download, pause, install, installOnQuitIfReady, cleanupOnStartup,
  macAppRoot, setDataDir, getState, RELEASE_HOST,
};
