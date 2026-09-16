/** strip-standalone-source.mjs 源级测试。
 *
 * 用临时目录伪造「仓库 + standalone」结构，spawn 脚本验证四条立场：
 *  1) 无残留 → 直接通过；
 *  2) 残留完全镜像仓库源码 → 移除；
 *  3) 残缺 / 内容不一致 / 仓库没有对应文件 → 不清理、非零退出；
 *  4) 盘符伪目录（如 `C:`）→ 同样按疑似泄漏处理。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./strip-standalone-source.mjs", import.meta.url));

function run(standalone, cwd) {
  const res = spawnSync(process.execPath, [script, "--dir", standalone], {
    cwd,
    encoding: "utf8",
  });
  return { code: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

/** 造一个最小 fixture：仓库含 app/lib 源码，standalone 含白名单条目。 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "strip-src-"));
  mkdirSync(join(root, "app", "api", "agents"), { recursive: true });
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "app", "api", "agents", "route.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "lib", "shared.ts"), "export const y = 2;\n");
  const standalone = join(root, ".next", "standalone");
  for (const d of [".next", "node_modules", "public"]) mkdirSync(join(standalone, d), { recursive: true });
  writeFileSync(join(standalone, "server.js"), "require('./package.json');\n");
  writeFileSync(join(standalone, "package.json"), '{"name":"lectern"}\n');
  return { root, standalone };
}

test("无残留：直接通过", () => {
  const { root, standalone } = makeFixture();
  try {
    const { code, out } = run(standalone, root);
    assert.equal(code, 0, out);
    assert.match(out, /无需清理/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("完全镜像仓库源码的残留被移除", () => {
  const { root, standalone } = makeFixture();
  try {
    mkdirSync(join(standalone, "app", "api", "agents"), { recursive: true });
    writeFileSync(join(standalone, "app", "api", "agents", "route.ts"), "export const x = 1;\n");
    mkdirSync(join(standalone, "lib"), { recursive: true });
    writeFileSync(join(standalone, "lib", "shared.ts"), "export const y = 2;\n");
    const { code, out } = run(standalone, root);
    assert.equal(code, 0, out);
    assert.match(out, /已移除源码残留 app\//);
    assert.match(out, /已移除源码残留 lib\//);
    assert.equal(existsSync(join(standalone, "app")), false, "standalone/app 应已移除");
    assert.equal(existsSync(join(standalone, "lib")), false, "standalone/lib 应已移除");
    assert.equal(existsSync(join(standalone, "server.js")), true, "白名单条目不受影响");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("残留里有仓库没有的文件：不清理、非零退出", () => {
  const { root, standalone } = makeFixture();
  try {
    mkdirSync(join(standalone, "app", "api", "secret"), { recursive: true });
    mkdirSync(join(standalone, "app", "api", "agents"), { recursive: true });
    writeFileSync(join(standalone, "app", "api", "agents", "route.ts"), "export const x = 1;\n");
    writeFileSync(join(standalone, "app", "api", "secret", "leak.json"), '{"token":"..."}\n');
    const { code, out } = run(standalone, root);
    assert.notEqual(code, 0);
    assert.match(out, /疑似真实泄漏/);
    assert.match(out, /app\/api\/secret\/leak\.json 在仓库源码中不存在或内容不一致/);
    assert.equal(existsSync(join(standalone, "app")), true, "未通过校验时不得清理任何东西");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("残留内容与仓库源码不一致：不清理、非零退出", () => {
  const { root, standalone } = makeFixture();
  try {
    mkdirSync(join(standalone, "app", "api", "agents"), { recursive: true });
    writeFileSync(join(standalone, "app", "api", "agents", "route.ts"), "export const tampered = true;\n");
    const { code, out } = run(standalone, root);
    assert.notEqual(code, 0);
    assert.match(out, /内容不一致/);
    assert.equal(existsSync(join(standalone, "app")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("盘符伪目录（C:）按疑似泄漏处理（仅 unix：Windows 上含冒号的目录名无法创建，本就物化不了）", { skip: process.platform === "win32" }, () => {
  const { root, standalone } = makeFixture();
  try {
    mkdirSync(join(standalone, "C:", "Users"), { recursive: true });
    writeFileSync(join(standalone, "C:", "Users", "runneradmin.txt"), "x\n");
    const { code } = run(standalone, root);
    assert.notEqual(code, 0);
    assert.equal(existsSync(join(standalone, "C:")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
