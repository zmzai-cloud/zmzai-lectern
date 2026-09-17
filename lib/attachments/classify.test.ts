import { describe, expect, it } from "vitest";

import { classifyFile, sanitizeFilename, validateClientFile, validateReferencePath } from "./classify";
import { ATTACHMENT_LIMITS, acceptAttribute, formatBytes, formatForFilename, supportedFormatsSummary } from "./limits";

const MB = 1024 * 1024;

describe("sanitizeFilename", () => {
  it("只保留 basename，POSIX 与 Windows 分隔符都切断", () => {
    expect(sanitizeFilename("/Users/someone/合同.pdf")).toBe("合同.pdf");
    // 关键回归：`\\` 不切断的话，macOS 上会把整个 C:\Users\… 展示出去（规格 §13）
    expect(sanitizeFilename("C:\\Users\\me\\Documents\\report.docx")).toBe("report.docx");
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
  });

  it("剔除控制字符与 NUL", () => {
    expect(sanitizeFilename("a\u0000b.txt")).toBe("ab.txt");
    expect(sanitizeFilename("tab\tname.txt")).toBe("tabname.txt");
  });

  it("拒绝空名、纯点与超长名", () => {
    expect(sanitizeFilename("")).toBeNull();
    expect(sanitizeFilename("   ")).toBeNull();
    expect(sanitizeFilename(".")).toBeNull();
    expect(sanitizeFilename("..")).toBeNull();
    expect(sanitizeFilename(`${"x".repeat(ATTACHMENT_LIMITS.maxFilenameLength + 1)}.txt`)).toBeNull();
  });
});

describe("classifyFile", () => {
  it("识别规格 §6 的每一种格式", () => {
    const cases: Array<[string, string, string]> = [
      ["a.pdf", "document", "pdf"],
      ["a.docx", "document", "docx"],
      ["a.xlsx", "spreadsheet", "xlsx"],
      ["a.xls", "spreadsheet", "xls"],
      ["a.csv", "spreadsheet", "csv"],
      ["a.tsv", "spreadsheet", "tsv"],
      ["a.pptx", "presentation", "pptx"],
      ["a.md", "text", "text"],
      ["a.ts", "text", "text"],
      ["a.yaml", "text", "text"],
      ["a.png", "image", "image"],
      ["a.JPEG", "image", "image"],
    ];
    for (const [name, kind, formatId] of cases) {
      const result = classifyFile({ name, type: "", size: 10 });
      expect(result.ok, name).toBe(true);
      if (!result.ok) continue;
      expect(result.value.kind, name).toBe(kind);
      expect(result.value.format.id, name).toBe(formatId);
    }
  });

  it("拒绝可执行文件、安装包与任意二进制（规格 §4.2）", () => {
    for (const name of ["setup.exe", "app.dmg", "pkg.deb", "disk.iso", "lib.so", "archive.zip", "a.rar", "a.7z"]) {
      const result = classifyFile({ name, type: "application/octet-stream", size: 100 });
      expect(result.ok, name).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("unsupported_format");
    }
  });

  it("无扩展名时按声明 MIME 兜底", () => {
    const result = classifyFile({ name: "no-extension", type: "application/pdf", size: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.format.id).toBe("pdf");
  });

  it("扩展名与声明 MIME 冲突时以扩展名归属，交给服务端嗅探复核", () => {
    // 浏览器常见误报：把 .md 报成 application/octet-stream
    const result = classifyFile({ name: "notes.md", type: "application/octet-stream", size: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.format.id).toBe("text");
  });

  it("无扩展名且 MIME 不可用时报明确原因", () => {
    const result = classifyFile({ name: "README", type: "", size: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported_format");
  });
});

describe("validateClientFile", () => {
  it("超过单格式上限时给出具体限制", () => {
    const pdf = validateClientFile({ name: "big.pdf", type: "application/pdf", size: 26 * MB });
    expect(pdf.ok).toBe(false);
    if (!pdf.ok) {
      expect(pdf.error.code).toBe("too_large");
      expect(pdf.error.message).toContain("25MB");
    }
    // 文本上限 2MB：同一份文件在文本格式下必须被拒，证明上限是按格式而非按 kind
    const txt = validateClientFile({ name: "big.txt", type: "text/plain", size: 3 * MB });
    expect(txt.ok).toBe(false);
    if (!txt.ok) expect(txt.error.code).toBe("too_large");
  });

  it("0 字节文件被拒", () => {
    const result = validateClientFile({ name: "empty.txt", type: "text/plain", size: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("empty_file");
  });

  it("超过数量上限", () => {
    const existing = Array.from({ length: ATTACHMENT_LIMITS.maxLocalPerMessage }, (_, i) => ({ name: `f${i}.txt`, size: 10 }));
    const result = validateClientFile({ name: "extra.txt", type: "text/plain", size: 10 }, existing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("too_many");
  });

  it("同名同大小视为重复", () => {
    const result = validateClientFile({ name: "a.txt", type: "text/plain", size: 10 }, [{ name: "a.txt", size: 10 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("duplicate");
    // 同名不同大小不算重复（用户可能就是要传两个版本）
    expect(validateClientFile({ name: "a.txt", type: "text/plain", size: 11 }, [{ name: "a.txt", size: 10 }]).ok).toBe(true);
  });

  it("总量上限（每个文件都没超，合计超）", () => {
    const existing = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.pdf`, size: 8 * MB }));
    const result = validateClientFile({ name: "last.pdf", type: "application/pdf", size: 8 * MB }, existing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("total_too_large");
  });
});

describe("validateReferencePath", () => {
  it("接受工作区内的相对路径", () => {
    const result = validateReferencePath("src/components/Composer.tsx");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe("src/components/Composer.tsx");
    expect(validateReferencePath("./docs/spec.md").ok).toBe(true);
  });

  it("拒绝绝对路径、盘符与穿越段（规格 §5.2）", () => {
    for (const raw of ["/etc/passwd", "C:\\Windows\\system32", "../../secret", "a/../../b", "a\\..\\..\\b"]) {
      const result = validateReferencePath(raw);
      expect(result.ok, raw).toBe(false);
    }
  });

  it("拒绝控制字符与超长路径", () => {
    expect(validateReferencePath("a\u0000b").ok).toBe(false);
    expect(validateReferencePath("x".repeat(1025)).ok).toBe(false);
    expect(validateReferencePath("").ok).toBe(false);
    expect(validateReferencePath(undefined).ok).toBe(false);
  });
});

describe("格式表推导出的 UI 契约", () => {
  it("accept 属性覆盖所有格式且不含可执行文件", () => {
    const accept = acceptAttribute();
    expect(accept).toContain(".pdf");
    expect(accept).toContain(".docx");
    expect(accept).toContain(".xlsx");
    expect(accept).toContain(".pptx");
    expect(accept).toContain(".md");
    expect(accept).toContain("image/*");
    expect(accept).not.toContain(".exe");
    expect(accept).not.toContain(".zip");
  });

  it("扩展名匹配大小写不敏感", () => {
    expect(formatForFilename("REPORT.PDF")?.id).toBe("pdf");
    expect(formatForFilename("no-extension")).toBeNull();
  });

  it("mediaType 按扩展名精确推导，不采信浏览器声明", () => {
    // 回归：曾经 .jpeg 会回落到 format.mediaTypes[0]，被报成 image/png
    const jpeg = classifyFile({ name: "photo.jpeg", type: "image/png", size: 10 });
    expect(jpeg.ok).toBe(true);
    if (jpeg.ok) expect(jpeg.value.mediaType).toBe("image/jpeg");

    const md = classifyFile({ name: "notes.md", type: "application/octet-stream", size: 10 });
    expect(md.ok).toBe(true);
    if (md.ok) expect(md.value.mediaType).toBe("text/markdown");

    const csv = classifyFile({ name: "rows.csv", type: "text/plain", size: 10 });
    expect(csv.ok).toBe(true);
    if (csv.ok) expect(csv.value.mediaType).toBe("text/csv");
  });

  it("formatBytes 输出人类可读大小", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * MB)).toBe("5.0 MB");
    expect(formatBytes(Number.NaN)).toBe("—");
  });

  it("支持格式摘要涵盖全部格式标签", () => {
    expect(supportedFormatsSummary()).toContain("PDF");
    expect(supportedFormatsSummary()).toContain("图片");
  });
});
