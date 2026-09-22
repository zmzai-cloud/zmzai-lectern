import { describe, expect, it } from "vitest";

import { bytesOf, zipOf } from "./fixtures.js";
import { ZIP_LIMITS, gateZipBytes, readZipDirectory, readZipEntries } from "./zip.js";

describe("ZIP 中央目录解析", () => {
  it("列出条目、方法与体积，且不解压", () => {
    const zip = zipOf({ "word/document.xml": "<x>hello</x>", "docProps/app.xml": "meta" });
    const result = readZipDirectory(zip);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((entry) => entry.name).sort()).toEqual(["docProps/app.xml", "word/document.xml"]);
    expect(result.entries.every((entry) => entry.uncompressedSize > 0)).toBe(true);
    expect(result.entries.every((entry) => entry.encrypted === false)).toBe(true);
  });

  it("不是 ZIP 时报损坏而不是抛异常", () => {
    const result = readZipDirectory(bytesOf("%PDF-1.4 这其实是个 PDF"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("corrupted");
  });

  it("截断的 ZIP 报损坏", () => {
    const zip = zipOf({ "a.xml": "<a/>" });
    const result = readZipDirectory(zip.subarray(0, zip.length - 30));
    expect(result.ok).toBe(false);
  });
});

describe("zip bomb 防护（规格 §13）", () => {
  it("条目数超限被拒", () => {
    const files: Record<string, string> = {};
    for (let index = 0; index <= ZIP_LIMITS.maxEntries; index += 1) files[`f${index}.xml`] = "x";
    const gate = gateZipBytes(zipOf(files));
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.message).toContain("条目数");
  });

  it("压缩比超限被拒（高压缩比的重复内容）", () => {
    // 一段高度可压缩的内容，压缩比远超 200
    const gate = gateZipBytes(zipOf({ "word/document.xml": "A".repeat(8 * 1024 * 1024) }));
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.message).toContain("压缩比");
  });

  it("合法的 XML 包通过", () => {
    const gate = gateZipBytes(zipOf({ "xl/workbook.xml": `<workbook>${"<sheet/>".repeat(200)}</workbook>` }));
    expect(gate.ok).toBe(true);
  });

  it("加密条目被识别为密码保护，而不是「损坏」", () => {
    // 手工把一个真实 ZIP 的通用位标记改成「已加密」：这是 §10.3 要求区分的两类失败
    const zip = zipOf({ "word/document.xml": "<x>secret</x>" });
    const at = findCentralDirectory(zip);
    zip[at + 8] = zip[at + 8]! | 0x01;
    const gate = gateZipBytes(zip);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.code).toBe("password_protected");
  });
});

describe("按名单解压", () => {
  it("只解压名单内的条目", () => {
    // 媒体条目用不可压缩的字节：真实的 PNG 已经压过，用重复字符会触发压缩比防护
    // （那说明防护是对的，但让这条用例测不到「按名单解压」这件事）
    const noise = new Uint8Array(50_000);
    for (let index = 0; index < noise.length; index += 1) noise[index] = (index * 2654435761) % 251;
    const zip = zipOf({ "ppt/slides/slide1.xml": "<a>第一张</a>", "ppt/media/image1.png": noise });
    const result = readZipEntries(zip, ["ppt/slides/"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.files.keys()]).toEqual(["ppt/slides/slide1.xml"]);
    expect(new TextDecoder().decode(result.files.get("ppt/slides/slide1.xml")!)).toBe("<a>第一张</a>");
  });

  it("解压前先过闸门：炸弹拿不到任何一个条目", () => {
    const files: Record<string, string> = {};
    for (let index = 0; index <= ZIP_LIMITS.maxEntries; index += 1) files[`ppt/slides/slide${index}.xml`] = "<a/>";
    const result = readZipEntries(zipOf(files), ["ppt/slides/"]);
    expect(result.ok).toBe(false);
  });

  it("名单没命中不算失败（只是没有内容）", () => {
    const result = readZipEntries(zipOf({ "ppt/slides/slide1.xml": "<a/>" }), ["word/document.xml"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.size).toBe(0);
  });
});

/** 找到第一个中央目录条目（签名 0x02014b50）的偏移。 */
function findCentralDirectory(zip: Uint8Array): number {
  for (let at = 0; at < zip.length - 4; at += 1) {
    // 前四位是 PK\x01\x02（小端 0x02014b50）
    if (zip[at] === 0x50 && zip[at + 1] === 0x4b && zip[at + 2] === 0x01 && zip[at + 3] === 0x02) return at;
  }
  throw new Error("样本里没有中央目录");
}
