import { afterAll, describe, expect, it, vi } from "vitest";

/** 工作区根：临时目录，路由通过被 mock 的 runtime 取到它。 */
const state = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path");
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), "lectern-preview-route-")) };
});
vi.mock("@/lib/runtime", () => ({ workspaceRootForSession: () => state.root }));

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { GET } from "../app/api/preview/[sessionId]/[...filePath]/route";

const PDF = Buffer.from("%PDF-1.4\n%%EOF\n", "latin1");
mkdirSync(path.join(state.root, "dist"), { recursive: true });
writeFileSync(path.join(state.root, "dist", "sticker-sheet.pdf"), PDF);
writeFileSync(path.join(state.root, "dist", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
writeFileSync(path.join(state.root, "dist", "poster.html"), "<h1>hi</h1>", "utf8");
writeFileSync(path.join(state.root, "dist", "blob.bin"), Buffer.from([1, 2, 3]));

afterAll(() => rmSync(state.root, { recursive: true, force: true }));

const open = (segments: string[]) =>
  GET(new Request("http://localhost"), { params: Promise.resolve({ sessionId: "_", filePath: segments }) });

describe("GET /api/preview：交给浏览器渲染的内容类型", () => {
  /**
   * 【为什么这条是必要的】画布对 PDF 用的是 `<iframe src=…>`：能画出来全靠这里
   * 回的是 `application/pdf`。回成 `application/octet-stream` 时浏览器只会下载它，
   * iframe 里一片空白——而这类失败在界面上不会报错，看起来就像「PDF 渲染挂了」。
   */
  it("PDF 回 application/pdf（画布靠它触发阅读器）", async () => {
    const response = await open(["dist", "sticker-sheet.pdf"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await response.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it.each([
    ["dist/shot.png", "image/png"],
    ["dist/poster.html", "text/html; charset=utf-8"],
  ])("%s 的类型保持原样（%s）", async (rel, expected) => {
    const response = await open(rel.split("/"));
    expect(response.headers.get("content-type")).toBe(expected);
  });

  it("认不出的扩展名给 application/octet-stream，而不是猜", async () => {
    expect((await open(["dist", "blob.bin"])).headers.get("content-type")).toBe("application/octet-stream");
  });

  it("不存在的文件 404，且带上原因", async () => {
    const response = await open(["dist", "missing.pdf"]);
    expect(response.status).toBe(404);
    expect(await response.text()).toBeTruthy();
  });
});
