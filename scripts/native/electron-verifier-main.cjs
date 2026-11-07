/** 原生验收用的独立 Electron 入口：只启动浏览器 verifier 服务（electron/verifier.cjs），
 *  不加载 Lectern 界面。隐藏 Dock 图标、userData 落临时目录，验证窗口均为
 *  show:false + 非持久 partition——不打扰用户桌面、不读写用户数据。
 *  env：LECTERN_VERIFIER_USERDATA（临时目录）、LECTERN_VERIFIER_BOOTSTRAP_OUT（写 {port,token}）、
 *  LECTERN_REPO_ROOT（仓库根，定位 verifier.cjs）。 */
const { app } = require("electron");
const { writeFileSync } = require("node:fs");
const path = require("node:path");

app.setPath("userData", process.env.LECTERN_VERIFIER_USERDATA);
if (app.dock) app.dock.hide();
app.on("window-all-closed", () => { /* 隐藏验证窗口关闭后保持服务 */ });
app.whenReady().then(async () => {
  const { startVerifierServer } = require(path.join(process.env.LECTERN_REPO_ROOT, "electron", "verifier.cjs"));
  const handle = await startVerifierServer();
  writeFileSync(process.env.LECTERN_VERIFIER_BOOTSTRAP_OUT, JSON.stringify({ port: handle.port, token: handle.token }), { mode: 0o600 });
});
