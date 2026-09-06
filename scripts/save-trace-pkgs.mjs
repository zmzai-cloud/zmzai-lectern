// 保存 next outputFileTracing 命中的最小依赖包清单，供 prune-standalone.mjs 使用。
// 必须在「npm install 全量替换 standalone/node_modules」之前调用（trace 结果仍在）。
// 用法：node scripts/save-trace-pkgs.mjs [输出文件]  （默认 .next/trace-pkgs.txt）
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2] ?? ".next/trace-pkgs.txt";
const pnpmDir = ".next/standalone/node_modules/.pnpm";

if (!existsSync(pnpmDir)) {
  console.error(`[save-trace] 找不到 ${pnpmDir}，先跑 next build（output: standalone）`);
  process.exit(1);
}

const pkgs = new Set();
for (const entry of readdirSync(pnpmDir)) {
  if (entry === "node_modules") continue;
  // pnpm 目录名形如：@scope+pkg@1.2.3_peer@x 或 pkg@1.2.3_peer@x
  const m = entry.match(/^(@[^+]+\+[^@]+|[^@]+)@/);
  if (!m) continue;
  let name = m[1].replace("+", "/"); // @scope+pkg -> @scope/pkg
  pkgs.add(name);
}

// 去掉 next 本体（trace 的 next 残缺，运行时用 npm 全量的完整 next，但 next 名要保留
// 以便白名单不误删——next 会在 npm 全量里被保留）
writeFileSync(out, [...pkgs].sort().join("\n") + "\n");
console.log(`[save-trace] 命中 ${pkgs.size} 个包 → ${out}`);
