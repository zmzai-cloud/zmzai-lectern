import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveFrameworkVendorDirs } from "@zmzai/agent-framework";
import { repoMapVendorDirs } from "./repomap-vendor.js";

/** P0 2026-11-07：框架 resolveFrameworkVendorDirs 拼的是嵌套路径，pnpm/npm 去重布局下
 *  不存在——带着它加载会让 emscripten 结束进程。解析器必须给出真实存在的 wasm 目录。 */
it("wasm 资源目录按 Node 解析规则定位且文件真实存在（框架嵌套路径在本布局下不存在）", () => {
  const nested = resolveFrameworkVendorDirs();
  expect(existsSync(path.join(nested.runtime, "tree-sitter.wasm"))).toBe(false); // 缺陷前提：嵌套路径不存在
  const dirs = repoMapVendorDirs();
  expect(dirs).not.toBeNull();
  expect(existsSync(path.join(dirs!.runtime, "tree-sitter.wasm"))).toBe(true);
  expect(existsSync(path.join(dirs!.grammar, "tree-sitter-javascript.wasm"))).toBe(true);
});
