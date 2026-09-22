import { describe, expect, it } from "vitest";

import { docxOf, paragraph } from "./fixtures.js";
import { extractDocx, htmlToLines } from "./docx.js";

describe("htmlToLines（mammoth 的 HTML → 带标题层级的行）", () => {
  it("标题保留层级，并渲染成 markdown 前缀", () => {
    expect(htmlToLines("<h1>总则</h1><p>正文一</p><h2>细则</h2><p>正文二</p>")).toEqual([
      { text: "# 总则", level: 1 },
      { text: "正文一" },
      { text: "## 细则", level: 2 },
      { text: "正文二" },
    ]);
  });

  it("列表项各占一行", () => {
    expect(htmlToLines("<ul><li>第一项</li><li>第二项</li></ul>").map((line) => line.text)).toEqual(["• 第一项", "• 第二项"]);
  });

  it("表格一行就是一行，单元格里的多段文字不会把行拆散", () => {
    const lines = htmlToLines("<table><tr><td><p>甲</p><p>乙</p></td><td>丙</td></tr><tr><td>丁</td><td>戊</td></tr></table>");
    expect(lines.map((line) => line.text)).toEqual(["甲 乙 | 丙", "丁 | 戊"]);
  });

  it("实体解码（&amp; 与数字引用）", () => {
    expect(htmlToLines("<p>A &amp; B &#65;</p>").map((line) => line.text)).toEqual(["A & B A"]);
  });

  it("空段落不产生空行（行号不能被空行冲淡）", () => {
    expect(htmlToLines("<p></p><p>有内容</p><p>   </p>").map((line) => line.text)).toEqual(["有内容"]);
  });
});

describe("extractDocx（真实 .docx 端到端）", () => {
  it("按标题分节，locator 是行区间（Word 没有真实页码）", async () => {
    const document = await extractDocx({
      attachmentId: "att_docx",
      filename: "合同.docx",
      bytes: docxOf(paragraph("采购合同", "Heading1") + paragraph("第一条 标的") + paragraph("第二条 价款", "Heading2") + paragraph("总价 700 万")),
    });
    expect(document.title).toBe("采购合同");
    // 两个标题各带自己的正文：h1 在第 1 行所以不与后面的标题合并
    expect(document.sections.map((section) => section.locator)).toEqual([
      { lineStart: 1, lineEnd: 2 },
      { lineStart: 3, lineEnd: 4 },
    ]);
    // 行号指向提取出的纯文本行，同一份文件两次解析必然一致
    const firstLine = document.sections[0]!.text.split("\n")[0];
    expect(firstLine).toBe("# 采购合同");
    expect(document.sections.every((section) => section.locator.page === undefined)).toBe(true);
  });

  it("识别到宏只给提示，不执行、不读内容", async () => {
    const document = await extractDocx({
      attachmentId: "att_docx",
      filename: "带宏.docx",
      bytes: docxOf(paragraph("正文"), { macro: true }),
    });
    expect(document.warnings.some((warning) => warning.includes("宏"))).toBe(true);
    expect(JSON.stringify(document)).not.toContain("fake-macro-project");
  });

  it("外部链接只计数、不访问", async () => {
    const document = await extractDocx({
      attachmentId: "att_docx",
      filename: "带链接.docx",
      bytes: docxOf(paragraph("见附件"), { externalLink: true }),
    });
    expect(document.warnings.some((warning) => warning.includes("外部链接"))).toBe(true);
  });

  it("不是 docx 报损坏，而不是把 mammoth 的原始错误抛出去", async () => {
    try {
      await extractDocx({ attachmentId: "att_docx", filename: "假的.docx", bytes: new TextEncoder().encode("PK 假装是 zip") });
      throw new Error("应当抛错");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("corrupted");
    }
  });
});
