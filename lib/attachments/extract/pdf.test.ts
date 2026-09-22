import { describe, expect, it } from "vitest";

import { ExtractionFailure } from "./errors.js";
import { pdfOf } from "./fixtures.js";
import { extractPdf, linesFromEol, linesFromTransform, pageLines, summarizePageList } from "./pdf.js";

describe("PDF 行重建", () => {
  it("优先用 hasEOL，跳过换行标记产生的空片段", () => {
    expect(
      linesFromEol([
        { str: "第一行", transform: [12, 0, 0, 12, 72, 720], hasEOL: false },
        { str: "", transform: [12, 0, 0, 12, 72, 700], hasEOL: true },
        { str: "第二行", transform: [12, 0, 0, 12, 72, 700], hasEOL: false },
      ]),
    ).toEqual(["第一行", "第二行"]);
  });

  it("没有 hasEOL 时按基线变化切行", () => {
    expect(
      linesFromTransform([
        { str: "alpha", transform: [12, 0, 0, 12, 72, 700] },
        { str: " beta", transform: [12, 0, 0, 12, 100, 700] },
        { str: "gamma", transform: [12, 0, 0, 12, 72, 682] },
      ]),
    ).toEqual(["alpha beta", "gamma"]);
  });

  it("同一行内的片段直接拼接，不自己补空格（补空格就是篡改正文）", () => {
    expect(
      linesFromTransform([
        { str: "He", transform: [1, 0, 0, 1, 0, 10] },
        { str: "llo", transform: [1, 0, 0, 1, 10, 10] },
      ]),
    ).toEqual(["Hello"]);
  });

  it("pageLines 在有 hasEOL 时不用基线判断", () => {
    // 同一基线但带 hasEOL：说明 pdfjs 判定这里换行（例如两栏排版）
    expect(
      pageLines([
        { str: "左栏", transform: [1, 0, 0, 1, 0, 100], hasEOL: true },
        { str: "右栏", transform: [1, 0, 0, 1, 0, 100], hasEOL: false },
      ]),
    ).toEqual(["左栏", "右栏"]);
  });
});

describe("summarizePageList", () => {
  it("连续页码压缩成区间（否则一份 300 页扫描件会产生一条几百字的警告）", () => {
    expect(summarizePageList([1, 2, 3, 7, 9, 10, 11])).toBe("1–3、7、9–11");
    expect(summarizePageList([5])).toBe("5");
  });
});

describe("extractPdf（真实 PDF 端到端）", () => {
  it("每页一节，locator 是真实页码", async () => {
    const document = await extractPdf({
      attachmentId: "att_pdf",
      bytes: pdfOf([
        ["Quarterly Report", "Revenue 700"],
        ["Appendix"],
      ]),
    });
    expect(document.sections).toHaveLength(2);
    expect(document.sections[0]!.locator).toEqual({ page: 1 });
    expect(document.sections[0]!.text).toContain("Quarterly Report");
    expect(document.sections[0]!.text).toContain("Revenue 700");
    expect(document.sections[1]!.locator).toEqual({ page: 2 });
    expect(document.sections[1]!.text).toContain("Appendix");
  });

  it("全空白页的 PDF 报「未检测到可提取文本」而不是返回空文档", async () => {
    await expect(extractPdf({ attachmentId: "att_pdf", bytes: pdfOf([[]]) })).rejects.toThrow(ExtractionFailure);
    try {
      await extractPdf({ attachmentId: "att_pdf", bytes: pdfOf([[]]) });
    } catch (error) {
      expect((error as ExtractionFailure).code).toBe("no_extractable_text");
    }
  });

  it("不是 PDF 报损坏（不是抛原始异常）", async () => {
    try {
      await extractPdf({ attachmentId: "att_pdf", bytes: new TextEncoder().encode("这不是 PDF") });
      throw new Error("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(ExtractionFailure);
      expect((error as ExtractionFailure).code).toBe("corrupted");
    }
  });
});
