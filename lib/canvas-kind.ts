/**
 * 「成果预览」到底能画什么（规格 2026-09-17 §7.5 的产物预览）。
 *
 * 【为什么单独一个模块】这条判定此前只有 `.html` 一项，散在 task-presentation
 * 的 `isPreviewable` 里，语义上被绑死在「有可预览产物 → delivered」那条历史近似
 * 判据上（见 task-presentation ROWS 第 5 行）。而「成果预览能渲染」与「这算不算
 * 一次交付」是两件事：**前者是渲染能力，后者是任务状态**。混在一个函数里的代价
 * 是——想让 PDF 能预览，就会顺手让「改了一张 PNG」的会话被判成「已交付」。
 * 拆开之后两边各自演进：这里只回答「画布能不能画它」。
 *
 * 【为什么按扩展名判，而不是按内容嗅探】画布拿到的是**工作区路径**，渲染时把
 * 路径交给浏览器（iframe src / img src），不经过服务端嗅探。扩展名就是工作区里
 * 的真相：`.pdf` 就是 PDF，`.png` 就是 PNG。内容与扩展名不符的文件在附件上传
 * 链路上已经被拒绝（lib/attachments/sniff.ts），不在这里兜底。
 *
 * 本模块必须保持纯净（无 node / DOM API）：客户端组件与单测共用。
 */

/** 画布的三种渲染方式。`null` 表示画布不认识它（仍可按文本预览）。 */
export type CanvasKind = "html" | "pdf" | "image";

const HTML_RE = /\.html?$/i;

/** 图片：只列浏览器原生能解码的位图格式。SVG 归入此处也算位图渲染（img 可解码）。 */
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

const PDF_RE = /\.pdf$/i;

/** 路径 → 画布渲染方式；不认识则 `null`。 */
export function canvasKindOf(path: string): CanvasKind | null {
  if (!path) return null;
  if (HTML_RE.test(path)) return "html";
  if (PDF_RE.test(path)) return "pdf";
  if (IMAGE_RE.test(path)) return "image";
  return null;
}

/** 画布能否直接渲染它（不要求它是文本）。 */
export function isCanvasRenderable(path: string): boolean {
  return canvasKindOf(path) !== null;
}

/**
 * 由嗅探出的 MIME 反推画布渲染方式。
 *
 * 【用途】文件内容与扩展名不符时（例如 `.bin` 里其实是 PDF），服务端嗅探是唯一
 * 的真相来源；文件 Tab 拿它来决定「要不要给出『在成果预览中打开』这条路」。
 */
export function canvasKindOfMediaType(mediaType: string | null | undefined): CanvasKind | null {
  if (!mediaType) return null;
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("text/html")) return "html";
  return null;
}

/** 人类可读的渲染方式名称（空态文案用）。 */
export const CANVAS_KIND_LABEL: Record<CanvasKind, string> = {
  html: "网页",
  pdf: "PDF",
  image: "图片",
};
