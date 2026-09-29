// electron-builder afterPack 钩子：asar 打包后、制作为 zip/dmg/nsis 之前执行。
//
// 只做一件事——把 app.asar.unpacked 里的 spawn-helper 补回执行位。
//
// 背景（两个坑叠在一起，都会表现为 `posix_spawnp failed`）：
//  1. node-pty 自带 asar 支持：lib/unixTerminal.js 里有
//       helperPath = helperPath.replace('app.asar', 'app.asar.unpacked')
//     也就是说它预期自己的 JS（lib/）留在 asar 内，由它把 helper 路径指向解包
//     目录。若 asarUnpack 把整个 node-pty（含 lib/）都解包，__dirname 里已含
//     app.asar.unpacked，再替换一次就变成 app.asar.unpacked.unpacked → ENOENT。
//     所以 package.json 的 asarUnpack 只解包 node-pty 的 prebuilds 目录，
//     lib/ 必须留在 asar 里（glob 见 package.json，此处不写以免块注释被提前闭合）。
//  2. electron-builder 解包时会丢掉可执行文件的执行位（npm 包里 spawn-helper 是
//     0755，落到 app.asar.unpacked 变成 0644）。框架
//     src/adapters/terminal-backend.ts 会在运行时 chmod 补位，但它 chmod 的是
//     asar 内的虚拟路径，静默失败。所以必须在打包后、封包前补回来。
//
// 不 chmod 的后果可自愈但降级：框架探测 spawn 失败后会退回 pipe 模式，终端可用
// 但没有 TTY（无着色、无交互式提示）。
import { chmodSync, cpSync, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export default async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;

  // Host 的 node-pty 供给（0.10.2）：Host bundle 自包含、root node_modules 被
  // files 白名单整体排除，但 Host 的终端工具需要真 PTY。files 白名单放行
  // node_modules 会改变 electron-builder 的收集行为弄丢 standalone 依赖
  // （0.10.2 修复实测踩坑），所以在这里把 node-pty（真实文件，穿透 pnpm
  // symlink）拷到 resources/host-runtime/node_modules，main.cjs 给 Host 注入
  // NODE_PATH 指到这个目录（CJS 解析链标准回退）。
  // 【目录名是强约束】不能放进 app.asar.unpacked：node-pty 的 unixTerminal.js
  // 会对 helper 路径做 replace("app.asar", "app.asar.unpacked")（实测踩坑：
  // 已含 .unpacked 的路径会被二次替换成 app.asar.unpacked.unpacked →
  // posix_spawnp failed → 静默降级 pipe）。host-runtime 不含 app.asar 字样，
  // 替换是 no-op。node-pty 1.1.0 是 N-API prebuilds 布局，跨平台同构。
  try {
    void packager;
    // 从本脚本位置反推仓库根（不依赖 electron-builder 内部 API）
    const appDir = join(new URL(".", import.meta.url).pathname, "..");
    const srcPty = join(appDir, "node_modules", "node-pty");
    if (existsSync(srcPty)) {
      const candidates = [join(appOutDir, "resources", "host-runtime", "node_modules", "node-pty")];
      if (electronPlatformName === "darwin") {
        const apps = readdirSync(appOutDir).filter((f) => f.endsWith(".app"));
        for (const a of apps) {
          candidates.push(join(appOutDir, a, "Contents", "Resources", "host-runtime", "node_modules", "node-pty"));
        }
      }
      for (const dest of candidates) {
        cpSync(srcPty, dest, { recursive: true, dereference: true });
      }
      console.log("[after-pack] node-pty -> resources/host-runtime/node_modules ✓");
    }
  } catch (error) {
    console.warn("[after-pack] node-pty 拷贝失败（Host 终端将降级 pipe 模式）:", error instanceof Error ? error.message : String(error));
  }

  // 各平台解包目录位置不同：macOS 在 <App>.app/Contents/Resources，其余在 resources/
  const candidates = [join(appOutDir, "resources", "app.asar.unpacked")];
  if (electronPlatformName === "darwin") {
    const apps = readdirSync(appOutDir).filter((f) => f.endsWith(".app"));
    for (const a of apps) {
      candidates.push(join(appOutDir, a, "Contents", "Resources", "app.asar.unpacked"));
    }
  }

  let fixed = 0;
  for (const root of candidates) {
    if (!existsSync(root)) continue;
    for (const file of walk(root)) {
      if (basename(file) !== "spawn-helper") continue;
      try {
        chmodSync(file, 0o755);
        fixed++;
      } catch {
        /* 只读介质等：框架会降级到 pipe 模式，不阻断打包 */
      }
    }
  }

  if (fixed > 0) {
    console.log(`[after-pack] 已为 ${fixed} 个 spawn-helper 补回执行位（0755）`);
  }
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
