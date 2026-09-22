import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { resolveCwdWithin } from "./delivery-path.js";

const ROOT = resolve("/tmp/workspace-root");

describe("resolveCwdWithin（required 命令 cwd 安全守卫）", () => {
  it("空 / . / 缺省 解析到 root 本身", () => {
    expect(resolveCwdWithin(ROOT, "")).toBe(ROOT);
    expect(resolveCwdWithin(ROOT, ".")).toBe(ROOT);
    expect(resolveCwdWithin(ROOT, null)).toBe(ROOT);
  });

  it("root 相对路径解析到 root 内", () => {
    expect(resolveCwdWithin(ROOT, "packages/app")).toBe(resolve(ROOT, "packages/app"));
  });

  it("拒绝绝对路径", () => {
    expect(() => resolveCwdWithin(ROOT, "/etc")).toThrow();
    expect(() => resolveCwdWithin(ROOT, "/tmp/workspace-root/sub")).toThrow();
  });

  it("拒绝 .. 逃逸", () => {
    expect(() => resolveCwdWithin(ROOT, "../other")).toThrow();
    expect(() => resolveCwdWithin(ROOT, "a/../../other")).toThrow();
  });

  it("拒绝 .. 逃逸出 root", () => {
    // a/../../etc 从 root 出发规范化到 /tmp/etc（越出 root）
    expect(() => resolveCwdWithin(ROOT, "a/../../etc")).toThrow();
    expect(() => resolveCwdWithin(ROOT, "../../etc")).toThrow();
  });

  it("拒绝跨 root（目标不在 root 前缀内）", () => {
    expect(() => resolveCwdWithin(ROOT, "../../outside")).toThrow();
  });
});
