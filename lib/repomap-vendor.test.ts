import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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


describe("打包布局锚点（LECTERN_REPOMAP_VENDOR）", () => {
  const base = mkdtempSync(path.join(tmpdir(), "repomap-env-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("env 注入的 node_modules 命中真实 wasm（app.asar 布局由 main.cjs 注入）", () => {
    mkdirSync(path.join(base, "web-tree-sitter"), { recursive: true });
    writeFileSync(path.join(base, "web-tree-sitter", "tree-sitter.wasm"), "wasm");
    mkdirSync(path.join(base, "tree-sitter-wasms", "out"), { recursive: true });
    writeFileSync(path.join(base, "tree-sitter-wasms", "out", "tree-sitter-javascript.wasm"), "wasm");
    process.env.LECTERN_REPOMAP_VENDOR = base;
    try {
      const dirs = repoMapVendorDirs();
      expect(dirs).not.toBeNull();
      expect(existsSync(path.join(dirs!.runtime, "tree-sitter.wasm"))).toBe(true);
    } finally {
      delete process.env.LECTERN_REPOMAP_VENDOR;
    }
  });

  it("env 指向不含 wasm 的目录时跳过（继续其余锚点，不假报）", () => {
    const empty = path.join(base, "empty");
    mkdirSync(empty, { recursive: true });
    process.env.LECTERN_REPOMAP_VENDOR = empty;
    try {
      const dirs = repoMapVendorDirs();
      // 本仓布局仍能命中（env 锚点失效回落自然锚点）
      expect(existsSync(path.join(dirs!.runtime, "tree-sitter.wasm"))).toBe(true);
    } finally {
      delete process.env.LECTERN_REPOMAP_VENDOR;
    }
  });
});
