// 原生依赖平台/语言裁剪：进一步压小 standalone/node_modules。
// 1) node-pty：只保留目标平台的 prebuilds，并删除 Windows 调试符号（.pdb）与
//    构建源（third_party/src/scripts/deps/binding.gyp/typings）。运行时只需要
//    lib/ + package.json + prebuilds/<platform>-<arch>。
// 2) tree-sitter-wasms：只保留 repo_map 实际用到的语言（见 @zmzai/agent-framework
//    src/core/repomap/tags.ts 的 LANG_BY_EXT）。
// 用法：node scripts/shrink-native.mjs <node_modules-dir> --platform=win32|darwin --arch=x64|arm64
import { readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const nmDir = args[0];
const platform = (args.find((a) => a.startsWith("--platform=")) ?? "").split("=")[1] || process.platform;
const arch = (args.find((a) => a.startsWith("--arch=")) ?? "").split("=")[1] || process.arch;

if (!nmDir) {
  console.error("用法: node scripts/shrink-native.mjs <node_modules-dir> --platform=win32 --arch=x64");
  process.exit(2);
}

let saved = 0;
const size = (p) => {
  // 快速估算目录大小
  let total = 0;
  try {
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const fp = join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else if (e.isFile()) {
          try {
            total += statSync(fp).size;
          } catch {}
        }
      }
    };
    walk(p);
  } catch {}
  return total;
};

// --- node-pty ---
const pty = join(nmDir, "node-pty");
if (existsSync(pty)) {
  const keepDir = join(pty, "prebuilds", `${platform}-${arch}`);
  for (const entry of readdirSync(join(pty, "prebuilds"))) {
    if (entry === `${platform}-${arch}`) continue;
    const p = join(pty, "prebuilds", entry);
    saved += size(p);
    rmSync(p, { recursive: true, force: true });
  }
  // 删除目标平台目录里的 .pdb（Windows 调试符号）
  if (existsSync(keepDir)) {
    for (const f of readdirSync(keepDir)) {
      if (f.endsWith(".pdb")) {
        saved += size(join(keepDir, f));
        rmSync(join(keepDir, f), { force: true });
      }
    }
  }
  // 删除构建源（运行时不需要）
  for (const d of ["third_party", "src", "scripts", "deps", "typings"]) {
    const p = join(pty, d);
    if (existsSync(p)) {
      saved += size(p);
      rmSync(p, { recursive: true, force: true });
    }
  }
  for (const f of ["binding.gyp", "README.md", "LICENSE"]) {
    const p = join(pty, f);
    if (existsSync(p)) {
      saved += size(p);
      rmSync(p, { force: true });
    }
  }
}

// --- tree-sitter-wasms：只留 repo_map 用到的语言 ---
const ts = join(nmDir, "tree-sitter-wasms");
if (existsSync(ts)) {
  const KEEP = new Set([
    "tree-sitter-typescript.wasm",
    "tree-sitter-tsx.wasm",
    "tree-sitter-javascript.wasm",
    "tree-sitter-python.wasm",
    "tree-sitter-go.wasm",
  ]);
  const out = join(ts, "out");
  if (existsSync(out)) {
    for (const f of readdirSync(out)) {
      if (KEEP.has(f)) continue;
      const p = join(out, f);
      saved += size(p);
      rmSync(p, { force: true });
    }
  }
  for (const f of ["README.md", "LICENSE"]) {
    const p = join(ts, f);
    if (existsSync(p)) {
      saved += size(p);
      rmSync(p, { force: true });
    }
  }
}

console.log(`[shrink-native] platform=${platform}-${arch} 裁剪省 ${(saved / 1048576).toFixed(1)} MB`);
