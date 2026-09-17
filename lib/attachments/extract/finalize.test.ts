import { describe, expect, it } from "vitest";

import { EXTRACTION_LIMITS } from "@zmzai/agent-framework";

import { ExtractionFailure } from "./errors";
import { finalizeDocument, splitLongText, summarize } from "./finalize";

describe("finalizeDocument", () => {
  it("丢掉空节、保留 locator", () => {
    const document = finalizeDocument({
      attachmentId: "att_1",
      sections: [
        { id: "a", locator: { page: 1 }, text: "正文" },
        { id: "b", locator: { page: 2 }, text: "   \n  " },
      ],
    });
    expect(document.sections).toHaveLength(1);
    expect(document.sections[0]!.locator).toEqual({ page: 1 });
    expect(document.version).toBe(1);
  });

  it("没有任何正文时抛 no_extractable_text（而不是给一个空壳）", () => {
    expect(() => finalizeDocument({ attachmentId: "att_1", sections: [{ id: "a", locator: {}, text: " \n\t " }] })).toThrow(ExtractionFailure);
    try {
      finalizeDocument({ attachmentId: "att_1", sections: [] });
    } catch (error) {
      expect((error as ExtractionFailure).code).toBe("no_extractable_text");
    }
  });

  it("节 id 唯一：重复 id 会让「按 section_id 读取」一次返回多节", () => {
    const document = finalizeDocument({
      attachmentId: "att_1",
      sections: [
        { id: "p1", locator: { page: 1 }, text: "第一段" },
        { id: "p1", locator: { page: 2 }, text: "第二段" },
      ],
    });
    expect(new Set(document.sections.map((section) => section.id)).size).toBe(2);
  });

  it("警告去重并受上限约束", () => {
    const document = finalizeDocument({
      attachmentId: "att_1",
      sections: [{ id: "a", locator: {}, text: "正文" }],
      warnings: ["重复", "重复", " ", "另一条"],
    });
    expect(document.warnings).toEqual(["重复", "另一条"]);
  });

  it("正文超过总量上限时截断并写明（不静默丢内容）", () => {
    const chunk = "字".repeat(EXTRACTION_LIMITS.maxSectionChars - 1);
    const document = finalizeDocument({
      attachmentId: "att_1",
      sections: Array.from({ length: 25 }, (_, index) => ({ id: `s${index}`, locator: { page: index + 1 }, text: chunk })),
    });
    expect(document.warnings.some((warning) => warning.includes("上限"))).toBe(true);
    const total = document.sections.reduce((sum, section) => sum + section.text.length, 0);
    expect(total).toBeLessThanOrEqual(EXTRACTION_LIMITS.maxTotalChars);
  });

  it("标题超长被截断", () => {
    const document = finalizeDocument({
      attachmentId: "att_1",
      title: "标".repeat(1_000),
      sections: [{ id: "a", locator: {}, text: "正文" }],
    });
    expect(document.title!.length).toBeLessThanOrEqual(EXTRACTION_LIMITS.maxTitleChars);
  });
});

describe("splitLongText", () => {
  it("短文本不切", () => {
    expect(splitLongText("短", { page: 1 }, "p1")).toHaveLength(1);
  });

  it("超长文本按行切成多节，定位沿用同一 locator", () => {
    const line = "x".repeat(1_000);
    const text = Array.from({ length: 400 }, () => line).join("\n");
    const pieces = splitLongText(text, { page: 7 }, "p7");
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.locator.page === 7)).toBe(true);
    expect(new Set(pieces.map((piece) => piece.id)).size).toBe(pieces.length);
  });

  it("单行超长也能切（压缩成一行的 JSON 不会撑爆一节）", () => {
    const pieces = splitLongText("y".repeat(500_000), {}, "j1");
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.text.length <= EXTRACTION_LIMITS.maxSectionChars)).toBe(true);
  });
});

describe("summarize", () => {
  it("按 locator 统计页/表/幻灯片与字符数", () => {
    const document = finalizeDocument({
      attachmentId: "att_1",
      sections: [
        { id: "a", locator: { page: 1 }, text: "aa" },
        { id: "b", locator: { page: 2 }, text: "bbb" },
      ],
    });
    expect(summarize(document)).toEqual({ pages: 2, characters: 5 });
  });
});
