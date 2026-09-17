/**
 * 提取测试用的**真实**样本构造器。
 *
 * 【为什么不用假的 stub 数据】解析器适配器的价值全在「真的能读出这份文件」上，
 * 用一个自定义的中间结构去测等于把适配器自己当成正确性来源。所以这里构造的是
 * 真实格式的最小文件：真 ZIP（fflate 写）、真 PDF（手工 xref）、真 OOXML 包，
 * 然后让 pdfjs / mammoth / exceljs 去读。它们读不出来才说明适配器有问题。
 */

import { zipSync } from "fflate";

export function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 用 fflate 写一个真实的 ZIP（顺带也在测我们自己的中央目录解析）。 */
export function zipOf(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(files)) {
    entries[name] = typeof value === "string" ? bytesOf(value) : value;
  }
  return zipSync(entries);
}

/** 结构合法但内容为空的 ZIP（只有中央目录结束记录）。 */
export function emptyZip(): Uint8Array {
  return zipSync({});
}

/**
 * 手工构造多页 PDF。`pages[i]` 是该页的文本行。
 *
 * 【为什么是 Type0 + Identity-H + ToUnicode 这么麻烦的字体】最初这里用 Helvetica
 * 单字节字体 + `(文本) Tj`，写英文没问题，**写中文会变成乱码**——单字节字体的字符
 * 码是 0–255，`价款` 这种字符根本不落在这个空间里，写进去的是一串错位字节，任何
 * 解析器都还原不回来。而真实的中文 PDF 也不是那么干的：它用 Type0 复合字体、把
 * 文字写成 2 字节的 CID，再附一张 **ToUnicode CMap** 告诉读者「CID 1 是哪个字」。
 * 文本提取正是靠这张表，跟字体里有没有真正的字形无关。
 *
 * 所以这里照着真文件的样子构造：字符 → CID 顺序编号 → 内容流写 `<hex CID>` →
 * ToUnicode 给出 CID 到 Unicode 的映射。中文、英文走同一条路（ASCII 字符同样被编
 * 号），不需要为两种语言准备两套 fixture，也不会出现「测中文用的样本本身读不出中文」
 * 这种把 fixture 的局限误当成产品缺陷的情况。
 */
export function pdfOf(pages: readonly string[][]): Uint8Array {
  const cidByChar = new Map<string, number>();
  for (const lines of pages) {
    for (const line of lines) {
      for (const char of line) if (!cidByChar.has(char)) cidByChar.set(char, cidByChar.size + 1);
    }
  }
  // 空格也要占一个 CID，否则 Tj 出来的两段字会连成一段
  const hexOf = (text: string) =>
    [...text].map((char) => (cidByChar.get(char) ?? 0).toString(16).padStart(4, "0")).join("");

  const cmap = toUnicodeCmap(cidByChar);
  const objects: string[] = [];
  const pageIds: number[] = [];
  // 1 catalog / 2 pages / 3 字体 / 4 ToUnicode / 5 后代字体 / 6 字体描述符
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] =
    "<< /Type /Font /Subtype /Type0 /BaseFont /LecternFixture /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 4 0 R >>";
  objects[4] = `<< /Length ${bytesOf(cmap).length} >>\nstream\n${cmap}endstream`;
  objects[5] =
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /LecternFixture /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 6 0 R /DW 1000 >>";
  // 【故意不带 FontFile】我们只测文本提取，不测排版；真实文件里这里会有内嵌字体，
  // 但 pdfjs 取文本走的是 ToUnicode，缺字形不影响（这是有意省略，不是漏写）
  objects[6] =
    "<< /Type /FontDescriptor /FontName /LecternFixture /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>";

  let nextId = 7;
  for (const lines of pages) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageIds.push(pageId);
    const stream = lines
      .map((line, index) => `BT /F1 12 Tf 72 ${740 - index * 18} Td <${hexOf(line)}> Tj ET\n`)
      .join("");
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}endstream`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
  }
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  const max = objects.length - 1;
  for (let id = 1; id <= max; id += 1) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= max; id += 1) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return bytesOf(out);
}

/** Unicode 码点到 UTF-16BE 十六进制（非 BMP 字符要写成代理对，不能只填一个码点）。 */
function utf16Hex(char: string): string {
  let out = "";
  for (let index = 0; index < char.length; index += 1) {
    out += char.charCodeAt(index).toString(16).padStart(4, "0").toUpperCase();
  }
  return out;
}

function toUnicodeCmap(cidByChar: ReadonlyMap<string, number>): string {
  const head =
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
    "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n";
  const tail = "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
  // 一个字都没有的页面（空白页样本）不能写 `0 beginbfchar`，那是非法 CMap
  if (cidByChar.size === 0) return head + tail;
  const pairs = [...cidByChar].map(
    ([char, cid]) => `<${cid.toString(16).padStart(4, "0").toUpperCase()}> <${utf16Hex(char)}>`,
  );
  // 规范限制一个 bfchar 段最多 100 条
  const chunks: string[] = [];
  for (let index = 0; index < pairs.length; index += 100) {
    const slice = pairs.slice(index, index + 100);
    chunks.push(`${slice.length} beginbfchar\n${slice.join("\n")}\nendbfchar\n`);
  }
  return head + chunks.join("") + tail;
}

/** 一份结构完整的最小 .docx（mammoth 能读）。 */
export function docxOf(bodyXml: string, options: { macro?: boolean; externalLink?: boolean } = {}): Uint8Array {
  const relationships = options.externalLink
    ? '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/x" TargetMode="External"/>'
    : "";
  const files: Record<string, string> = {
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>' +
      bodyXml +
      "</w:body></w:document>",
    "word/_rels/document.xml.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + relationships + "</Relationships>",
    "word/styles.xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>',
  };
  if (options.macro) files["word/vbaProject.bin"] = "fake-macro-project";
  return zipOf(files);
}

/** 段落的 OOXML 片段。 */
export function paragraph(text: string, style?: string): string {
  const styleXml = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${styleXml}<w:r><w:t>${text}</w:t></w:r></w:p>`;
}

/**
 * 一份结构完整的最小 .pptx。
 *
 * 【语义】`slides[i]` 是**文件 `ppt/slides/slide{i+1}.xml`** 的内容（文件编号），
 * 而 `order` 给的是**放映顺序**（文件名的数组）。两者分开是刻意的：用户拖过顺序的
 * 演示里它们不一样，只有分开才能测出「序号按不放映顺序」这件事。
 */
export function pptxOf(options: {
  slides: string[][];
  /** 放映顺序（文件名）；不传就是 slide1、slide2…… */
  order?: string[];
  /** 备注页文本，按**文件名**索引。 */
  notes?: Record<string, string>;
  macro?: boolean;
}): Uint8Array {
  const files: Record<string, string> = {
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  };
  const order = options.order ?? options.slides.map((_, index) => `slide${index + 1}.xml`);
  files["ppt/presentation.xml"] =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>' +
    order.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join("") +
    "</p:sldIdLst></p:presentation>";
  files["ppt/_rels/presentation.xml.rels"] =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    order
      .map((name, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/${name}"/>`)
      .join("") +
    "</Relationships>";

  // 按**文件编号**写幻灯片内容
  options.slides.forEach((lines, index) => {
    const name = `slide${index + 1}.xml`;
    files[`ppt/slides/${name}`] =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>' +
      lines.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join("") +
      "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>";
    const note = options.notes?.[name];
    if (note) {
      files[`ppt/slides/_rels/${name}.rels`] =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${index + 1}.xml"/>` +
        "</Relationships>";
      files[`ppt/notesSlides/notesSlide${index + 1}.xml`] =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>' +
        note +
        "</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>";
    }
  });
  if (options.macro) files["ppt/vbaProject.bin"] = "fake-macro-project";
  return zipOf(files);
}
