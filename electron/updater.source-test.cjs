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
  assert.match(source, /\["available", "paused", "error"\]\.includes\(state\.status\)/);
  assert.match(source, /await verify\(downloaded, release\)/);
  assert.match(source, /redirect: "error"/);
  assert.doesNotMatch(source, /quitAndInstall|autoUpdater|execSync|xattr|showMessageBox/);
  const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
  assert.deepEqual(pkg.build.publish, { provider: "generic", url: "https://zmzai.oss-cn-beijing.aliyuncs.com/releases/harness/" });
});

test("mirror URLs are optional, validated per artifact, and never block updates", () => {
  const name = "Lectern-0.5.1-arm64-mac.zip";
  const mirror = `https://mirror.example/releases/harness/v0.5.1/${name}`;
  const withMirrors = manifest();
  withMirrors.platforms["darwin-arm64"].mirrors = [mirror, mirror, `http://insecure.example/v0.5.1/${name}`];
  assert.deepEqual(selectRelease(withMirrors, "0.5.0", "darwin", "arm64").mirrors, [mirror]);
  for (const mirrors of [
    `https://mirror.example/v0.5.1/other.zip`,
    [`https://user:pass@mirror.example/v0.5.1/${name}`],
    [`https://mirror.example/v0.5.1/${name}?token=1`],
    [`https://mirror.example/v0.5.1/${name}#fragment`],
    Array.from({ length: 4 }, (_, index) => `https://m${index}.example/v0.5.1/${name}`),
  ]) {
    const m = manifest();
    m.platforms["darwin-arm64"].mirrors = mirrors;
    assert.deepEqual(selectRelease(m, "0.5.0", "darwin", "arm64").mirrors, []);
  }
});


const vm = require("node:vm");
const fs = require("node:fs/promises");
const os = require("node:os");
async function harness(platform, { body = "fixture", autoUpdate = false, execPath: execPathOption, manifest: manifestOption, mockSpawn = true, fetch: fetchOption } = {}) {
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
    process: { platform, arch: platform === "darwin" ? "arm64" : "x64", execPath, pid: 4242,
      env: { LECTERN_UPDATE_RETRY_MS: "1" } },
    Buffer, AbortSignal, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push(["fetch", url, options?.redirect, options?.headers]);
      if (fetchOption) return fetchOption(url, options);
      return new Response(url.endsWith(".json") ? JSON.stringify(manifestOption ?? manifest()) : body);
    },
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
      assert.match(script, /mv '\/Applications\/Lectern\.app' '\/Applications\/Lectern\.app\.old'/);
      assert.match(script, /open '\/Applications\/Lectern\.app'/);
      assert.match(script, /update-install\.log/);
      assert.match(script, /last-install\.txt/);
    } else {
      const script = readFileSync(h.spawnCalls[0].args[3], "utf8");
      assert.match(script, /Lectern-Setup-0\.5\.1\.exe" \/S --updated/);
      assert.match(script, /%ERRORLEVEL%/);
      assert.match(script, /last-install\.txt/);
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
      assert.match(script, /mv '\/Applications\/Lectern\.app' '\/Applications\/Lectern\.app\.old'/);
      assert.doesNotMatch(script, /\n.*open '/);
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

function streamResponse(chunks, init = {}, delay = 15) {
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (const chunk of chunks) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          controller.enqueue(new Uint8Array(chunk));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, init);
}

test("manifest requests retry transient failures but fail fast on 404", async () => {
  let manifestCalls = 0;
  const retrying = await harness("darwin", { fetch: async (url) => {
    if (url.endsWith(".json") && ++manifestCalls < 3) return new Response("busy", { status: 503 });
    return new Response(url.endsWith(".json") ? JSON.stringify(manifest()) : "fixture");
  } });
  assert.equal((await retrying.updater.check()).status, "available");
  assert.equal(manifestCalls, 3);

  let notFoundCalls = 0;
  const missing = await harness("darwin", { fetch: async () => {
    notFoundCalls += 1;
    return new Response("missing", { status: 404 });
  } });
  assert.equal((await missing.updater.check()).status, "error");
  assert.equal(notFoundCalls, 1);
});

test("pause keeps the partial file and the next download resumes with Range", async () => {
  const payload = Buffer.alloc(64 * 1024, 7);
  const name = "Lectern-0.5.1-arm64-mac.zip";
  const artifact = { schema: 1, version: "0.5.1", platforms: { "darwin-arm64": {
    path: `v0.5.1/${name}`, size: payload.length,
    sha512: createHash("sha512").update(payload).digest("base64"),
  } } };
  const ranges = [];
  const h = await harness("darwin", { manifest: artifact, fetch: async (url, options) => {
    if (url.endsWith(".json")) return new Response(JSON.stringify(artifact));
    const range = options?.headers?.Range ?? null;
    ranges.push(range);
    if (!range) {
      const chunks = Array.from({ length: 16 }, (_, index) => payload.subarray(index * 4096, (index + 1) * 4096));
      return streamResponse(chunks);
    }
    const start = Number(/^bytes=(\d+)-$/.exec(range)[1]);
    return new Response(new Uint8Array(payload.subarray(start)), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${payload.length - 1}/${payload.length}` },
    });
  } });
  await h.updater.check();
  const job = h.updater.download();
  await waitFor(() => h.updater.getState().status === "downloading" && h.updater.getState().percent > 0);
  h.updater.pause();
  const paused = await job;
  assert.equal(paused.status, "paused");
  assert.ok(paused.percent > 0, "paused percent reflects bytes already on disk");
  assert.equal(existsSync(join(h.root, "updates", "v0.5.1", `${name}.partial`)), true);

  const ready = await h.updater.download();
  assert.equal(ready.status, "ready");
  assert.equal(ranges[0], null);
  assert.match(ranges.at(-1), /^bytes=[1-9]\d*-$/);
  assert.equal(readFileSync(join(h.root, "updates", "v0.5.1", name)).length, payload.length);
});

test("a hash mismatch discards the partial file and downloads again", async () => {
  let artifactCalls = 0;
  const h = await harness("darwin", { fetch: async (url) => {
    if (url.endsWith(".json")) return new Response(JSON.stringify(manifest()));
    artifactCalls += 1;
    return new Response(artifactCalls === 1 ? "corrupt" : "fixture");
  } });
  await h.updater.check();
  const state = await h.updater.download();
  assert.equal(state.status, "ready");
  assert.equal(artifactCalls, 2);
  assert.equal(existsSync(join(h.root, "updates", "v0.5.1", "Lectern-0.5.1-arm64-mac.zip")), true);
});

test("falls back to a mirror when the primary download source fails", async () => {
  const name = "Lectern-0.5.1-arm64-mac.zip";
  const mirrored = manifest();
  mirrored.platforms["darwin-arm64"].mirrors = [`https://mirror.example/v0.5.1/${name}`];
  const urls = [];
  const h = await harness("darwin", { manifest: mirrored, fetch: async (url) => {
    urls.push(url);
    if (url.endsWith(".json")) return new Response(JSON.stringify(mirrored));
    if (url.includes("mirror.example")) return new Response("fixture");
    return new Response("unavailable", { status: 503 });
  } });
  await h.updater.check();
  assert.equal((await h.updater.download()).status, "ready");
  assert.equal(urls.filter((url) => url.includes("mirror.example")).length, 1);
});

test("install failures are recorded on disk and surfaced on the next launch", async () => {
  const failed = await harness("win32");
  await fs.mkdir(join(failed.root, "updates"), { recursive: true });
  await fs.writeFile(join(failed.root, "updates", "last-install.txt"), "fail 0.5.1 32\n");
  failed.updater.cleanupOnStartup();
  assert.match(failed.updater.getState().installError, /安装目录被占用/);
  assert.match(failed.updater.getState().installError, /update-install\.log/);
  assert.equal(existsSync(join(failed.root, "updates", "last-install.txt")), false);

  const stale = await harness("win32");
  await fs.mkdir(join(stale.root, "updates"), { recursive: true });
  await fs.writeFile(join(stale.root, "updates", "last-install.txt"), "ok 0.5.1\n");
  stale.updater.cleanupOnStartup();
  assert.match(stale.updater.getState().installError, /仍运行 v0\.5\.0/);

  const current = await harness("win32");
  await fs.mkdir(join(current.root, "updates"), { recursive: true });
  await fs.writeFile(join(current.root, "updates", "last-install.txt"), "ok 0.5.0\n");
  current.updater.cleanupOnStartup();
  assert.equal(current.updater.getState().installError, null);
});

test("startup cleanup keeps fresh partial downloads for resume", async () => {
  const h = await harness("win32");
  const dir = join(h.root, "updates", "v0.5.1");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "Lectern-Setup-0.5.1.exe.partial"), "part");
  await fs.writeFile(join(dir, "Lectern-Setup-0.5.1.exe"), "full");
  h.updater.cleanupOnStartup();
  assert.equal(existsSync(join(dir, "Lectern-Setup-0.5.1.exe.partial")), true);
  assert.equal(existsSync(join(dir, "Lectern-Setup-0.5.1.exe")), false);
});
