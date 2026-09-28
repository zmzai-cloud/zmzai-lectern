const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the actual Electron launch options without starting a GUI. win32 path
// semantics reproduce Next's cross-volume relative() -> join() failure on any OS.
function launchOptions(platform, resources, userData, legacy = false) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const appPath = paths.join(resources, "app.asar");
  const serverEntry = paths.join(appPath, ".next", "standalone", "server.js");
  const oldData = paths.join(userData, "data", "data");
  const directoriesCreated = [];
  let launched;
  const electron = {
    app: {
      isPackaged: true,
      getAppPath: () => appPath,
      getPath: () => userData,
      getVersion: () => "0.5.1",
      whenReady: () => ({ then() {} }),
      on() {},
    },
    utilityProcess: { fork(entry, args, options) {
      launched = { entry, ...options };
      return { on() {} };
    } },
  };
  const fs = {
    existsSync: (p) => p === serverEntry || (legacy && p === oldData),
    readdirSync: () => ["zmzai.db"],
    mkdirSync: (p) => directoriesCreated.push(p),
    createWriteStream: () => ({ write() {} }),
  };
  const context = {
    require: (name) => {
      if (name === "electron") return electron;
      if (name === "node:fs") return fs;
      if (name === "node:path") return paths;
      if (name === "./updater.cjs") return {};
      // loadEnvFile 引入的发布默认值（纯 env 填充，无副作用）：真实模块直接可用。
      if (name === "./release-defaults.cjs") return require("./release-defaults.cjs");
      return require(name);
    },
    process: { platform, arch: "x64", resourcesPath: resources, env: {}, versions: {} },
    console: { log() {}, warn() {}, error() {} },
  };
  // ensureWebServer 自 0.10.0 (9831814) 起 async（fork 前有 await ensureHostProcess）；
  // vm 脚本最后表达式即其返回 promise，测试侧必须 await 后再断言 fork 选项。
  // launched 必须走 getter：异步化后 fork 发生在返回之后的微任务里，
  // 按值快照会永远拿到 undefined（旧同步版在 vm 执行期内 fork，无此问题）。
  const ready = vm.runInNewContext(readFileSync(path.join(__dirname, "main.cjs"), "utf8") + "\nensureWebServer();", context);
  return { get launched() { return launched; }, directoriesCreated, paths, ready };
}

for (const [name, platform, resources, userData, legacy] of [
  ["Windows C: profile and D: install with Chinese and spaces", "win32", String.raw`D:\工具\新建 文件夹\Lectern\resources`, String.raw`C:\Users\fixture\AppData\Roaming\zmzai-lectern`, false],
  ["Windows same-volume Program Files install", "win32", String.raw`C:\Program Files\Lectern\resources`, String.raw`C:\Users\fixture\AppData\Roaming\zmzai-lectern`, false],
  ["Windows UNC install and legacy data", "win32", String.raw`\\server\apps\Lectern\resources`, String.raw`C:\Users\fixture\AppData\Roaming\zmzai-lectern`, true],
  ["macOS preserves writable profile cwd", "darwin", "/Applications/Lectern.app/Contents/Resources", "/Users/fixture/Library/Application Support/zmzai-lectern", false],
]) {
  test(name, async () => {
    const result = launchOptions(platform, resources, userData, legacy);
    const p = result.paths;
    await result.ready;
    // 不可提前解构 launched：解构会在 await 前对 getter 求值（fork 尚未发生），
    // 拿到 undefined 快照。必须在 await 之后再读。
    const options = result.launched;
    const directoriesCreated = result.directoriesCreated;
    const projectDir = p.dirname(options.entry);
    // Next router-server computes relativeProjectDir, then RouteModule.prepare
    // joins it to cwd and reconstructs distDir to locate manifests/instrumentation.
    const relativeProjectDir = p.relative(options.cwd, projectDir);
    assert.equal(p.isAbsolute(relativeProjectDir), false, "Next must receive a relative project path");
    const resolvedProject = p.join(options.cwd, relativeProjectDir);
    assert.equal(resolvedProject, projectDir);
    const dist = p.join(projectDir, ".next");
    assert.equal(p.join(resolvedProject, p.relative(resolvedProject, dist)), dist);
    assert.ok(!options.cwd.includes("app.asar"), "cwd must be a real directory");
    assert.equal(options.env.LECTERN_DATA_DIR, p.join(userData, "data", ...(legacy ? ["data"] : [])));
    assert.equal(options.env.LECTERN_WORKSPACE, p.join(userData, "workspace"));
    assert.equal(options.env.LECTERN_LOG_DIR, p.join(userData, "logs"));
    assert.ok(directoriesCreated.every((dir) => dir === userData || dir.startsWith(userData + p.sep)), "Only profile directories may be created");
    if (platform === "darwin") assert.equal(options.cwd, userData);
  });
}
