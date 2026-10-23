import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactPlatform, preservePlatformArtifacts, restorePlatformArtifacts, storeDir } from "./platform-artifacts.mjs";

const version = "0.16.0";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "lectern-artifacts-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist", "mac-arm64"), { recursive: true });
  mkdirSync(join(root, "dist", "win-unpacked"), { recursive: true });
  const files = [
    `Lectern-${version}-arm64.dmg`,
    `Lectern-${version}-arm64.dmg.blockmap`,
    `Lectern-${version}-arm64-mac.zip`,
    `Lectern-${version}-arm64-mac.zip.blockmap`,
    "latest-mac.yml",
    `Lectern-Setup-${version}.exe`,
    `Lectern-Setup-${version}.exe.blockmap`,
    `Lectern-${version}-win.zip`,
    `Lectern-${version}-win.zip.blockmap`,
    "latest.yml",
    `Lectern-0.15.0-arm64.dmg`,
    "builder-debug.yml",
  ];
  for (const name of files) writeFileSync(join(root, "dist", name), name);
  return { root, files };
}

test("classifies only the current version's installers and update manifests", () => {
  assert.equal(artifactPlatform(`Lectern-${version}-arm64-mac.zip`, version), "darwin");
  assert.equal(artifactPlatform(`Lectern-${version}-arm64.dmg.blockmap`, version), "darwin");
  assert.equal(artifactPlatform("latest-mac.yml", version), "darwin");
  assert.equal(artifactPlatform("mac-arm64", version), "darwin");
  assert.equal(artifactPlatform(`Lectern-Setup-${version}.exe`, version), "win32");
  assert.equal(artifactPlatform(`Lectern-${version}-win.zip.blockmap`, version), "win32");
  assert.equal(artifactPlatform("latest.yml", version), "win32");
  assert.equal(artifactPlatform("win-unpacked", version), "win32");
  assert.equal(artifactPlatform("builder-debug.yml", version), null);
  assert.equal(artifactPlatform("Lectern-0.15.0-arm64.dmg", version), null);
});

test("windows build preserves every macOS artifact and restores it untouched", (t) => {
  const { root } = fixture(t);
  const preserved = preservePlatformArtifacts({ root, platform: "win32", version }).sort();
  assert.deepEqual(preserved, [
    `Lectern-${version}-arm64-mac.zip`,
    `Lectern-${version}-arm64-mac.zip.blockmap`,
    `Lectern-${version}-arm64.dmg`,
    `Lectern-${version}-arm64.dmg.blockmap`,
    "latest-mac.yml",
    "mac-arm64",
  ]);
  for (const name of preserved) assert.equal(existsSync(join(root, "dist", name)), false, name);
  assert.equal(existsSync(join(root, "dist", `Lectern-Setup-${version}.exe`)), true);
  assert.equal(existsSync(join(root, "dist", "win-unpacked")), true);

  const restored = restorePlatformArtifacts({ root, platform: "win32", version }).sort();
  assert.deepEqual(restored, preserved);
  for (const name of restored) assert.equal(existsSync(join(root, "dist", name)), true, name);
  assert.equal(existsSync(storeDir(root, version)), false);
  // 旧版本产物与无关文件不保留（随 dist 清理），不属于本次发布。
  assert.equal(existsSync(join(root, "dist", "Lectern-0.15.0-arm64.dmg")), true);
});

test("reverse direction preserves Windows artifacts for a macOS rebuild", (t) => {
  const { root } = fixture(t);
  const preserved = preservePlatformArtifacts({ root, platform: "darwin", version }).sort();
  assert.deepEqual(preserved, [
    `Lectern-${version}-win.zip`,
    `Lectern-${version}-win.zip.blockmap`,
    `Lectern-Setup-${version}.exe`,
    `Lectern-Setup-${version}.exe.blockmap`,
    "latest.yml",
    "win-unpacked",
  ].sort());
  assert.deepEqual(restorePlatformArtifacts({ root, platform: "darwin", version }).sort(), preserved);
});

test("preserving without counterpart artifacts is a no-op and a leftover store is never overwritten", (t) => {
  const empty = mkdtempSync(join(tmpdir(), "lectern-artifacts-empty-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  mkdirSync(join(empty, "dist"));
  writeFileSync(join(empty, "dist", "builder-debug.yml"), "x");
  assert.deepEqual(preservePlatformArtifacts({ root: empty, platform: "win32", version }), []);

  const { root } = fixture(t);
  preservePlatformArtifacts({ root, platform: "win32", version });
  writeFileSync(join(root, "dist", `Lectern-${version}-arm64.dmg`), "new build");
  assert.throws(
    () => preservePlatformArtifacts({ root, platform: "win32", version }),
    /保留区已有同名产物/,
  );
});

test("restore refuses to overwrite artifacts produced by the current build", (t) => {
  const { root } = fixture(t);
  preservePlatformArtifacts({ root, platform: "win32", version });
  writeFileSync(join(root, "dist", "latest-mac.yml"), "fresh");
  assert.throws(() => restorePlatformArtifacts({ root, platform: "win32", version }), /恢复目标已存在/);
});
