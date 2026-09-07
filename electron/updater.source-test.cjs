const assert = require("node:assert/strict");
const test = require("node:test");
const { selectRelease } = require("./update-contract.cjs");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const hash = createHash("sha512").update("fixture").digest("base64");
function manifest() { return { schema: 1, version: "0.5.1", platforms: {
  "darwin-arm64": { path: "v0.5.1/Lectern-0.5.1-arm64-mac.zip", size: 7, sha512: hash },
  "win32-x64": { path: "v0.5.1/Lectern-Setup-0.5.1.exe", size: 7, sha512: hash },
} }; }
test("selects architecture-specific archive or installer", () => {
  assert.match(selectRelease(manifest(), "0.5.0", "darwin", "arm64").name, /mac.zip$/);
  assert.match(selectRelease(manifest(), "0.5.0", "win32", "x64").name, /exe$/);
  assert.throws(() => selectRelease(manifest(), "0.5.0", "darwin", "x64"));
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
test("download is explicit and installation verifies again without native silent updater", () => {
  const source = readFileSync(join(__dirname, "updater.cjs"), "utf8");
  assert.match(source, /if \(state.status !== "available"\)/);
  assert.match(source, /await verify\(downloaded, release\)/);
  assert.match(source, /redirect: "error"/);
  assert.doesNotMatch(source, /quitAndInstall|autoUpdater|execSync|xattr/);
  const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
  assert.deepEqual(pkg.build.publish, { provider: "generic", url: "https://zmzai.oss-cn-beijing.aliyuncs.com/releases/harness/" });
});

const vm = require("node:vm");
const fs = require("node:fs/promises");
const os = require("node:os");
async function harness(platform, body = "fixture", consent = 1) {
  const root = await fs.mkdtemp(join(os.tmpdir(), "lectern-update-test-"));
  const calls = [];
  const electron = {
    app: { isPackaged: true, getVersion: () => "0.5.0", getPath: () => root, quit: () => calls.push("quit") },
    BrowserWindow: { getAllWindows: () => [] },
    dialog: { showMessageBox: async () => ({ response: consent }) },
    shell: { showItemInFolder: (p) => calls.push(["reveal", p]), openPath: async (p) => { calls.push(["open", p]); return ""; } },
  };
  const context = { module: { exports: {} }, require: (name) => name === "electron" ? electron : require(name),
    process: { platform, arch: platform === "darwin" ? "arm64" : "x64" }, Buffer, AbortSignal,
    fetch: async (url, options) => { calls.push(["fetch", url, options.redirect]); return new Response(url.endsWith(".json") ? JSON.stringify(manifest()) : body); },
  };
  vm.runInNewContext(readFileSync(join(__dirname, "updater.cjs"), "utf8"), context);
  return { updater: context.module.exports, calls, root };
}
for (const platform of ["darwin", "win32"]) {
  test(`${platform}: check does not download; verified download requires explicit installation`, async () => {
    const h = await harness(platform);
    assert.equal((await h.updater.check()).status, "available");
    assert.equal(h.calls.filter((c) => c[0] === "fetch").length, 1);
    assert.equal((await h.updater.download()).status, "ready");
    assert.equal(h.calls.some((c) => c[0] === "open" || c[0] === "reveal"), false);
    assert.equal(await h.updater.install(), true);
    const action = h.calls.find((c) => c[0] === (platform === "darwin" ? "reveal" : "open"));
    assert.equal(await fs.readFile(action[1], "utf8"), "fixture");
    assert.equal(h.calls.includes("quit"), platform === "win32");
  });
}
test("cancel keeps app running; corrupted or oversized packages cannot install", async () => {
  const cancelled = await harness("win32", "fixture", 0);
  await cancelled.updater.check(); await cancelled.updater.download();
  assert.equal(await cancelled.updater.install(), false);
  assert.equal(cancelled.calls.includes("quit"), false);
  for (const body of ["corrupt", "oversized fixture", "short"]) {
    const h = await harness("darwin", body);
    await h.updater.check();
    assert.equal((await h.updater.download()).status, "error");
    assert.equal(await h.updater.install(), false);
  }
});
test("rechecks downloaded package before opening", async () => {
  const h = await harness("win32");
  await h.updater.check(); await h.updater.download();
  const dirs = await fs.readdir(join(h.root, "updates"));
  await fs.writeFile(join(h.root, "updates", dirs[0], "Lectern-Setup-0.5.1.exe"), "tampered");
  assert.equal(await h.updater.install(), false);
  assert.equal(h.calls.includes("quit"), false);
});
