import { build } from "esbuild";
import { rmSync, writeFileSync } from "node:fs";

/** Host 自包含 bundle（0.10.1 安装包 Host 崩溃循环的根因修复）。
 *
 *  此前 host:build 是 tsc 裸产物（moduleResolution:bundler 只是编译期解析，
 *  不是打包）——运行时 bare-import zod / @earendil-works/pi-ai /
 *  @zmzai/agent-framework，而 electron-builder 的 files 白名单 `!node_modules/**`
 *  全排除 node_modules（Next 侧靠 .next/standalone 自带依赖不受影响）。
 *  安装包里的 Host 于是启动即 ERR_MODULE_NOT_FOUND → 60s 内 3 次退出 →
 *  「Host 故障」弹窗（dev 模式 node_modules 齐全，从未暴露）。
 *
 *  现改为 esbuild 单文件 bundle：运行时零 node_modules 依赖（node:* 内置除外）。
 *  入口路径保持 host/dist/host/src/index.js（electron/main.cjs 硬编码）。
 *  node-pty 故意不打进来：framework 侧用 createRequire 拼接名动态解析（asar
 *  内解析不到时 try/catch 降级 pipe 模式，功能等价——真 PTY 需要 asarUnpack
 *  原生模块，是另一个议题）。类型检查由根 tsconfig 的 tsc --noEmit 覆盖
 *  （include 全部 .ts，含 host/src），本脚本只负责产物。 */

await rmSync("host/dist", { recursive: true, force: true });

await build({
  entryPoints: ["host/src/index.ts"],
  outfile: "host/dist/host/src/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  // ESM 里没有 require：openai SDK 等 CJS 依赖需要 createRequire 桥。
  banner: { js: "import { createRequire as __lecternCreateRequire } from 'node:module'; const require = __lecternCreateRequire(import.meta.url);" },
  logLevel: "info",
});

// dist 挂 type:module：main.cjs fork 的入口是 ESM（Electron 44 asar ESM 支持，
// 0.10.1 已验证能加载到模块解析层）。
writeFileSync("host/dist/package.json", '{"type":"module"}');
