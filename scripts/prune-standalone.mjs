// 打包瘦身：把 npm 全量装的 standalone/node_modules 修剪到「运行时真实需要」的最小集。
//
// 背景：next build 的 outputFileTracing 会产出 .next/standalone/node_modules（最小集，
// 但 pnpm 下 next 本体被 trace 得不完整，跑不起来，故仍用 npm 全量 install 保证
// next 完整 + 平台 native 正确）。npm 全量（~560MB / 1.6w 文件）里大量纯 JS 包
// （lucide-react/highlight.js/framer-motion/@aws-sdk/@codemirror…）在 build 期已被
// webpack bundle 进 .next/server chunks，运行时不会再 require，纯属冗余。
//
// 本脚本以 trace 命中的包为白名单，删掉 npm 全量里白名单之外的包。
// 白名单 = trace 命中 + 通配保留（native / 动态 require 的补包）。
//
// 用法：node scripts/prune-standalone.mjs <trace-pkgs-file> <node_modules-dir> [--dry]
//   trace-pkgs-file  由 save-trace-pkgs.mjs 在 npm install 替换前生成（每行一个包名）
import { readFileSync, readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const positional = args.filter((a) => !a.startsWith("--"));
const [traceFile, nmDir] = positional;

if (!traceFile || !nmDir) {
  console.error("用法: node scripts/prune-standalone.mjs <trace-pkgs-file> <node_modules-dir> [--dry]");
  process.exit(2);
}

// 1) 白名单：trace 命中的具体包名
const keep = new Set();
if (existsSync(traceFile)) {
  for (const line of readFileSync(traceFile, "utf8").split("\n")) {
    const p = line.trim();
    if (p) keep.add(p);
  }
}

// 2) 通配保留规则（native 二进制 / trace 抓不到的动态 require 补包）
const KEEP_PATTERNS = [
  /^@next\/swc-/,          // next 运行时原生 swc（平台各异，一律保留）
  /^@img\//,               // sharp 平台二进制 + colour
  /^node-pty$/,            // 终端伪终端（框架 dynamic require，trace 漏）
  /^tree-sitter-wasms$/,   // repo_map 语言 wasm（框架 dynamic require，trace 漏）
  /^web-tree-sitter$/,     // repo_map 运行时（已在 trace，双保险）
  /^@zmzai\//,             // 私有包
  /^electron-updater$/,    // Electron main-process update service
  /^(fs-extra|graceful-fs|jsonfile|universalify|js-yaml|argparse|lazy-val|lodash\.escaperegexp|lodash\.isequal|semver|lru-cache|tiny-typed-emitter)$/,
];

function shouldKeep(name) {
  if (keep.has(name)) return true;
  return KEEP_PATTERNS.some((re) => re.test(name));
}

// 3) 枚举 node_modules 里的具体包（顶层无 scope 包 + scope 下子包）
function listPkgs(dir) {
  const pkgs = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry.startsWith("@")) {
      for (const sub of readdirSync(full)) {
        if (sub.startsWith(".")) continue;
        pkgs.push(`${entry}/${sub}`);
      }
    } else {
      pkgs.push(entry);
    }
  }
  return pkgs;
}

let removedBytes = 0;
let removedCount = 0;
const removed = [];
const kept = [];

for (const name of listPkgs(nmDir)) {
  if (shouldKeep(name)) {
    kept.push(name);
    continue;
  }
  const full = join(nmDir, ...name.split("/"));
  removed.push(name);
  removedCount++;
  removedBytes += dirSize(full);
  if (!dry) rmSync(full, { recursive: true, force: true });
}

// .bin 目录里是 npm 为 CLI 工具建的 symlink（指向各包的 bin/cli）；删包后这些
// symlink 变断链，electron-builder 复制时报 ENOENT（ensureSymlink）。standalone
// 是服务运行时，不依赖任何 .bin。这里递归清理 node_modules 下所有断链 symlink，
// 兜底任何删包遗留的悬空链接。
if (!dry) {
  const walkSymlinks = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkSymlinks(p);
      else if (e.isSymbolicLink()) {
        try {
          statSync(p); // follow 目标；断链会 throw ENOENT
        } catch {
          rmSync(p, { force: true });
        }
      }
    }
  };
  walkSymlinks(nmDir);
}

function dirSize(dir) {
  // 仅统计，不递归太深；用 du 不可靠跨平台，这里估算：直接递归统计文件
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          total += statSync(p).size;
        } catch {}
      }
    }
  };
  walk(dir);
  return total;
}

const mb = (b) => (b / 1048576).toFixed(1);
console.log(
  `[prune] ${dry ? "DRY-RUN " : ""}白名单 ${keep.size} 个 + 通配 ${KEEP_PATTERNS.length} 条；` +
    `保留 ${kept.length} 包，删除 ${removedCount} 包，省 ${mb(removedBytes)} MB`,
);
if (removed.length) {
  console.log(`[prune] 删除清单：\n  ${removed.sort().join("\n  ")}`);
}
