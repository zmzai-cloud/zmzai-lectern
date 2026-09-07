const { app, BrowserWindow, dialog, shell } = require("electron");
const { mkdir, mkdtemp, open, rename, unlink } = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { createHash } = require("node:crypto");
const { join } = require("node:path");
const { selectRelease } = require("./update-contract.cjs");
const RELEASE_HOST = "https://zmzai.oss-cn-beijing.aliyuncs.com/releases/harness";
let state = { status: "idle", version: null, percent: 0, error: null };
let release = null;
let downloaded = null;
let installing = false;
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
    return publish({ status: release ? "available" : "current", version: release?.version ?? app.getVersion(), percent: 0 });
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
  try {
    const root = join(app.getPath("userData"), "updates");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "download-"));
    partial = join(dir, "download.partial");
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
    downloaded = join(dir, release.name);
    await rename(partial, downloaded);
    return publish({ status: "ready", percent: 100 });
  } catch (error) {
    if (partial) await unlink(partial).catch(() => {});
    return fail(error);
  }
}
async function install() {
  if (state.status !== "ready" || !downloaded || installing) return false;
  installing = true;
  try {
    const mac = process.platform === "darwin";
    const answer = await dialog.showMessageBox({
      type: "info", buttons: ["取消", mac ? "在 Finder 中显示" : "启动安装器"], defaultId: 0, cancelId: 0,
      message: `Lectern ${state.version} 已下载`,
      detail: mac
        ? "请先结束运行中的任务并退出 Lectern，再解压 ZIP，将 Lectern.app 替换到原安装位置。不会删除会话和设置。此版本没有 Developer ID 签名或公证，系统可能阻止打开；不会自动绕过系统安全检查。"
        : "请先结束运行中的任务。确认后会启动安装器并退出 Lectern，请安装到原位置以升级。会话和设置保留。此版本未签名，Windows 可能显示安全提示。",
    });
    if (answer.response !== 1) return false;
    await verify(downloaded, release);
    if (mac) shell.showItemInFolder(downloaded);
    else {
      const error = await shell.openPath(downloaded);
      if (error) throw new Error(error);
      app.quit();
    }
    return true;
  } catch (error) { fail(error); return false; }
  finally { installing = false; }
}
function getState() { return state; }
module.exports = { configure, check, download, install, getState, RELEASE_HOST };
