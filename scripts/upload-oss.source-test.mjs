import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { artifactNames, digest } from "./release-validation.mjs";

async function upload(t, { fail = "", dry = false, both = false, gate = "pass" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lectern-upload-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.5.1" }));
  const names = artifactNames("0.5.1", "win32");
  for (const name of names) writeFileSync(join(dir, "dist", name), "fixture artifact");
  const sha512 = await digest(join(dir, "dist", names[0]));
  writeFileSync(join(dir, "dist", "latest.yml"), stringify({ version: "0.5.1", path: names[0], sha512, files: [{ url: names[0], sha512, size: 16 }] }));
  if (both) {
    const mac = artifactNames("0.5.1", "darwin")[0];
    writeFileSync(join(dir, "dist", mac), "fixture artifact");
    writeFileSync(join(dir, "dist", "latest-mac.yml"), stringify({ version: "0.5.1", path: mac, sha512, files: [{ url: mac, sha512, size: 16 }] }));
  }
  const log = join(dir, "puts.jsonl");
  const mock = join(dir, "oss.mjs");
  writeFileSync(mock, `import { appendFileSync } from 'node:fs';
    export default class OSS { async put(key, body) {
      appendFileSync(process.env.LECTERN_TEST_PUT_LOG, JSON.stringify({key, body: Buffer.isBuffer(body) ? body.toString() : null}) + '\\n');
      if (process.env.LECTERN_TEST_FAIL && key.endsWith(process.env.LECTERN_TEST_FAIL)) throw new Error('simulated upload failure');
    } }`);
  const loader = join(dir, "loader.mjs");
  // 渲染层 E2E 门禁的替身：真实模块会去查 GitHub（需要网络、需要 gh、需要目标
  // commit 上有 run），夹具里给不出这些。**只替换判定输入，不替换 upload-oss 的
  // 接线**——所以下面那条「门禁不通过时一个对象都不许上传」测的仍是真实调用路径。
  // 匹配精确的相对 specifier（upload-oss.mjs 里就是这么写的），这样替身内部用
  // 绝对 URL import 真实模块拿 formatGateResult 时不会自拦截。
  const gateMock = join(dir, "ui-e2e-gate.mock.mjs");
  writeFileSync(gateMock, `import { formatGateResult } from ${JSON.stringify(new URL("./ui-e2e-gate.mjs", import.meta.url).href)};
    export { formatGateResult };
    export function checkUiE2eGate() {
      if (process.env.LECTERN_TEST_GATE === 'fail') {
        return { ok: false, reason: 'failed', sha: 'fixture', detail: 'fixture: 最近一次完成的 ui-e2e 运行结论是 failure' };
      }
      return { ok: true, reason: 'success', sha: 'fixture', detail: 'fixture: ui-e2e 通过' };
    }`);
  writeFileSync(loader, `export async function resolve(specifier, context, next) {
    if (specifier === 'ali-oss') return { url: ${JSON.stringify(pathToFileURL(mock).href)}, shortCircuit: true };
    if (specifier === './ui-e2e-gate.mjs') return { url: ${JSON.stringify(pathToFileURL(gateMock).href)}, shortCircuit: true };
    return next(specifier, context);
  }`);
  // Node's CLI resolves loader/entry arguments with a URL-first heuristic: a bare Windows
  // path (C:\... / D:\...) is read as a "c:"/"d:" URL scheme, an absolute file:// entry gets
  // mangled while a custom loader is active, and `relative()` cannot cross drives. So the
  // loader goes in as a file:// URL and the entry is a bootstrap inside cwd that imports the
  // real uploader — no absolute path is ever handed to the CLI.
  const bootstrap = join(dir, "bootstrap.mjs");
  writeFileSync(bootstrap, `await import(${JSON.stringify(new URL("./upload-oss.mjs", import.meta.url).href)});\n`);
  // Whitelist environment fields so local release credentials never enter this process.
  const result = spawnSync(process.execPath, ["--experimental-loader", pathToFileURL(loader).href, "./bootstrap.mjs", ...(dry ? ["--dry"] : [])], {
    cwd: dir, encoding: "utf8", timeout: 15000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      OSS_REGION: "oss-cn-beijing", OSS_BUCKET: "fixture-bucket", OSS_ACCESS_KEY_ID: "test-key", OSS_ACCESS_KEY_SECRET: "test-secret",
      LECTERN_TEST_PUT_LOG: log, LECTERN_TEST_FAIL: fail, LECTERN_TEST_GATE: gate },
  });
  const puts = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  return { result, puts, dir, names };
}

test("actual uploader resolves stable feed URLs to the uploaded artifacts", async (t) => {
  const { result, puts, dir } = await upload(t);
  assert.equal(result.status, 0, result.stderr);
  const stable = puts.find((put) => put.key === "releases/harness/latest.yml");
  assert.ok(stable);
  const manifest = parse(stable.body);
  for (const path of [manifest.path, ...manifest.files.map((f) => f.url)]) {
    const url = new URL(path, "https://fixture.invalid/releases/harness/");
    assert.ok(puts.some((put) => url.pathname === "/" + put.key), url.href);
  }
  assert.equal(puts.at(-1), stable);
  const links = readFileSync(join(dir, "dist/release-links.md"), "utf8");
  assert.ok(links.includes("/releases/harness/latest.yml"));
  assert.ok(!links.includes("latest-mac.yml"));
});

test("failed artifact upload never advances the stable feed", async (t) => {
  const { result, puts } = await upload(t, { fail: ".exe" });
  assert.equal(result.status, 1);
  assert.ok(!puts.some((put) => put.key === "releases/harness/latest.yml"));
});

test("dry run shows stable targets without uploading", async (t) => {
  const { result, puts } = await upload(t, { dry: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(puts, []);
  assert.match(result.stdout, /latest.yml \(stable root\)/);
});

// 发版门禁的三条行为。第一条是核心：门禁未通过时**一个对象都不许写**——
// 顺序上它排在上传之前，这里正是为了钉住「顺序没有被人改回去」。
test("rendering-layer E2E gate blocks the upload before any object is written", async (t) => {
  const { result, puts } = await upload(t, { gate: "fail" });
  assert.equal(result.status, 1, result.stdout);
  assert.deepEqual(puts, [], "门禁未通过时不该有任何上传动作");
  assert.match(result.stderr, /渲染层 E2E 未在将要发布的 commit 上通过/);
});

test("dry run reports a failing gate but does not block (it writes nothing anyway)", async (t) => {
  const { result, puts } = await upload(t, { dry: true, gate: "fail" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(puts, []);
  assert.match(result.stderr, /dry-run 未实际上传，故不阻止/);
});

test("a passing gate is announced before the upload", async (t) => {
  const { result, puts } = await upload(t);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(puts.length > 0);
  assert.match(result.stdout, /渲染层 E2E 门禁通过/);
});

test("desktop JSON feed is published last and selects both uploaded platform artifacts", async (t) => {
  const { result, puts } = await upload(t, { both: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(puts.at(-1).key, "releases/harness/latest-desktop.json");
  const manifest = JSON.parse(puts.at(-1).body);
  const { default: contract } = await import("../electron/update-contract.cjs");
  for (const [platform, arch] of [["darwin", "arm64"], ["win32", "x64"]]) {
    const artifact = contract.selectRelease(manifest, "0.5.0", platform, arch);
    assert.ok(puts.some((put) => put.key === `releases/harness/${artifact.path}`));
  }
});
