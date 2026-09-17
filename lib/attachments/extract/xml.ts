/**
 * XML / HTML 取文本的最小工具（规格 2 §10.1）。
 *
 * 【为什么不用 DOM 或完整 XML 解析器】我们只在服务端从已知 schema 的 OOXML 里取
 * 文本节点：`<a:t>` 是 run 的文本、`<p:txBody>` 是形状的文本体。真正的 XML 解析器
 * 会引入实体扩展、外部 DTD 这类默认开启的危险面（XXE / billion laughs），而我们
 * 需要的只是「按标签抓文本」。这里刻意只做标签级扫描 + 实体解码，**不解析 DTD、
 * 不展开自定义实体、不解析外部引用**——不做的事不需要防护。
 *
 * 【为什么不用 mammoth 的 HTML 输出直接给模型】mammoth 输出的是 HTML 片段，
 * 而我们要的是带**行号**的纯文本：行号是 DOCX 唯一的定位方式（Word 没有真实页码）。
 * 所以这里把 HTML 的块级标签走一遍，一边产出文本一边记行号。
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/**
 * 解码 XML/HTML 实体。
 *
 * 只认标准五实体 + 数字引用 + `nbsp`。**不认识的一律原样保留**：Office 文档里出现
 * 的自定义实体（`&custom;`）在 XML 层面本就是错误，把它替换成空串会静默吃掉正文。
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code, match) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code, match) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** 去掉所有标签，保留文本（并解码实体）。 */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ""));
}

/** `&nbsp;` 这类非断行空格在正文里应该变成普通空格，否则行尾判断会出错。 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/[ \t]+$/gm, "");
}

/**
 * 取出某个标签的全部内层文本（按出现顺序）。
 *
 * 名字匹配允许带命名空间前缀：Office 里同一逻辑标签在 `a:` / `p:` / `w:` 下都有，
 * 传 `t` 会同时命中 `<a:t>` 与 `<w:t>`——这正是我们要的，因为它们都是「文本 run」。
 */
export function tagTexts(xml: string, tag: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) out.push(decodeEntities(match[1]!));
  return out;
}

/** 按标签切出内层片段（需要保留子标签结构时用，如 `<a:p>` 里还有 `<a:r>`）。 */
export function tagBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) out.push(match[1]!);
  return out;
}

/** XML 属性值（用于拿 r:id 这类引用）。 */
export function attributeOf(tagSource: string, name: string): string | null {
  const pattern = new RegExp(`(?:[A-Za-z0-9_.-]+:)?${name}\\s*=\\s*"([^"]*)"`);
  const match = pattern.exec(tagSource);
  return match ? decodeEntities(match[1]!) : null;
}

/** 解开一个 XML 文件的根节点之前的那段声明，判断编码用（OOXML 一律 UTF-8，防御性保留）。 */
export function decodeXml(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8").decode(bytes);
  // BOM
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
