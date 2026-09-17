import { describe, expect, it } from "vitest";

import { pptxOf } from "./fixtures";
import { extractPptx, normalizePartPath, paragraphLines, relationIdByType, relationTarget, slideOrder } from "./pptx";

describe("paragraphLines（形与文本体）", () => {
  it("一个段落里的多个 run 拼成一行（换字体会把一句话拆成多个 run）", () => {
    const xml = "<p:txBody><a:p><a:r><a:t>这是</a:t></a:r><a:r><a:t>一句话</a:t></a:r></a:p></p:txBody>";
    expect(paragraphLines(xml)).toEqual(["这是一句话"]);
  });

  it("多个段落各占一行", () => {
    const xml = "<a:p><a:r><a:t>第一行</a:t></a:r></a:p><a:p><a:r><a:t>第二行</a:t></a:r></a:p>";
    expect(paragraphLines(xml)).toEqual(["第一行", "第二行"]);
  });

  it("段内强制换行（a:br）产生新行", () => {
    const xml = "<a:p><a:r><a:t>上一段</a:t></a:r><a:br/><a:r><a:t>下一段</a:t></a:r></a:p>";
    expect(paragraphLines(xml)).toEqual(["上一段", "下一段"]);
  });

  it("空段落不产生空行", () => {
    expect(paragraphLines("<a:p><a:r><a:t>有内容</a:t></a:r></a:p><a:p></a:p>")).toEqual(["有内容"]);
  });
});

describe("关系解析", () => {
  const rels =
    '<Relationships><Relationship Id="rId1" Type="http://x/slide" Target="slides/slide2.xml"/>' +
    '<Relationship Id="rId2" Type="http://x/hyperlink" Target="https://example.com" TargetMode="External"/>' +
    '<Relationship Id="rId3" Type="http://x/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>';

  it("按 Id 取目标", () => {
    expect(relationTarget(rels, "rId1")).toBe("slides/slide2.xml");
  });

  it("外部关系不返回目标（§13 不跟随外链）", () => {
    expect(relationTarget(rels, "rId2")).toBeNull();
  });

  it("按类型后缀取 Id（备注页这种「类型唯一」的关系不能靠编号猜）", () => {
    expect(relationIdByType(rels, "/notesSlide")).toBe("rId3");
    expect(relationIdByType(rels, "/slide")).toBe("rId1");
  });

  it("相对路径归一化", () => {
    expect(normalizePartPath("../notesSlides/notesSlide1.xml", "ppt/slides")).toBe("ppt/notesSlides/notesSlide1.xml");
    expect(normalizePartPath("/ppt/slides/slide1.xml", "ppt")).toBe("ppt/slides/slide1.xml");
  });
});

describe("slideOrder", () => {
  const entries = ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"].map((name) => ({
    name,
    method: 8,
    compressedSize: 1,
    uncompressedSize: 1,
    encrypted: false,
    localOffset: 0,
  }));

  it("顺序取自 sldIdLst 而不是文件编号（用户拖过顺序的 PPT 里两者不同）", () => {
    const files = new Map<string, Uint8Array>([
      ["ppt/presentation.xml", new TextEncoder().encode('<p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>')],
      ["ppt/_rels/presentation.xml.rels", new TextEncoder().encode('<Relationships><Relationship Id="rId1" Target="slides/slide2.xml"/><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>')],
    ]);
    expect(slideOrder(files, entries)).toEqual({ slides: ["ppt/slides/slide2.xml", "ppt/slides/slide1.xml"], exact: true });
  });

  it("拿不到 sldIdLst 时退化成文件编号排序，并标记 exact=false（不假装知道顺序）", () => {
    expect(slideOrder(new Map(), entries)).toEqual({ slides: ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"], exact: false });
  });
});

describe("extractPptx（真实 .pptx 端到端）", () => {
  it("幻灯片序号按放映顺序，locator 是幻灯片的放映位置", async () => {
    const bytes = pptxOf({
      slides: [["文件里的第一张"], ["文件里的第二张"]],
      // 放映顺序与文件编号相反：文件 slide2 是第 1 张
      order: ["slide2.xml", "slide1.xml"],
    });
    const document = await extractPptx({ attachmentId: "att_pptx", bytes });
    expect(document.sections[0]!.locator).toEqual({ slide: 1 });
    expect(document.sections[0]!.text).toBe("文件里的第二张");
    expect(document.sections[1]!.locator).toEqual({ slide: 2 });
    expect(document.sections[1]!.text).toBe("文件里的第一张");
  });

  it("备注页挂到本张幻灯片，并标出是备注", async () => {
    const bytes = pptxOf({ slides: [["标题"]], notes: { "slide1.xml": "讲稿要点：先讲背景" } });
    const document = await extractPptx({ attachmentId: "att_pptx", bytes });
    expect(document.sections[0]!.text).toContain("（备注）讲稿要点：先讲背景");
  });

  it("无文本的幻灯片列入警告，不影响其它页", async () => {
    const bytes = pptxOf({ slides: [["有文字"], []] });
    const document = await extractPptx({ attachmentId: "att_pptx", bytes });
    expect(document.sections).toHaveLength(1);
    expect(document.warnings.some((warning) => warning.includes("第 2 张"))).toBe(true);
  });

  it("识别到宏只给提示，不读取宏内容", async () => {
    const bytes = pptxOf({ slides: [["正文"]], macro: true });
    const document = await extractPptx({ attachmentId: "att_pptx", bytes });
    expect(document.warnings.some((warning) => warning.includes("宏"))).toBe(true);
    expect(JSON.stringify(document)).not.toContain("fake-macro-project");
  });

  it("全部无文本时报损坏", async () => {
    await expect(extractPptx({ attachmentId: "att_pptx", bytes: pptxOf({ slides: [[], []] }) })).rejects.toMatchObject({ code: "corrupted" });
  });
});
