import { describe, expect, it } from "vitest";

import { classifyFileBytes, looksBinaryHead } from "./file-content";

/**
 * 回归夹具：一份**零 NUL、99.97% 可打印 ASCII** 的 PDF。
 *
 * 这不是随手编的字节：ReportLab（生成贴纸页那个库）默认写出未压缩的对象流，
 * 字体宽度数组是一长串十进制数字，整个文件只有 4 个非 ASCII 字节。旧判据
 * `buf.includes(0)` 对它无话可说，于是它被当成文本送进了编辑器——用户看到的
 * 是 `/BaseFont /STSong-Light …`。
 */
const ASCII_PDF = Buffer.from(
  "%PDF-1.4\n%\x93\x8c\x8b\x9e ReportLab Generated PDF document (opensource)\n" +
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>\nendobj\n" +
    "4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 24 Tf 72 720 Td (xiaoman) Tj ET\nendstream\nendobj\n" +
    "5 0 obj\n<< /BaseFont /STSong-Light /Encoding /WinAnsiEncoding /W [ 1 [ 207 270 342 ] ] >>\nendobj\n" +
    "trailer\n<< /Root 1 0 R /Size 6 >>\n%%EOF\n",
  "latin1",
);

const text = (s: string) => Buffer.from(s, "utf8");

describe("classifyFileBytes：确凿的文件头", () => {
  it("零 NUL 的 PDF 仍然是二进制（旧判据与占比判据都放它过去）", () => {
    // 先把「夹具确实复现了那个陷阱」钉死，否则这条测试哪天会悄悄失去意义：
    // 零 NUL、可打印占比远超 0.9——旧判据和占比判据都会说它是文本，
    // **唯一的证据是开头那 5 个字节 `%PDF-`**。
    expect(ASCII_PDF.includes(0)).toBe(false);
    const printable = [...ASCII_PDF].filter((b) => b >= 0x20).length / ASCII_PDF.length;
    expect(printable).toBeGreaterThan(0.9);

    expect(classifyFileBytes(ASCII_PDF)).toEqual({ text: false, mediaType: "application/pdf" });
  });

  it("判据的边界就在这里：把文件头摘掉就抓不住了", () => {
    // 这条不是「期望行为」，是把已知边界写下来：没有可识别文件头、又足够像 ASCII 的
    // 字节流，从内容上无法与文本区分。新增格式时该往嗅探表里加一行，而不是调阈值。
    expect(classifyFileBytes(ASCII_PDF.subarray(8))).toEqual({ text: true, mediaType: "text/plain" });
  });

  it.each([
    ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])],
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])],
    ["image/gif", Buffer.concat([text("GIF89a"), Buffer.from([0x40, 0x01, 0x40, 0x01])])],
    ["image/webp", Buffer.concat([text("RIFF"), Buffer.from([0x24, 0, 0, 0]), text("WEBPVP8 ")])],
    ["application/zip", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(20)])],
    ["application/x-ole-storage", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])],
  ])("文件头是 %s → 二进制", (mediaType, bytes) => {
    expect(classifyFileBytes(bytes)).toEqual({ text: false, mediaType });
  });

  it("OOXML 容器按中央目录里的条目名认出来", () => {
    const docx = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(8),
      text("word/document.xml"),
      Buffer.alloc(8),
    ]);
    expect(classifyFileBytes(docx)).toEqual({
      text: false,
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });
});

describe("classifyFileBytes：通篇 NUL", () => {
  it("NUL 落在嗅探窗口（前 8KB）之外也照样是二进制", () => {
    // `.wasm` 的 \0asm、SQLite 的文件头都靠这条。嗅探表只看前 8KB，这里不能跟着漏。
    const bytes = Buffer.concat([text("a".repeat(9000)), Buffer.from([0])]);
    expect(classifyFileBytes(bytes)).toEqual({ text: false, mediaType: null });
  });
});

describe("classifyFileBytes：文本", () => {
  it("空文件是文本（编辑器打开是空的，不是「打不开」）", () => {
    expect(classifyFileBytes(Buffer.alloc(0))).toEqual({ text: true, mediaType: "text/plain" });
  });

  it("纯 ASCII 源码", () => {
    expect(classifyFileBytes(text("export const a = 1;\n"))).toEqual({ text: true, mediaType: "text/plain" });
  });

  it("中文注释（多字节 UTF-8 不该被当成不可打印）", () => {
    expect(classifyFileBytes(text("# 小满的车车们 · 贴纸\n"))).toEqual({ text: true, mediaType: "text/plain" });
  });

  it("GBK 编码的文本仍可打开——占比判据认得 8bit 文本", () => {
    // 「中文测试」的 GBK 字节：解不成 UTF-8，但每一个字节都可打印。
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
    expect(gbk.toString("utf8")).not.toContain("中文"); // 确认夹具确实是非法 UTF-8
    expect(classifyFileBytes(gbk)).toEqual({ text: true, mediaType: "text/plain" });
  });

  it("制表符与换行不算「不可打印」", () => {
    expect(classifyFileBytes(text("a\tb\r\nc\n"))).toEqual({ text: true, mediaType: "text/plain" });
  });
});

describe("classifyFileBytes：认不出文件头的非文本", () => {
  it("低控制字节密集 → 二进制（没有 NUL、也没有已知文件头）", () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 0x0b, 0x0e, 0x1f, 0x1c]);
    expect(classifyFileBytes(bytes)).toEqual({ text: false, mediaType: null });
  });

  it("一半字节是控制符的混合内容 → 二进制", () => {
    const bytes = Buffer.concat([text("aaaa"), Buffer.from([1, 2, 3, 4])]);
    expect(classifyFileBytes(bytes)).toEqual({ text: false, mediaType: null });
  });
});

describe("looksBinaryHead：只给大文件用的一截判定", () => {
  it("头部命中已知格式 → 确凿二进制", () => {
    expect(looksBinaryHead(ASCII_PDF.subarray(0, 8192))).toBe(true);
  });

  it("头部有 NUL → 确凿二进制", () => {
    expect(looksBinaryHead(Buffer.from([0x61, 0x62, 0x00, 0x63]))).toBe(true);
  });

  it("文本头部不报二进制——大文件该被说成「过大」而不是「格式不对」", () => {
    expect(looksBinaryHead(text("export const a = 1;\n").subarray(0, 8192))).toBe(false);
  });

  it("截断的多字节字符不会被误判（这正是它不做占比判定的原因）", () => {
    const head = text("小满的车车们").subarray(0, 7); // 切断最后一格
    expect(looksBinaryHead(head)).toBe(false);
  });
});
