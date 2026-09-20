import { afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/** 工作区根：临时目录，路由通过被 mock 的 runtime 取到它。 */
const state = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path");
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), "lectern-fs-route-")) };
});
vi.mock("@/lib/runtime", () => ({ workspaceRootForSession: () => state.root }));

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { GET } from "../app/api/fs/file/route";

/** 与真实产物同形：零 NUL、几乎全是可打印 ASCII 的 PDF（ReportLab 的写法）。 */
const ASCII_PDF = Buffer.from(
  "%PDF-1.4\n%\x93\x8c\x8b\x9e ReportLab Generated PDF document (opensource)\n" +
    "1 0 obj\n<< /BaseFont /STSong-Light /W [ 1 [ 207 270 342 ] ] >>\nendobj\n" +
    "trailer\n<< /Size 2 >>\n%%EOF\n",
  "latin1",
);

mkdirSync(path.join(state.root, "dist"), { recursive: true });
mkdirSync(path.join(state.root, "empty-dir"), { recursive: true });
writeFileSync(path.join(state.root, "dist", "sticker-sheet.pdf"), ASCII_PDF);
writeFileSync(path.join(state.root, "notes.md"), "# 小满的车车们\n\n贴纸页。\n", "utf8");
writeFileSync(path.join(state.root, "blank.txt"), "");
writeFileSync(path.join(state.root, "big.txt"), "a".repeat(600 * 1024), "utf8");
writeFileSync(path.join(state.root, "big.pdf"), Buffer.concat([Buffer.from("%PDF-1.4\n", "latin1"), Buffer.from("a".repeat(600 * 1024))]));

afterAll(() => rmSync(state.root, { recursive: true, force: true }));

const read = (rel: string) => GET(new NextRequest(`http://localhost/api/fs/file?path=${encodeURIComponent(rel)}`));

describe("GET /api/fs/file：二进制不再是「错误」", () => {
  it("零 NUL 的 PDF 返回 binary（200，不是 4xx、也不是源码）", async () => {
    const response = await read("dist/sticker-sheet.pdf");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "dist/sticker-sheet.pdf",
      size: ASCII_PDF.length,
      content: "",
      binary: true,
      mediaType: "application/pdf",
    });
  });

  it("文本文件照旧带内容（并且明说不是二进制）", async () => {
    const response = await read("notes.md");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "notes.md",
      size: Buffer.byteLength("# 小满的车车们\n\n贴纸页。\n", "utf8"),
      content: "# 小满的车车们\n\n贴纸页。\n",
      binary: false,
      mediaType: "text/plain",
    });
  });

  it("空文件是文本——编辑器打开是空的，不是「打不开」", async () => {
    const body = await (await read("blank.txt")).json();
    expect(body).toMatchObject({ binary: false, content: "" });
  });
});

describe("GET /api/fs/file：超过文本上限时的两条不同归因", () => {
  it("大文本 → 400，说「过大」（用户能做的事是换终端看）", async () => {
    const response = await read("big.txt");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("文件过大");
  });

  it("大 PDF → 200 binary，说「是二进制」（不该叫用户去把它变小）", async () => {
    const response = await read("big.pdf");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ binary: true, mediaType: "application/pdf", content: "" });
  });
});

describe("GET /api/fs/file：真正的失败仍然走 4xx", () => {
  it("目录", async () => {
    expect((await read("empty-dir")).status).toBe(400);
  });

  it("工作区外的路径", async () => {
    const response = await read("../../etc/passwd");
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("缺少 path", async () => {
    expect((await GET(new NextRequest("http://localhost/api/fs/file"))).status).toBe(400);
  });
});
