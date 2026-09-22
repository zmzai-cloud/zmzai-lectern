/**
 * PowerPoint（.pptx）提取（规格 2 §10.1）。
 *
 * 【为什么这个格式不用库】PPTX 没有真正可用的解析库——现有的几个长期没有维护，
 * 而我们要的东西极窄：每张幻灯片的文本。OOXML 的幻灯片本来就是一个个独立 XML
 * （`ppt/slides/slideN.xml`），直接读 `<a:t>` 文本节点反而**天然带幻灯片序号**，
 * 而库会把「哪段文字属于哪一页」这层信息糊掉。少一个重依赖，定位还更准。
 *
 * 【幻灯片序号必须按演示顺序，不能按文件名】`slideN.xml` 的 N 是**文件编号**，
 * 不是放映顺序；用户拖过顺序的 PPT 里两者完全不同（`slide3.xml` 可能是第 1 张）。
 * 所以顺序取自 `ppt/presentation.xml` 的 `sldIdLst`，再用 rels 映射到文件路径。
 * 「幻灯片 7」必须真的是用户看到的第 7 张，否则这个定位就是错的。
 *
 * 【只读文本节点】不解析 DTD、不展开自定义实体、不读嵌入对象与宏，也不跟随外部
 * 关系（`TargetMode="External"`），只计数并提示（§13）。
 */

import type { ExtractedDocument } from "@zmzai/agent-framework";

import { ExtractionFailure } from "./errors.js";
import type { SectionDraft } from "./finalize.js";
import { finalizeDocument, splitLongText } from "./finalize.js";
import { attributeOf, decodeXml, tagBlocks, tagTexts } from "./xml.js";
import { gateZipBytes, readZipEntries, type ZipEntry } from "./zip.js";

/** 幻灯片数上限（真实演示极少超过；超出时截断并写明）。 */
const MAX_SLIDES = 500;

export type PptxExtractionInput = {
  attachmentId: string;
  bytes: Uint8Array;
};

/**
 * 把 XML 的段落块（`<a:p>`）渲染成一行行文本。
 *
 * 一个段落里可能有多个 run（换字体、加粗都会把一个句子拆成多个 `<a:t>`），所以
 * 必须**先在段落内拼接、再按段落分行**——反过来会把「这是**一句**话」拆成两行。
 * `<a:br/>` 是段落内的强制换行，它才应该产出新行。
 */
export function paragraphLines(xml: string): string[] {
  const lines: string[] = [];
  for (const block of tagBlocks(xml, "p")) {
    for (const segment of block.split(/<a:br\s*\/?>/)) {
      const text = tagTexts(segment, "t").join("").replace(/\s+$/, "");
      if (text.trim().length > 0) lines.push(text);
    }
  }
  return lines;
}

/** 关系 id → 目标路径；外部关系返回 null（§13 不跟随外链）。 */
export function relationTarget(relsXml: string, relationId: string): string | null {
  const relPattern = /<Relationship\b[^>]*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = relPattern.exec(relsXml)) !== null) {
    const source = match[0];
    if (attributeOf(source, "Id") !== relationId) continue;
    if ((attributeOf(source, "TargetMode") ?? "") === "External") return null;
    return attributeOf(source, "Target");
  }
  return null;
}

/** 按类型后缀找一个关系的 id（备注页这种「类型唯一」的关系用它，编号猜不得）。 */
export function relationIdByType(relsXml: string, suffix: string): string | null {
  const relPattern = /<Relationship\b[^>]*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = relPattern.exec(relsXml)) !== null) {
    if ((attributeOf(match[0], "Type") ?? "").endsWith(suffix)) return attributeOf(match[0], "Id");
  }
  return null;
}

export function normalizePartPath(target: string, baseDir: string): string {
  const combined = target.startsWith("/") ? target.slice(1) : `${baseDir}/${target}`;
  const parts: string[] = [];
  for (const segment of combined.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/** `ppt/slides/slide3.xml` → `ppt/slides/_rels/slide3.xml.rels`。 */
function relsPathFor(partPath: string): string {
  const slash = partPath.lastIndexOf("/");
  const dir = partPath.slice(0, slash);
  const file = partPath.slice(slash + 1);
  return `${dir}/_rels/${file}.rels`;
}

function numericSlideName(name: string): number {
  return Number(/(\d+)/.exec(name)?.[1] ?? 0);
}

/**
 * 放映顺序的幻灯片文件路径。
 *
 * 拿不到 `presentation.xml` 或 rels 时**不假装知道顺序**：退化成按文件编号排序，
 * 并由调用方给出警告。给一个静默错误的序号，比明说「序号可能不准」要糟得多——
 * 用户会拿着错的「幻灯片 7」去核对，然后不再相信任何定位。
 */
export function slideOrder(files: Map<string, Uint8Array>, entries: readonly ZipEntry[]): { slides: string[]; exact: boolean } {
  const numeric = entries
    .map((entry) => entry.name)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => numericSlideName(a) - numericSlideName(b));
  const presentation = files.get("ppt/presentation.xml");
  const rels = files.get("ppt/_rels/presentation.xml.rels");
  if (!presentation || !rels) return { slides: numeric, exact: false };
  const relsXml = decodeXml(rels);
  const ordered: string[] = [];
  const idPattern = /<p:sldId\b[^>]*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = idPattern.exec(decodeXml(presentation))) !== null) {
    // `r:id` 必须在裸 `id` 之前取：`<p:sldId id="256" r:id="rId2"/>` 里 `id` 是
    // 内部编号，用它去查 rels 会查不到目标，于是整份顺序退化成文件编号
    const relationId = attributeOf(match[0], "r:id") ?? attributeOf(match[0], "id");
    if (!relationId) continue;
    const target = relationTarget(relsXml, relationId);
    if (!target) continue;
    ordered.push(normalizePartPath(target, "ppt"));
  }
  if (ordered.length === 0) return { slides: numeric, exact: false };
  return { slides: ordered, exact: true };
}

export async function extractPptx(input: PptxExtractionInput): Promise<ExtractedDocument> {
  const gate = gateZipBytes(input.bytes);
  if (!gate.ok) throw new ExtractionFailure(gate.code, gate.message);

  // 只解压需要的条目：图片（往往占体积 90% 以上）与嵌入对象从不进内存
  const read = readZipEntries(input.bytes, [
    "ppt/presentation.xml",
    "ppt/_rels/presentation.xml.rels",
    "ppt/slides/",
    "ppt/notesSlides/",
  ]);
  if (!read.ok) throw new ExtractionFailure(read.code, read.message);

  const warnings: string[] = [];
  if (gate.entries.some((entry) => entry.name === "ppt/vbaProject.bin")) {
    warnings.push("演示文稿包含宏（vbaProject.bin），已忽略且不会执行。");
  }
  const external = [...read.files.entries()].filter(
    ([name, bytes]) => name.endsWith(".rels") && /TargetMode\s*=\s*"External"/i.test(decodeXml(bytes)),
  );
  if (external.length > 0) warnings.push(`演示文稿包含 ${external.length} 处外部链接，未访问、未解析。`);

  const { slides, exact } = slideOrder(read.files, gate.entries);
  if (!exact) warnings.push("无法确定幻灯片的放映顺序，下面按文件编号排序，序号可能与放映顺序不一致。");
  if (slides.length === 0) throw new ExtractionFailure("corrupted", "演示文稿里没有任何幻灯片，文件结构可能已损坏。");
  if (slides.length > MAX_SLIDES) warnings.push(`演示文稿共 ${slides.length} 张幻灯片，本期只提取前 ${MAX_SLIDES} 张。`);

  const sections: SectionDraft[] = [];
  const empty: number[] = [];

  for (const [index, path] of slides.slice(0, MAX_SLIDES).entries()) {
    const slideNumber = index + 1;
    const body = read.files.get(path);
    if (!body) {
      empty.push(slideNumber);
      continue;
    }
    const lines = paragraphLines(decodeXml(body));
    // 备注页：讲稿常常是这份演示真正的正文。按关系精确对应到本张，不靠编号巧合。
    const notes = notesFor(read.files, path);
    if (notes.length > 0) lines.push(...notes.map((note) => `（备注）${note}`));
    if (lines.length === 0) {
      empty.push(slideNumber);
      continue;
    }
    sections.push(...splitLongText(lines.join("\n"), { slide: slideNumber }, `s${slideNumber}`));
  }

  if (sections.length === 0) {
    throw new ExtractionFailure("corrupted", "所有幻灯片都没有文本（可能是纯图片演示）。");
  }
  if (empty.length > 0) warnings.push(`第 ${empty.join("、")} 张幻灯片没有文本（可能是纯图片），已跳过。`);

  return finalizeDocument({
    attachmentId: input.attachmentId,
    sections,
    warnings,
  });
}

/** 备注页文本（已在名单内；未命中就是这份演示没有备注页）。 */
function notesFor(files: Map<string, Uint8Array>, slidePath: string): string[] {
  const rels = files.get(relsPathFor(slidePath));
  if (!rels) return [];
  const relsXml = decodeXml(rels);
  const relationId = relationIdByType(relsXml, "/notesSlide");
  if (!relationId) return [];
  const target = relationTarget(relsXml, relationId);
  if (!target) return [];
  const body = files.get(normalizePartPath(target, slidePath.slice(0, slidePath.lastIndexOf("/"))));
  if (!body) return [];
  return paragraphLines(decodeXml(body));
}
