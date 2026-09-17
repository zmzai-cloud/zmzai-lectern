/**
 * 附件支持格式与限制（规格 2026-09-17 §6）。
 *
 * 【为什么必须只有这一张表】选择、粘贴、拖放是三条不同的输入路径，历史上它们
 * 各自维护一套扩展名与上限（`Composer.tsx` 里 `pickImages` 管图片、`pickAttachments`
 * 管文本，两套限制两套状态），于是同一批文件走不同入口得到不同结果。现在
 * `accept` 属性、前端早期提示、服务端最终校验和错误文案全部从 `ATTACHMENT_FORMATS`
 * 推导，新增格式只需改一行。
 *
 * 【扩展名只用于早期提示】规格 §6：MIME 判定以服务端内容嗅探为准，扩展名与真实
 * MIME 不一致时按实际类型处理，不能盲信浏览器给的 `file.type`。
 *
 * 本模块必须保持纯净（无 node / DOM API）：前端组件、Next 路由、单测共用。
 */

export type AttachmentKind = "image" | "document" | "text" | "spreadsheet" | "presentation";

/** 内容提取器 id；`null` 表示本期接受并存储，但不提取正文（会给出明确 warning）。 */
export type AttachmentExtractor = "pdf" | "docx" | "xlsx" | "csv" | "pptx" | "text" | "image" | null;

export type AttachmentFormat = {
  /** 稳定 id，落库与日志用（不含扩展名，便于同一格式多扩展名）。 */
  id: string;
  label: string;
  kind: AttachmentKind;
  extractor: AttachmentExtractor;
  /** 小写、含前导点。 */
  extensions: readonly string[];
  /** 浏览器可能报告的声明 MIME（仅作早期提示，不代表可信）。 */
  mediaTypes: readonly string[];
  maxBytes: number;
  /** 无法提取正文时给用户的说明（extractor 为 null 时必填）。 */
  note?: string;
};

const MB = 1024 * 1024;

/** 全局默认限制（规格 §6）。前后端同源，产品配置可覆盖。 */
export const ATTACHMENT_LIMITS = {
  /** 每条消息最多本地附件数 */
  maxLocalPerMessage: 10,
  /** 单条消息原始文件总计字节上限 */
  maxTotalBytesPerMessage: 50 * MB,
  /** 工作区引用数上限 */
  maxWorkspaceReferences: 32,
  /** PDF 默认最多处理页数；超过时保留文件并提示选择页段 */
  maxPdfPages: 300,
  /** 文件名长度上限（basename 之后） */
  maxFilenameLength: 255,
  /** 未绑定消息的草稿附件 TTL */
  unboundTtlMs: 24 * 60 * 60 * 1000,
} as const;

/** 文本/代码扩展名（规格 §6「常用 UTF-8 文本、Markdown、JSON、YAML、XML 和源码」）。 */
const TEXT_EXTENSIONS = [
  ".md", ".mdx", ".markdown", ".txt", ".text", ".log",
  ".json", ".jsonc", ".json5", ".ndjson",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".properties", ".env",
  ".xml", ".plist", ".graphql", ".gql", ".proto", ".sql",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".styl",
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".vue", ".svelte", ".astro",
  ".py", ".pyi", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".swift", ".dart",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".cs", ".m", ".mm",
  ".php", ".lua", ".r", ".pl", ".pm", ".ex", ".exs", ".erl", ".clj", ".hs", ".ml", ".zig",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd", ".make", ".mk", ".dockerfile",
  ".tex", ".rst", ".adoc", ".org", ".diff", ".patch", ".gitignore", ".editorconfig",
] as const;

/** 支持格式表。顺序只影响展示，不影响匹配（按扩展名精确匹配）。 */
export const ATTACHMENT_FORMATS: readonly AttachmentFormat[] = [
  {
    id: "pdf",
    label: "PDF",
    kind: "document",
    extractor: "pdf",
    extensions: [".pdf"],
    mediaTypes: ["application/pdf"],
    maxBytes: 25 * MB,
  },
  {
    id: "docx",
    label: "Word",
    kind: "document",
    extractor: "docx",
    extensions: [".docx"],
    mediaTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    maxBytes: 20 * MB,
  },
  {
    id: "xlsx",
    label: "Excel",
    kind: "spreadsheet",
    extractor: "xlsx",
    extensions: [".xlsx"],
    mediaTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    maxBytes: 20 * MB,
  },
  {
    id: "xls",
    label: "Excel 97-2003",
    kind: "spreadsheet",
    extractor: null,
    extensions: [".xls"],
    mediaTypes: ["application/vnd.ms-excel"],
    maxBytes: 20 * MB,
    note: "旧版 .xls（BIFF8 复合文档）本期只保存文件、不提取正文；请在 Excel 中另存为 .xlsx 后重新添加。",
  },
  {
    id: "csv",
    label: "CSV",
    kind: "spreadsheet",
    extractor: "csv",
    extensions: [".csv"],
    mediaTypes: ["text/csv", "application/csv"],
    maxBytes: 20 * MB,
  },
  {
    id: "tsv",
    label: "TSV",
    kind: "spreadsheet",
    extractor: "csv",
    extensions: [".tsv"],
    mediaTypes: ["text/tab-separated-values"],
    maxBytes: 20 * MB,
  },
  {
    id: "pptx",
    label: "PowerPoint",
    kind: "presentation",
    extractor: "pptx",
    extensions: [".pptx"],
    mediaTypes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    maxBytes: 20 * MB,
  },
  {
    id: "text",
    label: "文本",
    kind: "text",
    extractor: "text",
    extensions: TEXT_EXTENSIONS,
    mediaTypes: ["text/plain"],
    maxBytes: 2 * MB,
  },
  {
    id: "image",
    label: "图片",
    kind: "image",
    extractor: "image",
    extensions: [".png", ".jpg", ".jpeg", ".webp", ".gif"],
    mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    maxBytes: 10 * MB,
  },
];

/** 扩展名 → 格式（大小写不敏感）。无扩展名或未登记返回 null。 */
export function formatForFilename(name: string): AttachmentFormat | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot).toLowerCase();
  return ATTACHMENT_FORMATS.find((format) => format.extensions.includes(ext)) ?? null;
}

/** 声明 MIME → 格式（仅早期提示；服务端以内容嗅探为准）。 */
export function formatForMediaType(mediaType: string): AttachmentFormat | null {
  const base = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!base) return null;
  return ATTACHMENT_FORMATS.find((format) => format.mediaTypes.includes(base)) ?? null;
}

/**
 * 扩展名 → 规范 MIME。一个格式可能对应多个扩展名（`.jpg` / `.jpeg`、`.csv` / `.tsv`），
 * 直接取 `format.mediaTypes[0]` 会把 `.jpeg` 报成 `image/png`——这个值会进消息 part
 * 并决定模型是否按图片处理，所以必须按扩展名精确映射。
 */
const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".mdx": "text/markdown",
  ".json": "application/json",
  ".jsonc": "application/json",
  ".json5": "application/json",
  ".ndjson": "application/x-ndjson",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".jsx": "text/javascript",
  ".ts": "text/typescript",
  ".mts": "text/typescript",
  ".cts": "text/typescript",
  ".tsx": "text/typescript",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
};

/** 按扩展名给出规范 MIME，未登记时回落到 text/plain（文本类）或格式首选值。 */
export function mediaTypeForFilename(name: string, format: AttachmentFormat): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  return EXTENSION_MEDIA_TYPES[ext] ?? (format.kind === "text" ? "text/plain" : format.mediaTypes[0]!);
}

/**
 * 尚未创建会话时的草稿作用域（规格 §9.1 要求附件必须属于某个 session/workspace）。
 * Composer 允许在无会话时先加文件（`page.send` 会惰性建会话），这些附件挂到
 * `__draft__`，随发送绑定到真实会话。用下划线包裹是为了不与 `ses_*` 冲突。
 */
export const DRAFT_SESSION_ID = "__draft__";

/** `<input accept>`：从格式表推导，不再手写扩展名列表。 */
export function acceptAttribute(): string {
  const parts = new Set<string>();
  for (const format of ATTACHMENT_FORMATS) {
    for (const ext of format.extensions) parts.add(ext);
  }
  // 图片类再给一个 `image/*`，让 macOS 选择器能按媒体类型筛选（扩展名已覆盖）
  parts.add("image/*");
  return [...parts].join(",");
}

/** 人类可读大小（附件卡展示）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}

/** 支持格式清单（帮助文案与错误提示共用，避免两处各写一份）。 */
export function supportedFormatsSummary(): string {
  return ATTACHMENT_FORMATS.map((format) => format.label).join("、");
}
