import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { artifactNames, digest } from "./release-validation.mjs";

async function upload(t, { fail = "", dry = false, both = false } = {}) {
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
  writeFileSync(loader, `export async function resolve(specifier, context, next) {
    if (specifier === 'ali-oss') return { url: ${JSON.stringify(pathToFileURL(mock).href)}, shortCircuit: true };
    return next(specifier, context);
  }`);
  // Whitelist environment fields so local release credentials never enter this process.
  const result = spawnSync(process.execPath, ["--experimental-loader", loader, fileURLToPath(new URL("./upload-oss.mjs", import.meta.url)), ...(dry ? ["--dry"] : [])], {
    cwd: dir, encoding: "utf8", timeout: 15000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      OSS_REGION: "oss-cn-beijing", OSS_BUCKET: "fixture-bucket", OSS_ACCESS_KEY_ID: "test-key", OSS_ACCESS_KEY_SECRET: "test-secret",
      LECTERN_TEST_PUT_LOG: log, LECTERN_TEST_FAIL: fail },
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
