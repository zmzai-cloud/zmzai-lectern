import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (name) => readFileSync(join(root, name), "utf8");

test("Windows cross build stashes macOS artifacts before wiping dist and restores after validation", () => {
  const script = read("scripts/build-win-cross.sh");
  const preserve = script.indexOf("platform-artifacts.mjs preserve win32");
  const clean = script.indexOf("guard_mv dist .package-build");
  const winValidation = script.indexOf("release-validation.mjs release dist win32");
  // trap 里也有一句 restore；这里要的是校验之后的那次正常恢复。
  const restore = script.lastIndexOf("platform-artifacts.mjs restore win32");
  assert.ok(preserve >= 0 && preserve < clean, "preserve 必须发生在清理 dist 之前");
  assert.match(script, /trap 'node scripts\/platform-artifacts\.mjs restore win32/, "构建失败也必须恢复");
  assert.ok(winValidation < restore, "先只校验 win32，再恢复 mac 产物");
  assert.ok(clean < restore);
});

test("release orchestrator keeps mac → win build order and verifies before uploading", () => {
  const script = read("scripts/release-desktop.mjs");
  const mac = script.indexOf('"build:mac"');
  const smoke = script.indexOf('"test:packaged"');
  const win = script.indexOf('"build:win:cross"');
  const dual = script.indexOf('"scripts/release-validation.mjs", "release", "dist"');
  const upload = script.indexOf('"scripts/upload-oss.mjs"');
  const publicCheck = script.indexOf('"verify:public"');
  const updatePath = script.indexOf('"verify:update-path"');
  const site = script.indexOf("releaseSite({ ...sitePreflight");
  const github = script.indexOf('"release", "create"');
  assert.ok(mac >= 0 && mac < smoke && smoke < win);
  assert.ok(win < dual && dual < upload && upload < publicCheck);
  assert.ok(publicCheck < updatePath && updatePath < site && site < github);
});
