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
      return require(name);
    },
    process: { platform, arch: "x64", resourcesPath: resources, env: {}, versions: {} },
    console: { log() {}, warn() {} },
  };
  vm.runInNewContext(readFileSync(path.join(__dirname, "main.cjs"), "utf8") + "\nensureWebServer();", context);
  return { launched, directoriesCreated, paths };
}

for (const [name, platform, resources, userData, legacy] of [
  ["Windows C: profile and D: install with Chinese and spaces", "win32", String.raw`D:\工具\新建 文件夹\Lectern\resources`, String.raw`C:\Users\fixture\AppData\Roaming\zmzai-lectern`, false],
  ["Windows same-volume Program Files install", "win32", String.raw`C:\Program Files\Lectern\resources`, String.raw`C:\Users\fixture\AppData\Roaming\zmzai-lectern`, false],
  ["Windows UNC install and legacy data", "win32", String.raw`\\server\apps\Lectern\resources`, String.raw`C:\Users\fixture\AppData\Roaming\zmzai-lectern`, true],
  ["macOS preserves writable profile cwd", "darwin", "/Applications/Lectern.app/Contents/Resources", "/Users/fixture/Library/Application Support/zmzai-lectern", false],
]) {
  test(name, () => {
    const { launched: options, paths: p, directoriesCreated } = launchOptions(platform, resources, userData, legacy);
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
