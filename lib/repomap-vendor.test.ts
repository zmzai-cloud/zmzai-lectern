import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveFrameworkVendorDirs } from "@zmzai/agent-framework";
import { repoMapVendorDirs } from "./repomap-vendor.js";

/** P0 2026-11-07 发现、0.18.1 修复：框架 resolveFrameworkVendorDirs 曾只拼嵌套路径
 *  （pnpm/npm 去重布局不存在，emscripten 失败会结束进程）。vendor 0.18.1 起框架
 *  自身按布局解析并核对存在；本测试同时钉住「框架解析结果」与「Lectern 兜底解析
 *  结果」都指向真实存在的 wasm（Host bundle 的 cwd 无 node_modules，兜底仍必要）。 */
it("框架 0.18.1 与 Lectern 兜底解析都给出真实存在的 wasm 目录（且一致）", () => {
  const fromFramework = resolveFrameworkVendorDirs();
  expect(existsSync(path.join(fromFramework.runtime, "tree-sitter.wasm"))).toBe(true);
  const dirs = repoMapVendorDirs();
  expect(dirs).not.toBeNull();
  expect(existsSync(path.join(dirs!.runtime, "tree-sitter.wasm"))).toBe(true);
  expect(existsSync(path.join(dirs!.grammar, "tree-sitter-javascript.wasm"))).toBe(true);
  expect(dirs!.runtime).toBe(fromFramework.runtime);
});
