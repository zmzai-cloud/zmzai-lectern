import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveFrameworkVendorDirs } from "@zmzai/agent-framework";

export type RepoMapVendorDirs = { runtime: string; grammar: string };

/** 仓库地图的 wasm 资源目录（web-tree-sitter 运行时 + tree-sitter-wasms 语法包）。
 *
 *  框架的 resolveFrameworkVendorDirs 假定两者嵌套在框架包自己的 node_modules 下：
 *  pnpm（依赖与框架同级）和 npm 去重提升（扁平）布局都不成立。错误目录会经
 *  setWasmDirs 写进框架的进程级全局，之后同进程的 repo_map 工具也用它；而
 *  web-tree-sitter 的 emscripten 加载失败会直接结束进程——armed 下即 Host 崩溃
 *  （P0 2026-11-07 armed 端到端实测）。
 *
 *  这里从框架包真实位置按 Node 解析规则找依赖，并核对 wasm 文件确实存在；
 *  都找不到返回 null，调用方据此关闭能力，不去尝试加载。 */
export function repoMapVendorDirs(): RepoMapVendorDirs | null {
  // 打包布局（app.asar）：Host bundle 里的框架代码已被 esbuild 打卷、cwd 是
  // userData，两个自然锚点都失效——Electron 主进程用 LECTERN_REPOMAP_VENDOR
  // 显式注入 standalone 的 node_modules（asar 内的 fs 经 Electron 补丁可读）
  const injected = process.env.LECTERN_REPOMAP_VENDOR;
  const anchors: string[] = [];
  if (injected) anchors.push(path.join(injected, "package.json"));
  try {
    const nested = resolveFrameworkVendorDirs();
    // nested.runtime = <frameworkRoot>/node_modules/web-tree-sitter
    anchors.push(path.join(path.dirname(path.dirname(nested.runtime)), "package.json"));
  } catch {
    /* 框架包定位失败（如 cwd 下无 node_modules）：继续其他锚点 */
  }
  anchors.push(path.join(process.cwd(), "package.json"));
  if (process.argv[1]) anchors.push(path.resolve(process.argv[1]));
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor);
      const runtime = path.dirname(req.resolve("web-tree-sitter/tree-sitter.wasm"));
      const grammar = path.join(path.dirname(req.resolve("tree-sitter-wasms/package.json")), "out");
      if (existsSync(path.join(runtime, "tree-sitter.wasm")) && existsSync(path.join(grammar, "tree-sitter-javascript.wasm"))) {
        return { runtime: realpathSync(runtime), grammar: realpathSync(grammar) };
      }
    } catch {
      /* 该锚点解析不到：试下一个 */
    }
  }
  return null;
}
