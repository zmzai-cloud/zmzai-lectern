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
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export default async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context;

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
