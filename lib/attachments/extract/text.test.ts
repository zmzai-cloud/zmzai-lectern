import { describe, expect, it } from "vitest";

import { ExtractionFailure } from "./errors.js";
import { bytesOf } from "./fixtures.js";
import { extractPlainText, splitRecords } from "./text.js";

describe("splitRecords（CSV 引号规则）", () => {
  it("引号内的分隔符属于单元格内容", () => {
    const { records } = splitRecords('a,"北京, 朝阳",c\n1,2,3', ",", 100);
    expect(records).toEqual([
      ["a", "北京, 朝阳", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("引号内的换行不切行（否则此后所有行号都是错的）", () => {
    const { records } = splitRecords('a,"第一行\n第二行",c\nx,y,z', ",", 100);
    expect(records).toHaveLength(2);
    expect(records[0]![1]).toBe("第一行\n第二行");
    expect(records[1]).toEqual(["x", "y", "z"]);
  });

  it("双写引号还原成一个引号", () => {
    const { records } = splitRecords('a,"他说""你好""",c', ",", 100);
    expect(records[0]![1]).toBe('他说"你好"');
  });

  it("CRLF 与末尾无换行都能处理", () => {
    expect(splitRecords("a,b\r\nc,d", ",", 100).records).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(splitRecords("a,b", ",", 100).records).toEqual([["a", "b"]]);
  });

  it("超过记录上限时截断并标记", () => {
    const text = Array.from({ length: 50 }, (_, index) => `r${index},x`).join("\n");
    const { records, truncated } = splitRecords(text, ",", 10);
    expect(records).toHaveLength(10);
    expect(truncated).toBe(true);
  });
});

describe("extractPlainText（文本 / CSV / TSV）", () => {
  it("文本按行分节，locator 是真实行号", () => {
    const lines = Array.from({ length: 450 }, (_, index) => `第 ${index + 1} 行`);
    const document = extractPlainText({ attachmentId: "att_1", filename: "note.txt", bytes: bytesOf(lines.join("\n")) });
    expect(document.sections.length).toBeGreaterThan(1);
    expect(document.sections[0]!.locator).toEqual({ lineStart: 1, lineEnd: 200 });
    expect(document.sections[1]!.locator).toEqual({ lineStart: 201, lineEnd: 400 });
    expect(document.sections[0]!.text.startsWith("第 1 行\n")).toBe(true);
  });

  it("行号与正文对得上（第 201 行确实在第 201 行）", () => {
    const lines = Array.from({ length: 250 }, (_, index) => `line-${index + 1}`);
    const document = extractPlainText({ attachmentId: "att_1", filename: "note.txt", bytes: bytesOf(lines.join("\n")) });
    const second = document.sections[1]!;
    expect(second.locator.lineStart).toBe(201);
    expect(second.text.split("\n")[0]).toBe("line-201");
  });

  it("CSV 表头与数据行对齐渲染（制表符分隔，便于模型按列读）", () => {
    const document = extractPlainText({
      attachmentId: "att_1",
      filename: "report.csv",
      bytes: bytesOf("产品,营收\nA,700\nB,300"),
      delimiter: ",",
    });
    expect(document.sections[0]!.text).toBe("产品\t营收\nA\t700\nB\t300");
    expect(document.sections[0]!.locator).toEqual({ lineStart: 1, lineEnd: 3 });
  });

  it("大批量 CSV 会在警告里给出总行数，便于按区间读取", () => {
    const rows = Array.from({ length: 300 }, (_, index) => `${index},x`).join("\n");
    const document = extractPlainText({ attachmentId: "att_1", filename: "big.csv", bytes: bytesOf(rows), delimiter: "," });
    expect(document.warnings.some((warning) => warning.includes("300 行"))).toBe(true);
  });

  it("空文件报损坏", () => {
    expect(() => extractPlainText({ attachmentId: "att_1", filename: "empty.txt", bytes: new Uint8Array() })).toThrow(ExtractionFailure);
  });

  it("非 UTF-8 文本给明确警告而不是静默乱码（也不猜编码）", () => {
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x0a]); // "中文" 的 GBK 字节
    const document = extractPlainText({ attachmentId: "att_1", filename: "gbk.txt", bytes: gbk });
    expect(document.warnings.some((warning) => warning.includes("UTF-8"))).toBe(true);
  });
});
