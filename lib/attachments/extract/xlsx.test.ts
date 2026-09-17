import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { columnLetter, extractXlsx, valueToText } from "./xlsx";

async function xlsxBytes(build: (workbook: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

describe("columnLetter", () => {
  it("按 Excel 规则换算列号", () => {
    expect(columnLetter(1)).toBe("A");
    expect(columnLetter(26)).toBe("Z");
    expect(columnLetter(27)).toBe("AA");
    expect(columnLetter(52)).toBe("AZ");
    expect(columnLetter(53)).toBe("BA");
  });
});

describe("valueToText", () => {
  it("保留错误值（它是信息，替换成空串会让用户以为格子是空的）", () => {
    expect(valueToText({ error: "#REF!" })).toBe("#REF!");
  });

  it("富文本拼接", () => {
    expect(valueToText({ richText: [{ text: "加粗" }, { text: "常规" }] })).toBe("加粗常规");
  });

  it("超链接只取显示文本，不取 URL（§13 外链不传递）", () => {
    expect(valueToText({ text: "点这里", hyperlink: "https://example.com/secret" })).toBe("点这里");
  });

  it("公式取缓存结果，没有缓存结果时给出公式原文（绝不重算）", () => {
    expect(valueToText({ formula: "SUM(A1:A3)", result: 42 })).toBe("42");
    expect(valueToText({ formula: "SUM(A1:A3)" })).toBe("=SUM(A1:A3)");
  });

  it("日期用 ISO 字符串，避免本地时区把日期挪一天", () => {
    expect(valueToText(new Date(Date.UTC(2026, 8, 17)))).toBe("2026-09-17T00:00:00.000Z");
  });
});

describe("extractXlsx（真实 .xlsx 端到端）", () => {
  it("每个工作表按行区间分节，locator 带 sheet 与单元格范围", async () => {
    const bytes = await xlsxBytes((workbook) => {
      const sheet = workbook.addWorksheet("营收");
      sheet.addRow(["产品", "营收"]);
      sheet.addRow(["A", 700]);
      sheet.addRow(["B", 300]);
      const other = workbook.addWorksheet("备注");
      other.addRow(["说明"]);
    });
    const document = await extractXlsx({ attachmentId: "att_xlsx", bytes });
    const sheets = document.sections.map((section) => section.locator.sheet);
    expect(sheets).toEqual(["营收", "备注"]);
    expect(document.sections[0]!.locator.range).toBe("A1:B3");
    expect(document.sections[0]!.text).toBe("产品\t营收\nA\t700\nB\t300");
  });

  it("稀疏列按包围盒对齐，空单元格留位（否则列会错位）", async () => {
    const bytes = await xlsxBytes((workbook) => {
      const sheet = workbook.addWorksheet("S");
      sheet.getCell("A1").value = "左";
      sheet.getCell("C1").value = "右";
      sheet.getCell("A2").value = "x";
    });
    const document = await extractXlsx({ attachmentId: "att_xlsx", bytes });
    expect(document.sections[0]!.locator.range).toBe("A1:C2");
    expect(document.sections[0]!.text.split("\n")[0]).toBe("左\t\t右");
  });

  it("公式与超链接给出提示（用户要知道格子是算出来的）", async () => {
    const bytes = await xlsxBytes((workbook) => {
      const sheet = workbook.addWorksheet("S");
      sheet.getCell("A1").value = { formula: "1+1", result: 2 };
      sheet.getCell("A2").value = { text: "链接", hyperlink: "https://example.com" };
    });
    const document = await extractXlsx({ attachmentId: "att_xlsx", bytes });
    expect(document.warnings.some((warning) => warning.includes("公式"))).toBe(true);
    expect(document.warnings.some((warning) => warning.includes("超链接"))).toBe(true);
  });

  it("没有任何文本的工作簿报「未检测到可提取文本」", async () => {
    const bytes = await xlsxBytes((workbook) => {
      workbook.addWorksheet("空表");
    });
    await expect(extractXlsx({ attachmentId: "att_xlsx", bytes })).rejects.toMatchObject({ code: "no_extractable_text" });
  });

  it("不是 xlsx 报损坏（压缩包闸门先拦下）", async () => {
    await expect(extractXlsx({ attachmentId: "att_xlsx", bytes: new TextEncoder().encode("PK 假 zip") })).rejects.toMatchObject({ code: "corrupted" });
  });
});
