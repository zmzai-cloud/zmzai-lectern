import { describe, expect, it } from "vitest";

import { formatForFilename } from "./limits.js";
import { sniffMediaType, verifyContent, verifyUpload } from "./sniff.js";
import { zipOf } from "./extract/fixtures.js";

const OLE2_HEAD = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function ole2(streamNames: readonly string[], padding = 4096): Uint8Array {
  const bytes = new Uint8Array(8 + padding);
  bytes.set(OLE2_HEAD, 0);
  let at = 8;
  for (const name of streamNames) {
    for (const char of name) {
      bytes[at] = char.charCodeAt(0);
      bytes[at + 1] = 0;
      at += 2;
    }
    at += 2;
  }
  return bytes;
}

function formatOf(name: string) {
  const format = formatForFilename(name);
  if (!format) throw new Error(`测试样本没有登记格式：${name}`);
  return format;
}

describe("sniffMediaType", () => {
  it("按文件头认 PDF / 图片 / OLE2 / ZIP", () => {
    expect(sniffMediaType(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffMediaType(ole2([]))).toBe("application/x-ole-storage");
    expect(sniffMediaType(zipOf({ "word/document.xml": "<x/>" }))).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("OOXML 三种格式按中央目录里的条目名区分（不解压）", () => {
    expect(sniffMediaType(zipOf({ "xl/workbook.xml": "<x/>" }))).toContain("spreadsheetml");
    expect(sniffMediaType(zipOf({ "ppt/presentation.xml": "<x/>" }))).toContain("presentationml");
  });
});

describe("verifyContent（扩展名与内容的交叉校验，规格 §6 / §13）", () => {
  it("改名的二进制过不了白名单（.exe 改名 .xlsx 不能放行）", () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    const verdict = verifyContent(formatOf("malware.xlsx"), exe);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("corrupted");
  });

  it("声明 PDF 实际是文本 → 拒绝而不是「按实际类型处理」", () => {
    const verdict = verifyContent(formatOf("fake.pdf"), new TextEncoder().encode("这就是一段普通文字"));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("unsupported_format");
  });

  it("加密的 OOXML（OLE2 + EncryptedPackage）报密码保护，文案指向「未加密副本」", () => {
    const verdict = verifyContent(formatOf("locked.xlsx"), ole2(["Root Entry", "EncryptionInfo", "EncryptedPackage"]));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("password_protected");
    expect(verdict.message).toContain("未加密");
  });

  it("旧版二进制改名成 .docx → 归类为格式不符，文案指向「另存为新版格式」", () => {
    const verdict = verifyContent(formatOf("legacy.docx"), ole2(["Root Entry", "WordDocument"]));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("unsupported_format");
    expect(verdict.message).toContain("另存为新版");
  });

  it("真正的 .xls（OLE2 + Workbook）正常放行——它不是加密，也不是格式不符", () => {
    const verdict = verifyContent(formatOf("old.xls"), ole2(["Root Entry", "Workbook"]));
    expect(verdict.ok).toBe(true);
  });

  it("CSV/TSV 与纯文本互通（都是纯文本字节）", () => {
    const bytes = new TextEncoder().encode("a,b\n1,2");
    expect(verifyContent(formatOf("data.csv"), bytes).ok).toBe(true);
    expect(verifyContent(formatOf("data.tsv"), bytes).ok).toBe(true);
    expect(verifyContent(formatOf("data.txt"), bytes).ok).toBe(true);
  });

  it("verifyUpload 从文件名一路判定到内容", () => {
    expect(verifyUpload("report.csv", new TextEncoder().encode("a,b")).ok).toBe(true);
    expect(verifyUpload("report.exe", new TextEncoder().encode("MZ")).ok).toBe(false);
  });
});
