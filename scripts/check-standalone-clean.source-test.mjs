/** check-standalone-clean.mjs 源级测试。
 *
 * 重点钉住两类曾让 Windows 原生构建红灯的 nft 条目形态：
 *  - 盘符伪段：`..\..\..\..\..\C:\Users\…`——resolve 后仍在「仓库内」（C: 被当
 *    成目录名），单靠前缀比对必然漏报；守卫必须按原始条目的段形状识别。
 *  - 源码目录指向：`..\..\..\..\..\app\api\…`——物化为 standalone 根部的源码
 *    残留目录。
 * 两类均为「报告不判定」，物化检查（根部白名单 / 特征扫描）才决定退出码。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-standalone-clean.mjs", import.meta.url));

function run(standalone, cwd) {
  const res = spawnSync(process.execPath, [script, "--dir", standalone], {
    cwd,
    encoding: "utf8",
  });
  return { code: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "guard-nft-"));
  const standalone = join(root, ".next", "standalone");
  for (const d of [".next", "node_modules", "public"]) mkdirSync(join(standalone, d), { recursive: true });
  writeFileSync(join(standalone, "server.js"), "require('./package.json');\n");
  writeFileSync(join(standalone, "package.json"), '{"name":"lectern"}\n');
  return { root, standalone };
}

/** 在 fixture 的 .next/server/app/api/agents/ 下写一个 nft.json。
 *  entries 先以「相对 nft 文件目录」的绝对目标描述，再转成 dots 相对形态，
 *  与 Next 实际产物一致。 */
function writeNft(root, targets) {
  const nftDir = join(root, ".next", "server", "app", "api", "agents");
  mkdirSync(nftDir, { recursive: true });
  const files = targets.map((abs) => relative(nftDir, abs));
  writeFileSync(
    join(nftDir, "route.js.nft.json"),
    JSON.stringify({ version: 1, files }),
  );
  return join(nftDir, "route.js.nft.json");
}

test("三类异常条目都被报告，但不影响退出码（物化检查干净）", () => {
  const { root, standalone } = makeFixture();
  try {
    // 正常条目：仓库内 node_modules
    mkdirSync(join(root, "node_modules", "next"), { recursive: true });
    writeFileSync(join(root, "node_modules", "next", "package.json"), '{"name":"next"}\n');
    // 源码条目：仓库内 app/
    mkdirSync(join(root, "app", "api", "agents"), { recursive: true });
    writeFileSync(join(root, "app", "api", "agents", "route.ts"), "export const x = 1;\n");
    writeNft(root, [
      join(root, "node_modules", "next", "package.json"),
      join(root, "app", "api", "agents", "route.ts"),
      "/etc/hosts", // 仓库外（绝对目标，转 dots 形态）
    ]);
    // 盘符伪段形态：dots + C:/Users/…（手写，模拟 Next 的 join 缺陷产物）
    const nftFile = join(root, ".next", "server", "app", "api", "agents", "route.js.nft.json");
    const data = JSON.parse(readFileSync(nftFile, "utf8"));
    data.files.push("../../../../../C:/Users/runneradmin/AppData/Roaming/Microsoft/DataLake");
    writeFileSync(nftFile, JSON.stringify(data));

    const { code, out } = run(standalone, root);
    assert.equal(code, 0, out);
    assert.match(out, /standalone 产物干净/);
    assert.match(out, /\[drive\]/);
    assert.match(out, /\[source\]/);
    assert.match(out, /\[outside\]/);
    assert.match(out, /C:\/Users\/runneradmin/);
    // 诊断文件落盘
    const diag = join(root, "test-results", "standalone-diagnostic.txt");
    assert.equal(existsSync(diag), true, "诊断文件应落盘");
    assert.match(readFileSync(diag, "utf8"), /盘符伪段/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("物化的根部残留仍然非零退出", () => {
  const { root, standalone } = makeFixture();
  try {
    mkdirSync(join(standalone, "app", "api"), { recursive: true });
    writeFileSync(join(standalone, "app", "api", "route.ts"), "export const x = 1;\n");
    const { code, out } = run(standalone, root);
    assert.notEqual(code, 0);
    assert.match(out, /非预期条目/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("干净构建：无异常条目报告", () => {
  const { root, standalone } = makeFixture();
  try {
    mkdirSync(join(root, "node_modules", "next"), { recursive: true });
    writeFileSync(join(root, "node_modules", "next", "package.json"), '{"name":"next"}\n');
    writeNft(root, [join(root, "node_modules", "next", "package.json")]);
    const { code, out } = run(standalone, root);
    assert.equal(code, 0, out);
    assert.match(out, /追踪图无异常条目/);
    assert.equal(existsSync(join(root, "test-results")), false, "无异常时不落诊断文件");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
