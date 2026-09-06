// asar 化前置补丁：摘掉 Next standalone server.js 的 process.chdir(__dirname)。
//
// 为什么必须改：asar 是一个文件而不是目录，Electron 的 asar 支持只补丁了 fs 与
// module 层，libuv 的 process.chdir 不走这层补丁。server.js 第 12 行的
// `process.chdir(__dirname)` 在 asar 内会直接抛
//   Error: ENOTDIR: not a directory, chdir '.../app.asar/'
// 服务起不来，用户只会看到窗口白屏。
//
// 为什么可以改：chdir 只为「进程内相对路径」兜底。真正决定资源位置的是同文件
// 第 9 行的 `const dir = path.join(__dirname)`，它是绝对路径，startServer({ dir })
// 直接用它。摘掉 chdir 后进程工作目录 = utilityProcess.fork 传入的 cwd（主进程
// 显式设为 <userData>），Next 侧一切照旧。
//
// 幂等：重复执行不叠加注释；未匹配到目标行时按 --strict 决定是否报错。
// 用法：node scripts/patch-standalone-for-asar.mjs [standalone-dir] [--strict]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const target = args.find((a) => !a.startsWith("--")) ?? ".next/standalone";
const serverPath = target.endsWith("server.js") ? target : join(target, "server.js");

if (!existsSync(serverPath)) {
  console.error(`[patch-asar] 找不到 ${serverPath}`);
  process.exit(strict ? 1 : 0);
}

const src = readFileSync(serverPath, "utf8");

// 只匹配行首（未缩进、未被注释）的 chdir，避免重复打补丁
const RE = /^process\.chdir\(__dirname\);?[ \t]*$/m;

if (!RE.test(src)) {
  if (/asar/.test(src) && !RE.test(src)) {
    console.log(`[patch-asar] ${serverPath} 已打过补丁，跳过`);
    process.exit(0);
  }
  console.error("[patch-asar] 未找到 process.chdir(__dirname)，Next 版本可能变了，请人工核对 server.js");
  process.exit(strict ? 1 : 0);
}

const NOTE =
  "// asar 化补丁（scripts/patch-standalone-for-asar.mjs）：asar 内路径不能作为进程\n" +
  "// 工作目录（libuv chdir 不吃 Electron 的 fs 补丁 → ENOTDIR）。资源位置由本文件\n" +
  "// 第 9 行的绝对路径 dir 决定；进程 cwd 由主进程 utilityProcess.fork 指定为 <userData>。";

writeFileSync(serverPath, src.replace(RE, NOTE), "utf8");
console.log(`[patch-asar] 已摘掉 ${serverPath} 的 process.chdir(__dirname)`);
