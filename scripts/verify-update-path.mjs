// 升级通道验收：已发布的旧版能否看到并拿到刚发布这一版。
//
// 为什么需要它：更新器是自研的（electron/updater.cjs + update-contract.cjs），
// 刻意不用 electron-updater —— updater.source-test.cjs 断言源码里不得出现
// quitAndInstall / autoUpdater / execSync / xattr。所以未签名不阻塞这条通道
// （macOS 把 ZIP 交给用户在 Finder 里手动替换，Windows 拉起安装器），
// 签名只影响用户手动安装时 Gatekeeper / SmartScreen 会不会拦。
//
// 相关但不同的另一件事：scripts/verify-public-release.mjs 回读线上产物哈希。
// 本脚本管「旧版能否发现新版」，它管「新版产物在线上是否完好」。发版后两个都要跑。
//
// 用法（在仓库根目录）：
//   node scripts/verify-update-path.mjs                  # 契约 + 真实 app 检查（默认 /Applications/Lectern.app）
//   node scripts/verify-update-path.mjs --download       # 额外真实下载产物并校验（约 210MB）
//   node scripts/verify-update-path.mjs --contract-only  # 只跑契约，不启动 GUI
//   node scripts/verify-update-path.mjs --app /path/to/Lectern.app
//
// 注意：本脚本依赖真实网络与「本机已装的旧版」，不进 CI。GUI 部分偶发
// 「Target page, context or browser has been closed」（Playwright 与 Electron 的
// 连接抖动，重试即可）；与大流量下载并行会显著提高失败率，别同时跑。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const HOST = "https://zmzai.oss-cn-beijing.aliyuncs.com/releases/harness";
const APP = opt("--app", "/Applications/Lectern.app");
const DO_DOWNLOAD = flag("--download");
const CONTRACT_ONLY = flag("--contract-only");

let failed = 0;
const check = (label, actual, wanted) => {
  const ok = actual === wanted;
  console.log(`  ${ok ? "✓" : "✗"} ${label}：${JSON.stringify(actual)}${ok ? "" : `（期望 ${JSON.stringify(wanted)}）`}`);
  if (!ok) failed++;
};
const checkThrows = (label, fn) => {
  try {
    console.log(`  ✗ ${label} → 未抛错，返回 ${JSON.stringify(fn())}`);
    failed++;
  } catch (e) {
    console.log(`  ✓ ${label} → 拒绝：${e.message}`);
  }
};

// ── 1. 线上清单 ────────────────────────────────────────────────────────────
console.log("① 拉取线上更新清单");
const response = await fetch(`${HOST}/latest-desktop.json`, { redirect: "error", cache: "no-store" });
assert.ok(response.ok, `清单请求失败 ${response.status}`);
const manifest = await response.json();
console.log(`  schema=${manifest.schema} version=${manifest.version}`);
assert.equal(manifest.schema, 1, "不支持的清单版本");

// ── 2. 契约：旧版能否选出这一版 ────────────────────────────────────────────
// 优先用被测 app 里**真实发布的那份** update-contract.cjs（用户手上就是它）；
// 取不到（没装、或 asar 工具不可用）再退回本仓源码。
console.log("\n② 契约验证：旧版能否选出这一版");
let contractPath = join(process.cwd(), "electron/update-contract.cjs");
let installedVersion = opt("--from", null);
let contractSource = "本仓源码";
try {
  const asar = require("@electron/asar");
  const archive = join(APP, "Contents/Resources/app.asar");
  const extracted = join(mkdtempSync(join(tmpdir(), "lectern-contract-")), "update-contract.cjs");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(extracted, asar.extractFile(archive, "electron/update-contract.cjs"));
  contractPath = extracted;
  contractSource = `app 包内（${APP}）`;
  if (!installedVersion) {
    const { execFileSync } = await import("node:child_process");
    installedVersion = execFileSync("/usr/libexec/PlistBuddy", [
      "-c", "Print :CFBundleShortVersionString", join(APP, "Contents/Info.plist"),
    ]).toString().trim();
  }
} catch (e) {
  console.log(`  · 未能从 app 取契约（${e.message.split("\n")[0]}），退回本仓源码`);
}
const { selectRelease } = require(contractPath);
assert.ok(installedVersion, "无法确定被测版本：装好旧版，或用 --from <version> 指定");
console.log(`  契约来源：${contractSource}`);
console.log(`  被测版本：${installedVersion} → 线上 ${manifest.version}`);
for (const [platform, arch, expectName] of [
  ["darwin", "arm64", `Lectern-${manifest.version}-arm64-mac.zip`],
  ["win32", "x64", `Lectern-Setup-${manifest.version}.exe`],
]) {
  check(`${platform}-${arch} 选中新版`, selectRelease(manifest, installedVersion, platform, arch)?.name, expectName);
}
check("同版本不再提示更新", selectRelease(manifest, manifest.version, "darwin", "arm64"), null);
check("更高版本不提降级", selectRelease(manifest, "99.0.0", "darwin", "arm64"), null);
checkThrows("未知架构被拒绝", () => selectRelease(manifest, installedVersion, "darwin", "x64"));

if (CONTRACT_ONLY) {
  console.log(`\n${failed === 0 ? "① ② 通过（未启动 GUI）" : `${failed} 条失败`}`);
  process.exit(failed === 0 ? 0 : 1);
}

// ── 3. GUI：真实 app 打真实网络 ────────────────────────────────────────────
console.log("\n③ 真实 app 触发真实检查（隔离 userData，不碰用户数据）");
const { _electron } = require("playwright");
const root = mkdtempSync(join(tmpdir(), "lectern-update-path-"));
const userData = join(root, "profile");
mkdirSync(join(root, "workspace"), { recursive: true });
const portServer = createServer();
await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
const port = portServer.address().port;
await new Promise((r) => portServer.close(r));

const env = {
  ...process.env,
  LECTERN_USER_DATA_DIR: userData,
  LECTERN_WORKSPACE: join(root, "workspace"),
  LECTERN_WEB_PORT: String(port),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_WEB_URL;
// 主进程用 Node 的 fetch（undici），本不读这些变量；显式删掉以排除环境干扰
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NODE_OPTIONS"]) delete env[k];

let desktop;
try {
  desktop = await _electron.launch({
    executablePath: join(APP, "Contents/MacOS/Lectern"),
    env, timeout: 90000, args: ["--no-sandbox", "--disable-gpu"],
  });
  const window = await desktop.firstWindow({ timeout: 90000 });
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(() => (document.body?.innerText ?? "").trim().length > 20, null, { timeout: 90000 });

  check("运行的版本", await desktop.evaluate(({ app }) => app.getVersion()), installedVersion);
  check("是打包版", await desktop.evaluate(({ app }) => app.isPackaged), true);
  check("userData 已隔离", await desktop.evaluate(({ app }) => app.getPath("userData")), userData);

  // 启动瞬间还没到自动检查的 10 秒；等过去之后状态应自己变成 available。
  // 这一跳是 electron/main.cjs 的 setTimeout(check, 10_000)，没有别的覆盖。
  console.log(`  启动瞬间 status = ${JSON.stringify((await window.evaluate(() => window.lecternNative.updateState())).status)}`);
  await new Promise((r) => setTimeout(r, 15000));
  const auto = await window.evaluate(() => window.lecternNative.updateState());
  console.log(`  15 秒后（启动自动检查）：${JSON.stringify(auto)}`);
  check("自动检查发现新版", auto.status, "available");
  check("自动检查报告版本", auto.version, manifest.version);
  check("自动检查无错误", auto.error, null);

  const manual = await window.evaluate(() => window.lecternNative.updateCheck());
  console.log(`  手动入口（preload updateCheck）：${JSON.stringify(manual)}`);
  check("手动检查 status", manual.status, "available");

  if (DO_DOWNLOAD) {
    console.log("\n④ 真实下载并校验（写到隔离 userData，不安装）");
    const key = `${process.platform}-${process.arch}`;
    const expected = manifest.platforms[key];
    assert.ok(expected, `清单里没有 ${key}`);
    const expectedName = process.platform === "darwin" && process.arch === "arm64"
      ? `Lectern-${manifest.version}-arm64-mac.zip`
      : `Lectern-Setup-${manifest.version}.exe`;
    const t0 = Date.now();
    const done = await window.evaluate(() => window.lecternNative.updateDownload());
    console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s → ${JSON.stringify(done)}`);
    check("下载后 status", done.status, "ready");
    check("进度 100%", done.percent, 100);
    check("下载无错误", done.error, null);
    // app.evaluate 的函数体里没有 require，改为在 node 侧读隔离目录
    const files = [];
    for (const dir of readdirSync(join(userData, "updates"))) {
      for (const f of readdirSync(join(userData, "updates", dir))) {
        files.push([f, statSync(join(userData, "updates", dir, f)).size]);
      }
    }
    console.log(`  落地：${JSON.stringify(files)}`);
    check("产物已落地且长度与清单一致", files.some(([n, s]) => s === expected.size && n === expectedName), true);
  }
} catch (e) {
  console.log(`\n执行失败：${e.message}`);
  console.log("提示：GUI 部分偶发连接抖动，重试一次；别与大批量下载并行。");
  failed++;
} finally {
  if (desktop) await desktop.close().catch(() => {});
}

console.log(`\n${failed === 0 ? `通过：${installedVersion} 能看到 ${manifest.version}` : `${failed} 条失败`}`);
process.exit(failed === 0 ? 0 : 1);
