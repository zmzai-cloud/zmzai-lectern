import { describe, expect, it } from "vitest";

import { canvasKindOf, canvasKindOfMediaType, isCanvasRenderable, CANVAS_KIND_LABEL } from "./canvas-kind.js";
import { isPreviewable, previewableOf } from "./task-presentation.js";

describe("canvasKindOf：画布的三种渲染方式", () => {
  it.each([
    ["out/index.html", "html"],
    ["out/index.htm", "html"],
    ["report/SUMMARY.HTML", "html"],
    ["packages/vehicles/dist/sticker-sheet.pdf", "pdf"],
    ["合同.pdf", "pdf"],
    ["dist/icon.png", "image"],
    ["dist/icon-mac.png", "image"],
    ["shots/a.jpg", "image"],
    ["shots/a.jpeg", "image"],
    ["shots/a.webp", "image"],
    ["shots/a.gif", "image"],
    ["shots/a.avif", "image"],
    ["logo/cloud.svg", "image"],
  ])("%s → %s", (path, expected) => {
    expect(canvasKindOf(path)).toBe(expected);
    expect(isCanvasRenderable(path)).toBe(true);
  });

  it.each([
    ["src/app/page.tsx", "tsx"],
    ["README.md", "md"],
    ["styles.css", "css"],
    ["data.json", "json"],
    ["archive.tar.gz", "gz"],
    ["Makefile", "(无扩展名)"],
    ["", "(空路径)"],
  ])("%s 不属于可渲染类型（%s）", (path) => {
    expect(canvasKindOf(path)).toBeNull();
    expect(isCanvasRenderable(path)).toBe(false);
  });

  it("大小写不敏感：工作区里 .PDF 与 .Pdf 都算", () => {
    expect(canvasKindOf("a.PDF")).toBe("pdf");
    expect(canvasKindOf("a.Pdf")).toBe("pdf");
  });

  it("三种方式的用户可见名称齐全", () => {
    expect(Object.keys(CANVAS_KIND_LABEL).sort()).toEqual(["html", "image", "pdf"]);
  });
});

describe("canvasKindOf 与 isPreviewable 是两件事", () => {
  /**
   * 【为什么这条必须有】`isPreviewable` 是 ROWS 第 5 行「有可预览产物 → delivered」
   * 的判据。一旦它跟着画布的渲染能力一起放宽，任何写出一张 PNG 的会话（截图、图标、
   * 字体预览）都会被标成「已交付」——正是 0.9.0 交付语义要杜绝的那类推导。
   */
  it("PDF 能被画布渲染，但不构成「已交付」的近似判据", () => {
    expect(canvasKindOf("sticker-sheet.pdf")).toBe("pdf");
    expect(isPreviewable("sticker-sheet.pdf")).toBe(false);
  });

  it("图片能被画布渲染，但不构成「已交付」的近似判据", () => {
    expect(canvasKindOf("icon.png")).toBe("image");
    expect(isPreviewable("icon.png")).toBe(false);
  });

  it("HTML 两边都认（.htm 也认——历史漏过这一种）", () => {
    for (const path of ["a.html", "a.htm", "a.HTM"]) {
      expect(canvasKindOf(path)).toBe("html");
      expect(isPreviewable(path)).toBe(true);
    }
  });

  it("previewableOf 只留下 HTML", () => {
    expect(previewableOf(["a.html", "b.pdf", "c.png", "d.ts"])).toEqual(["a.html"]);
  });
});

describe("canvasKindOfMediaType：内容与扩展名不符时的兜底", () => {
  it("PDF / 图片 / 网页 MIME 映射到对应渲染方式", () => {
    expect(canvasKindOfMediaType("application/pdf")).toBe("pdf");
    expect(canvasKindOfMediaType("image/png")).toBe("image");
    expect(canvasKindOfMediaType("image/svg+xml")).toBe("image");
    expect(canvasKindOfMediaType("text/html; charset=utf-8")).toBe("html");
  });

  it("文本、未知与空值都判不出来（不硬猜）", () => {
    expect(canvasKindOfMediaType("text/plain")).toBeNull();
    expect(canvasKindOfMediaType("application/zip")).toBeNull();
    expect(canvasKindOfMediaType(null)).toBeNull();
    expect(canvasKindOfMediaType(undefined)).toBeNull();
  });
});
