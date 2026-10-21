const assert = require("node:assert/strict");
const test = require("node:test");
const { selectRelease, assertReleaseNotes } = require("./update-contract.cjs");
const { createHash } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const hash = createHash("sha512").update("fixture").digest("base64");
const notes = { date: "2026-10-19", sections: [{ title: "新功能", items: ["本地项目支持一次选择多个文件夹"] }] };
function manifest() { return { schema: 1, version: "0.5.1", releaseNotes: notes, platforms: {
  "darwin-arm64": { path: "v0.5.1/Lectern-0.5.1-arm64-mac.zip", size: 7, sha512: hash },
  "win32-x64": { path: "v0.5.1/Lectern-Setup-0.5.1.exe", size: 7, sha512: hash },
} }; }
test("selects architecture-specific archive or installer", () => {
  assert.match(selectRelease(manifest(), "0.5.0", "darwin", "arm64").name, /mac.zip$/);
  assert.match(selectRelease(manifest(), "0.5.0", "win32", "x64").name, /exe$/);
  assert.throws(() => selectRelease(manifest(), "0.5.0", "darwin", "x64"));
});
test("carries release notes and ignores malformed ones instead of blocking updates", () => {
  assert.deepEqual(selectRelease(manifest(), "0.5.0", "darwin", "arm64").releaseNotes, notes);
  for (const releaseNotes of [
    null,
    { date: "2026-02-30", sections: [{ title: "新功能", items: ["x"] }] },
    { date: "2026-10-19", sections: [] },
    { date: "2026-10-19", sections: [{ title: "", items: ["x"] }] },
    { date: "2026-10-19", sections: [{ title: "新功能", items: [""] }] },
    { date: "2026-10-19", sections: [{ title: "新功能", items: ["x".repeat(241)] }] },
  ]) {
    const m = manifest(); m.releaseNotes = releaseNotes;
    assert.equal(selectRelease(m, "0.5.0", "darwin", "arm64").releaseNotes, null);
  }
});
test("release-side notes validation fails closed", () => {
  assert.deepEqual(assertReleaseNotes(notes), notes);
  assert.throws(() => assertReleaseNotes(null));
  assert.throws(() => assertReleaseNotes({ date: "2026-10-19", sections: [] }));
  assert.throws(() => assertReleaseNotes({ date: "2026-10-19", sections: [{ title: "新功能", items: [] }] }));
  assert.throws(() => assertReleaseNotes({ date: "2026-10-19", sections: Array.from({ length: 9 }, () => ({ title: "节", items: ["x"] })) }));
  assert.throws(() => assertReleaseNotes({ date: "2026-10-19", sections: [{ title: "节", items: Array.from({ length: 31 }, () => "x") }] }));
});
test("same version and downgrade never offered, versions compare numerically", () => {
  assert.equal(selectRelease(manifest(), "0.5.1", "darwin", "arm64"), null);
  assert.equal(selectRelease(manifest(), "0.10.0", "darwin", "arm64"), null);
});
test("rejects unsafe paths, external hosts, invalid sizes and hashes", () => {
  for (const value of ["../evil.zip", "https://evil.test/a.zip", "v0.5.1/Lectern-0.5.1-arm64-mac.zip?evil", "v0.5.1/evil.exe"]) {
    const m = manifest(); m.platforms["darwin-arm64"].path = value;
    assert.throws(() => selectRelease(m, "0.5.0", "darwin", "arm64"));
  }
  for (const size of [-1, 0, 2 ** 32, 1.5]) {
    const m = manifest(); m.platforms["darwin-arm64"].size = size;
    assert.throws(() => selectRelease(m, "0.5.0", "darwin", "arm64"));
  }
  const m = manifest(); m.platforms["darwin-arm64"].sha512 = "invalid";
  assert.throws(() => selectRelease(m, "0.5.0", "darwin", "arm64"));
});
test("download stays explicit when auto update is off and install verifies again", () => {
  const source = readFileSync(join(__dirname, "updater.cjs"), "utf8");
  assert.match(source, /if \(state.status !== "available"\)/);
  assert.match(source, /await verify\(downloaded, release\)/);
  assert.match(source, /redirect: "error"/);
  assert.doesNotMatch(source, /quitAndInstall|autoUpdater|execSync|xattr|showMessageBox/);
  const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
  assert.deepEqual(pkg.build.publish, { provider: "generic", url: "https://zmzai.oss-cn-beijing.aliyuncs.com/releases/harness/" });
});

const vm = require("node:vm");
const fs = require("node:fs/promises");
const os = require("node:os");
async function harness(platform, { body = "fixture", autoUpdate = false, execPath: execPathOption, manifest: manifestOption, mockSpawn = true } = {}) {
  const root = await fs.mkdtemp(join(os.tmpdir(), "lectern-update-test-"));
  const calls = [];
  const spawnCalls = [];
  const execPath = execPathOption ?? (platform === "darwin"
    ? "/Applications/Lectern.app/Contents/MacOS/Lectern"
    : "C:\\Program Files\\Lectern\\Lectern.exe");
  const electron = {
    app: { isPackaged: true, getVersion: () => "0.5.0", getPath: () => root, quit: () => calls.push("quit") },
    BrowserWindow: { getAllWindows: () => [] },
  };
  const context = { module: { exports: {} },
    require: (name) => {
      if (name === "electron") return electron;
      if (name === "node:child_process" && mockSpawn) {
        return { spawn: (cmd, args, options) => { spawnCalls.push({ cmd, args, options }); return { unref() {} }; } };
      }
      return require(name);
    },
    process: { platform, arch: platform === "darwin" ? "arm64" : "x64", execPath, pid: 4242 },
    Buffer, AbortSignal,
    fetch: async (url, options) => { calls.push(["fetch", url, options.redirect]); return new Response(url.endsWith(".json") ? JSON.stringify(manifestOption ?? manifest()) : body); },
  };
  vm.runInNewContext(readFileSync(join(__dirname, "updater.cjs"), "utf8"), context);
  const updater = context.module.exports;
  await fs.writeFile(join(root, "settings.json"), JSON.stringify({ autoUpdate: autoUpdate === true }) + "\n", { mode: 0o600 });
  updater.setDataDir(root);
  return { updater, calls, spawnCalls, root };
}
async function waitFor(check, timeout = 2000) {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error("等待更新状态超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}
function fetchCount(calls) { return calls.filter((c) => c[0] === "fetch").length; }

test("mac app root climbs out of Contents/MacOS (regression: three levels)", async () => {
  const h = await harness("darwin");
  assert.equal(h.updater.macAppRoot("/Applications/Lectern.app/Contents/MacOS/Lectern"), "/Applications/Lectern.app");
  assert.equal(h.updater.macAppRoot("/Users/a/Applications/Lectern.app/Contents/MacOS/Lectern"), "/Users/a/Applications/Lectern.app");
});

test("mac installer really replaces the bundle and keeps a backup", { skip: process.platform !== "darwin" }, async () => {
  const work = await fs.mkdtemp(join(os.tmpdir(), "lectern-install-e2e-"));
  const oldApp = join(work, "Applications", "Lectern.app");
  const oldExec = join(oldApp, "Contents", "MacOS", "Lectern");
  await fs.mkdir(join(oldApp, "Contents", "MacOS"), { recursive: true });
  await fs.writeFile(oldExec, "old");
  const newApp = join(work, "stage", "Lectern.app");
  const newExec = join(newApp, "Contents", "MacOS", "Lectern");
  await fs.mkdir(join(newApp, "Contents", "MacOS"), { recursive: true });
  await fs.writeFile(newExec, "new");
  const zipPath = join(work, "update.zip");
  const zipped = spawnSync("ditto", ["-c", "-k", "--keepParent", newApp, zipPath]);
  assert.equal(zipped.status, 0);
  const zip = await fs.readFile(zipPath);

  const h = await harness("darwin", {
    autoUpdate: true,
    body: zip,
    mockSpawn: false,
    execPath: oldExec,
    manifest: { schema: 1, version: "0.5.1", platforms: { "darwin-arm64": {
      path: "v0.5.1/Lectern-0.5.1-arm64-mac.zip", size: zip.length,
      sha512: createHash("sha512").update(zip).digest("base64"),
    } } },
  });
  await h.updater.check();
  await waitFor(() => h.updater.getState().status === "ready");
  assert.equal(await h.updater.installOnQuitIfReady(), true);
  await waitFor(() => existsSync(`${oldApp}.old`), 5000);
  await waitFor(() => existsSync(oldExec) && readFileSync(oldExec, "utf8") === "new", 5000);
  assert.equal(readFileSync(join(`${oldApp}.old`, "Contents", "MacOS", "Lectern"), "utf8"), "old");
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: manual install is deferred to quit and runs exactly once`, async () => {
    const h = await harness(platform);
    assert.equal((await h.updater.check()).status, "available");
    assert.equal(fetchCount(h.calls), 1);
    assert.equal((await h.updater.download()).status, "ready");
    assert.equal(h.spawnCalls.length, 0);

    assert.equal(await h.updater.install(), true);
    assert.equal(h.calls.includes("quit"), true);
    // 替换必须在 before-quit 收尾后执行，不能在进程还没退时和安装/替换抢目录。
    assert.equal(h.spawnCalls.length, 0);

    assert.equal(await h.updater.installOnQuitIfReady(), true);
    assert.equal(h.spawnCalls.length, 1);
    // 同一进程只允许拉起一次替换脚本（手动安装 + 退出安装不得双跑）。
    assert.equal(await h.updater.installOnQuitIfReady(), false);
    assert.equal(h.spawnCalls.length, 1);
    assert.equal(h.calls.filter((c) => c === "quit").length, 1);

    if (platform === "darwin") {
      const script = h.spawnCalls[0].args[1];
      assert.match(script, /ditto -x -k/);
      assert.match(script, /mv "\/Applications\/Lectern\.app" "\/Applications\/Lectern\.app\.old"/);
      assert.match(script, /open "\/Applications\/Lectern\.app"/);
    } else {
      const script = readFileSync(h.spawnCalls[0].args[3], "utf8");
      assert.match(script, /start \/wait "" ".*Lectern-Setup-0\.5\.1\.exe" \/S --updated/);
      assert.match(script, /start "" "C:\\Program Files\\Lectern\\Lectern\.exe"/);
    }
  });
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: auto update downloads immediately; quit install does not relaunch`, async () => {
    const h = await harness(platform, { autoUpdate: true });
    assert.equal((await h.updater.check()).status, "available");
    await waitFor(() => h.updater.getState().status === "ready");
    assert.equal(fetchCount(h.calls), 2);

    assert.equal(await h.updater.installOnQuitIfReady(), true);
    assert.equal(h.spawnCalls.length, 1);
    if (platform === "darwin") {
      const script = h.spawnCalls[0].args[1];
      assert.match(script, /mv "\/Applications\/Lectern\.app" "\/Applications\/Lectern\.app\.old"/);
      assert.doesNotMatch(script, /\nopen /);
    } else {
      const script = readFileSync(h.spawnCalls[0].args[3], "utf8");
      assert.match(script, /\/S --updated/);
      assert.doesNotMatch(script, /start "" "C:\\Program Files\\Lectern\\Lectern\.exe"/);
    }
  });
}

test("auto update off keeps quit from installing a ready package", async () => {
  const h = await harness("darwin", { autoUpdate: false });
  await h.updater.check(); await h.updater.download();
  assert.equal((await h.updater.getState()).status, "ready");
  assert.equal(await h.updater.installOnQuitIfReady(), false);
  assert.equal(h.spawnCalls.length, 0);
});

test("update state exposes the release notes consumed by the hover card", async () => {
  const h = await harness("darwin");
  const checked = await h.updater.check();
  // updater 跑在 vm 沙箱里，对象原型跨 realm——按 JSON 值比较。
  assert.deepEqual(JSON.parse(JSON.stringify(checked.releaseNotes)), notes);
  assert.deepEqual(JSON.parse(JSON.stringify(h.updater.getState().releaseNotes)), notes);
});

test("install without a ready package or with a corrupted package cannot quit the app", async () => {
  const notReady = await harness("win32");
  assert.equal(await notReady.updater.install(), false);
  assert.equal(notReady.calls.includes("quit"), false);
  for (const body of ["corrupt", "oversized fixture", "short"]) {
    const h = await harness("darwin", { body });
    await h.updater.check();
    assert.equal((await h.updater.download()).status, "error");
    assert.equal(await h.updater.install(), false);
    assert.equal(h.calls.includes("quit"), false);
  }
});
test("rechecks downloaded package before quitting", async () => {
  const h = await harness("win32");
  await h.updater.check(); await h.updater.download();
  const dirs = await fs.readdir(join(h.root, "updates"));
  await fs.writeFile(join(h.root, "updates", dirs[0], "Lectern-Setup-0.5.1.exe"), "tampered");
  assert.equal(await h.updater.install(), false);
  assert.equal(h.calls.includes("quit"), false);
  assert.equal(await h.updater.installOnQuitIfReady(), false);
  assert.equal(h.spawnCalls.length, 0);
});
