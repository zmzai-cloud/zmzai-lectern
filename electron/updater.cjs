const { app, BrowserWindow, dialog } = require("electron");
const { mkdir, mkdtemp, open, rename, rm, unlink } = require("node:fs/promises");
const { existsSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { createReadStream } = require("node:fs");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { join, resolve } = require("node:path");
const { selectRelease } = require("./update-contract.cjs");
const RELEASE_HOST = "https://zmzai.oss-cn-beijing.aliyuncs.com/releases/harness";
let state = { status: "idle", version: null, percent: 0, error: null };
let release = null;
let downloaded = null;
let installing = false;
/** 手动确认过「重启并更新」：退出收尾后必须安装（不受 autoUpdate 开关限制）。 */
let installRequested = false;
/** 本次进程已拉起替换脚本：防止手动安装与退出安装各拉一次（双脚本互相 rm/mv）。 */
let installStarted = false;
let dataDir = null;
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

async function response(url, timeout) {
  const result = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeout), cache: "no-store" });
  if (!result.ok || !result.body) throw new Error(`更新服务请求失败 (${result.status})`);
  return result;
}
async function check() {
  if (!configure()) return publish({ status: "unavailable", error: "当前运行环境不支持更新" });
  if (["checking", "downloading", "ready"].includes(state.status)) return state;
  publish({ status: "checking", error: null });
  try {
    const result = await response(`${RELEASE_HOST}/latest-desktop.json`, 30000);
    const chunks = []; let size = 0;
    for await (const chunk of result.body) {
      size += chunk.length;
      if (size > 65536) throw new Error("更新清单过大");
      chunks.push(Buffer.from(chunk));
    }
    release = selectRelease(JSON.parse(Buffer.concat(chunks).toString("utf8")), app.getVersion(), process.platform, process.arch);
    const next = publish({ status: release ? "available" : "current", version: release?.version ?? app.getVersion(), percent: 0 });
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
async function download() {
  if (state.status !== "available") return state;
  publish({ status: "downloading", percent: 0, error: null });
  let partial;
  let downloadDir = null;
  try {
    const root = join(app.getPath("userData"), "updates");
    await mkdir(root, { recursive: true });
    downloadDir = await mkdtemp(join(root, "download-"));
    partial = join(downloadDir, "download.partial");
    const result = await response(`${RELEASE_HOST}/${release.path}`, 30 * 60 * 1000);
    const file = await open(partial, "wx", 0o600);
    let size = 0;
    try {
      for await (const chunk of result.body) {
        size += chunk.length;
        if (size > release.size) throw new Error("更新包大小超出清单");
        await file.writeFile(chunk);
        const percent = Math.floor(size / release.size * 100);
        if (percent !== state.percent) publish({ percent });
      }
    } finally { await file.close(); }
    await verify(partial, release);
    downloaded = join(downloadDir, release.name);
    await rename(partial, downloaded);
    return publish({ status: "ready", percent: 100 });
  } catch (error) {
    if (partial) await unlink(partial).catch(() => {});
    if (downloadDir) await rm(downloadDir, { recursive: true, force: true }).catch(() => {});
    return fail(error);
  }
}

/** mac 的 .app 安装根（execPath = Lectern.app/Contents/MacOS/Lectern，需退三级）。 */
function macAppRoot(execPath = process.execPath) {
  return resolve(execPath, "..", "..", "..");
}

/** 启动清理：
 *  - mac 旧版备份：能运行到这里即新版确认成功；新版起不来时备份仍在，可手动改回原名。
 *  - 下载目录：进程内状态不跨启动，残留包（含下载中断的半成品）只会占空间。 */
function cleanupOnStartup() {
  if (!app.isPackaged) return;
  if (process.platform === "darwin") {
    try {
      const backup = `${macAppRoot()}.old`;
      if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[updater] 清理旧版备份失败（不影响使用）：${error?.message ?? error}`);
    }
  }
  try {
    rmSync(join(app.getPath("userData"), "updates"), { recursive: true, force: true });
  } catch (error) {
    console.warn(`[updater] 清理旧更新包失败（不影响使用）：${error?.message ?? error}`);
  }
}

/** 执行替换（detached，宿主进程随后退出）。relaunch=true 仅用于用户确认过的
 *  「重启并更新」；用户主动退出触发的后台安装不重启应用，下次打开即新版。
 *  - mac：解压 ZIP → 核验解压产物 → 旧 .app rename 为 .old 备份 → 新 .app 就位
 *    （失败回滚）→ 按需 open。set -e 保证任何一步失败立即中止——**解压核验
 *    通过之前绝不动旧 app**（smoke 实测教训：假包解压失败若已 mv 旧 app，
 *    用户应用就没了）。安装包由 Node fetch 下载（无 quarantine 标记），替换后
 *    Gatekeeper 不拦。
 *  - win：安装器 /S 静默装回原路径 → 按需启动新 exe（同样无 Mark-of-the-Web）。 */
function performInstall({ relaunch = false } = {}) {
  if (process.platform === "darwin") {
    const root = macAppRoot();
    const script = [
      "set -e",
      "sleep 1",
      `rm -rf "${downloaded}.extract"`,
      `mkdir -p "${downloaded}.extract"`,
      `ditto -x -k "${downloaded}" "${downloaded}.extract"`,
      `test -d "${downloaded}.extract/Lectern.app"`,
      `rm -rf "${root}.old"`,
      `mv "${root}" "${root}.old"`,
      `if ! mv "${downloaded}.extract/Lectern.app" "${root}"; then mv "${root}.old" "${root}"; exit 1; fi`,
      ...(relaunch ? [`open "${root}"`] : []),
    ].join("\n");
    const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }
  const scriptPath = `${downloaded}.install.cmd`;
  writeFileSync(scriptPath, [
    "@echo off",
    "ping -n 3 127.0.0.1 >nul",
    `start /wait "" "${downloaded}" /S --updated`,
    ...(relaunch ? [`start "" "${process.execPath}"`] : []),
  ].join("\r\n") + "\r\n", { mode: 0o600 });
  const child = spawn("cmd.exe", ["/d", "/s", "/c", scriptPath], { detached: true, stdio: "ignore" });
  child.unref();
}

/** 手动「重启并更新」入口：一次确认（会退出应用、中止运行中任务），随后全自动。
 *  真正替换统一放到 before-quit 收尾链末尾执行：此时内嵌服务与任务已停，
 *  替换脚本不会和退出中的进程抢应用目录，也能被 installStarted 防重。 */
async function install() {
  if (state.status !== "ready" || !downloaded || installing) return false;
  installing = true;
  try {
    await verify(downloaded, release);
    const answer = await dialog.showMessageBox({
      type: "info", buttons: ["取消", "重启并更新"], defaultId: 0, cancelId: 0,
      message: `重启并更新到 Lectern ${state.version}？`,
      detail: process.platform === "darwin"
        ? "确认后自动替换应用并重启（保留一份旧版作回滚备份）。运行中的任务会被中止，请先保存工作。"
        : "确认后运行安装器静默升级并重启。运行中的任务会被中止，请先保存工作。",
    });
    if (answer.response !== 1) return false;
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
module.exports = { configure, check, download, install, installOnQuitIfReady, cleanupOnStartup, macAppRoot, setDataDir, getState, RELEASE_HOST };
