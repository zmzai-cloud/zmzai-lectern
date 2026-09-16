#!/usr/bin/env node
/** 构建后清理：standalone 根部的「源码残留」验证 + 移除。
 *
 * 背景（Windows 原生构建，Next 15.5 已知行为）：next-trace-entrypoints-plugin 的
 * bundled 过滤依赖 depModMap 的键精确匹配，在 Windows 上对部分源码条目失效，
 * 导致源码 app/** 被写进 .nft.json 并复制成 .next/standalone/app —— 守卫
 * （check-standalone-clean.mjs 的根部白名单）会因此红灯。macOS 构建（含交叉
 * 构建）不受影响。
 *
 * 本脚本的立场：standalone 里出现仓库源码目录是 Next 的缺陷，但**只有逐文件
 * 镜像校验通过**才允许移除；任何不能与仓库源码一一对应（不存在 / 内容不同 /
 * 非目录）的残留都按「疑似真实泄漏」处理，不做任何清理、非零退出，交给人看。
 *
 * 用法：node scripts/strip-standalone-source.mjs [--dir <standalone 路径>]
 *   （默认 .next/standalone，root 取 process.cwd()，与守卫一致）
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const dirIdx = process.argv.indexOf("--dir");
const standalone =
  dirIdx >= 0 ? resolve(process.argv[dirIdx + 1]) : resolve(process.cwd(), ".next", "standalone");
const root = resolve(process.cwd());

if (!existsSync(standalone)) {
  console.error(`❌ 找不到 standalone 目录：${standalone}`);
  process.exit(1);
}

// 与 check-standalone-clean.mjs 的 ROOT_ALLOWLIST 保持一致：standalone 根部
// 只该有产物该有的东西，白名单之外的都算残留候选。
const ROOT_ALLOWLIST = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".next",
  "node_modules",
  "package.json",
  "public",
  "server.js",
]);

function sha256(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** 收集目录下所有文件（相对 strayRoot 的路径）。空目录返回空数组。 */
function walkFiles(dir, base, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, base, out);
    else if (e.isFile()) out.push(p.slice(base.length + 1));
  }
}

const strays = readdirSync(standalone).filter((name) => !ROOT_ALLOWLIST.has(name));
if (strays.length === 0) {
  console.log("✅ standalone 根目录无残留，无需清理");
  process.exit(0);
}

const removable = [];
const anomalies = [];
for (const name of strays) {
  const strayRoot = join(standalone, name);
  let st;
  try {
    st = statSync(strayRoot);
  } catch (err) {
    anomalies.push(`${name}：无法读取（${err.code ?? err.message}）`);
    continue;
  }
  if (!st.isDirectory()) {
    anomalies.push(`${name}：白名单之外的根部残留是文件而非目录`);
    continue;
  }
  const rels = [];
  walkFiles(strayRoot, strayRoot, rels);
  const mirrorRoot = join(root, name);
  let ok = true;
  for (const rel of rels) {
    const mirror = join(mirrorRoot, rel);
    let mirrorOk = false;
    try {
      mirrorOk = statSync(mirror).isFile() && sha256(mirror) === sha256(join(strayRoot, rel));
    } catch {
      mirrorOk = false;
    }
    if (!mirrorOk) {
      anomalies.push(`${name}/${rel} 在仓库源码中不存在或内容不一致`);
      ok = false;
    }
  }
  if (ok) removable.push({ name, files: rels.length, bytes: st.size });
}

if (anomalies.length > 0) {
  console.error("❌ standalone 根部残留未通过源码镜像校验，疑似真实泄漏，未做任何清理：\n");
  for (const a of anomalies.slice(0, 40)) console.error(`   · ${a}`);
  if (anomalies.length > 40) console.error(`   … 另有 ${anomalies.length - 40} 项`);
  console.error(
    "\n只有效果为「仓库源码的逐字节镜像」的残留才会被清理；出现本错误说明残留\n" +
      "里有源码之外的内容（本机数据 / 会话库 / 凭据），请先查清来源再决定处置。\n" +
      "排查：next.config.mjs 的 outputFileTracingExcludes 是否被改动？\n" +
      "      .nft.json 中哪些条目指向了仓库源码目录之外？",
  );
  process.exit(1);
}

for (const r of removable) {
  rmSync(join(standalone, r.name), { recursive: true, force: true });
  console.log(`🧹 已移除源码残留 ${r.name}/（${r.files} 个文件，镜像自仓库 ${r.name}/）`);
}console.log(`✅ 清理完成：${removable.length} 个源码残留目录，无异常`);
