import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { artifactNames, digest, privatePackagePaths, stableManifest, verifyRelease } from "./release-validation.mjs";

async function fixture(t, platform = "win32") {
  const dir = mkdtempSync(join(tmpdir(), "lectern-release-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const names = artifactNames("0.5.1", platform);
  for (const name of names) writeFileSync(join(dir, name), "fixture artifact");
  const sha512 = await digest(join(dir, names[0]));
  const manifest = { version: "0.5.1", files: [{ url: names[0], size: 16, sha512 }], path: names[0], sha512 };
  const manifestPath = join(dir, platform === "darwin" ? "latest-mac.yml" : "latest.yml");
  const save = () => writeFileSync(manifestPath, stringify(manifest));
  save();
  return { dir, names, manifest, save };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: validates archive hashes and expected files`, async (t) => {
    const { dir, names } = await fixture(t, platform);
    const actual = await verifyRelease(dir, "0.5.1", [platform]);
    for (const name of names) assert.ok(actual.includes(name));
  });
}

for (const [name, mutate, message] of [
  ["stale version", (m) => { m.version = "0.4.3"; }, /version mismatch/],
  ["size", (m) => { m.files[0].size++; }, /size mismatch/],
  ["hash", (m) => { m.files[0].sha512 = "invalid"; }, /SHA-512 mismatch/],
  ["legacy hash", (m) => { m.sha512 = "invalid"; }, /legacy SHA-512/],
  ["traversal", (m) => { m.files[0].url = "../secret.zip"; }, /Unsafe/],
  ["Windows traversal", (m) => { m.files[0].url = "..\\secret.zip"; }, /Unsafe/],
  ["remote URL", (m) => { m.files[0].url = "https://other.invalid/app.zip"; }, /Unsafe/],
  ["duplicate", (m) => { m.files.push(m.files[0]); }, /duplicate/],
]) {
  test(`rejects ${name}`, async (t) => {
    const { dir, manifest, save } = await fixture(t);
    mutate(manifest); save();
    await assert.rejects(verifyRelease(dir, "0.5.1", ["win32"]), message);
  });
}

test("rejects missing portable ZIP and old or temporary installers", async (t) => {
  const { dir, names } = await fixture(t);
  writeFileSync(join(dir, "Lectern-0.4.3-win.zip"), "stale");
  await assert.rejects(verifyRelease(dir, "0.5.1", ["win32"]), /Unverified artifact/);
  rmSync(join(dir, "Lectern-0.4.3-win.zip"));
  rmSync(join(dir, names[1]));
  await assert.rejects(verifyRelease(dir, "0.5.1", ["win32"]), /Missing artifact/);
});

test("only accepts blockmaps for verified artifacts", async (t) => {
  const { dir, names } = await fixture(t);
  writeFileSync(join(dir, `${names[0]}.blockmap`), "map");
  assert.ok((await verifyRelease(dir, "0.5.1", ["win32"])).includes(`${names[0]}.blockmap`));
  writeFileSync(join(dir, "old.exe.blockmap"), "map");
  await assert.rejects(verifyRelease(dir, "0.5.1", ["win32"]), /Orphan blockmap/);
});

test("detects private data without rejecting dependency data directories", () => {
  const bad = ["/.next/standalone/data/chat.jsonl", "/electron/.secret", "/.next/standalone/public/nested/deep/secret.db", "/.env.release", "/.next/standalone/.env.local", "/.next/standalone/.workspace/a.txt"];
  assert.deepEqual(privatePackagePaths([...bad, "/.next/standalone/node_modules/caniuse-lite/data/agents.js"]), bad);
});

test("stable update manifests point at immutable versioned artifacts", async (t) => {
  const { dir, names, manifest } = await fixture(t, "win32");
  const stable = stableManifest(stringify(manifest), "0.5.1");
  assert.equal(stable.path, "v0.5.1/" + names[0]);
  assert.equal(stable.files[0].url, "v0.5.1/" + names[0]);
});
