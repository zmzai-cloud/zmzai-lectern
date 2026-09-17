"use client";

/**
 * 附件卡片（规格 2 §7.4 / §12）。
 *
 * 【状态不能只用颜色表达】规格 §7.4 明确要求。这里每种状态都是「图标 + 文字」，
 * 色值只是辅助；失败态直接给出原因与「重试」按钮，而不是让用户猜。
 *
 * 【两种卡片是刻意分开的】Composer 里的是**待发**附件（可移除、可重试、有进度），
 * 消息里的是**已发送**的持久记录（不可移除，但可预览/下载、可展开解析警告）。
 * 混用一个组件会让「移除」出现在已发送的消息上，语义就错了。
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Download, File as FileIcon, FileSpreadsheet, FileText, Image as ImageIcon, Presentation, RefreshCw, X } from "lucide-react";

import { client } from "@/lib/client";
import { formatBytes } from "@/lib/attachments/limits";
import type { AttachmentKind, AttachmentReceipt, ComposerAttachment, FilePart } from "@/lib/types";

const KIND_ICON = {
  image: ImageIcon,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  text: FileIcon,
} as const;

const STATUS_TEXT: Record<ComposerAttachment["status"], string> = {
  preparing: "准备中",
  uploading: "上传中",
  processing: "解析中",
  ready: "就绪",
  error: "失败",
};

function KindIcon({ kind, className }: { kind: AttachmentKind; className?: string }) {
  const Icon = KIND_ICON[kind] ?? FileIcon;
  return <Icon className={className} size={14} aria-hidden="true" />;
}

export function ComposerAttachmentList({
  items,
  onRemove,
  onRetry,
}: {
  items: readonly ComposerAttachment[];
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    // 紧凑可换行列表 + 自身最大高度内滚：附件多时不能把会话内容顶走（规格 §7.4）
    <ul
      className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto px-3 pt-2.5"
      aria-label={`待发送附件（${items.length}）`}
    >
      {items.map((item) => (
        <li
          key={item.localId}
          className="attachment-card flex min-w-0 max-w-full items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1 text-xs text-ink-2 sm:max-w-72"
          data-status={item.status}
        >
          {item.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.previewUrl} alt="" className="h-7 w-7 flex-none rounded-sm object-cover" />
          ) : (
            <KindIcon kind={item.kind} className="flex-none text-ink-3" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ink" title={item.name}>
              {item.name}
            </span>
            <span className="block truncate text-[0.625rem] text-ink-3">
              {formatBytes(item.size)}
              {" · "}
              {/* 状态文字与图标并列，不靠颜色单独表意 */}
              <span className="inline-flex items-center gap-0.5 align-middle">
                {item.status === "ready" && <Check size={9} aria-hidden="true" className="text-success" />}
                {item.status === "error" && <AlertTriangle size={9} aria-hidden="true" className="text-danger" />}
                {STATUS_TEXT[item.status]}
                {item.status === "uploading" && item.progress != null ? ` ${Math.round(item.progress * 100)}%` : ""}
              </span>
            </span>
            {item.status === "uploading" && (
              <span className="mt-0.5 block h-0.5 w-full overflow-hidden rounded-pill bg-surface">
                <span className="block h-full rounded-pill bg-ink transition-all" style={{ width: `${Math.round((item.progress ?? 0) * 100)}%` }} />
              </span>
            )}
            {item.status === "error" && item.error && <span className="block text-[0.625rem] text-danger">{item.error.message}</span>}
          </span>
          {item.status === "error" && item.error?.retryable && (
            <button
              type="button"
              onClick={() => onRetry(item.localId)}
              title={`重试上传「${item.name}」`}
              aria-label={`重试上传 ${item.name}`}
              className="attachment-action flex h-6 w-6 flex-none items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-strong"
            >
              <RefreshCw size={11} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onRemove(item.localId)}
            title={`移除「${item.name}」`}
            aria-label={`移除 ${item.name}`}
            className="attachment-action flex h-6 w-6 flex-none items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-strong"
          >
            <X size={11} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 已发送附件的持久卡片（规格 2 §12）
// ────────────────────────────────────────────────────────────────────────────

type AttachmentMeta = { attachment: AttachmentReceipt; availability: boolean };

/**
 * 元数据缓存：同一条消息会因为滚动、折叠、rAF 快照反复渲染，每次都请求一次
 * 会是几十倍的无效流量。键含 sessionId——附件归属是按会话隔离的（规格 §9.1）。
 * 失败也缓存成 null：对已删除的附件反复重试只会刷满日志。
 */
const metaCache = new Map<string, Promise<AttachmentMeta | null>>();

function loadMeta(sessionId: string, attachmentId: string): Promise<AttachmentMeta | null> {
  const key = `${sessionId}/${attachmentId}`;
  const cached = metaCache.get(key);
  if (cached) return cached;
  const pending = client
    .getAttachment(sessionId, attachmentId)
    .then((result) => result as AttachmentMeta)
    .catch(() => null);
  metaCache.set(key, pending);
  return pending;
}

/** 可用摘要：「12 页」/「3 个工作表」/「约 4.2 千字」——没有可说的就不占位。 */
function extractionSummary(extraction: AttachmentReceipt["extraction"]): string | null {
  if (!extraction) return null;
  if (typeof extraction.pages === "number") return `${extraction.pages} 页`;
  if (typeof extraction.slides === "number") return `${extraction.slides} 页幻灯片`;
  if (extraction.sheets?.length) return `${extraction.sheets.length} 个工作表`;
  if (typeof extraction.characters === "number") return `${(extraction.characters / 1000).toFixed(1)} 千字`;
  return null;
}

/**
 * 用户消息里的附件卡片。与 Composer 的待发卡片不同，这里**不可移除**（已发送），
 * 但可以预览 / 下载，并展开解析警告。
 *
 * 三种降级都必须能渲染出点什么，绝不让整条消息挂掉：
 * ①元数据还在读 → 用 part 上已有的名字与大小先画；
 * ②元数据读不到或 blob 已清理 → 显示「不可用」并撤掉链接；
 * ③旧消息里的 data URL part（v1 契约）→ 只给下载，不假装能拿到摘要。
 */
export function MessageAttachmentCard({ part }: { part: FilePart }) {
  const attachmentId = part.attachmentId;
  const [meta, setMeta] = useState<AttachmentMeta | null>(null);
  const [warningsOpen, setWarningsOpen] = useState(false);

  useEffect(() => {
    if (!attachmentId || !part.sessionId) return;
    let disposed = false;
    void loadMeta(part.sessionId, attachmentId).then((result) => !disposed && setMeta(result));
    return () => {
      disposed = true;
    };
  }, [attachmentId, part.sessionId]);

  // part 上的是上传当时的快照；元数据回来后以服务端为准（名字可能被规范化过）
  const name = meta?.attachment.filename ?? part.filename;
  const mime = meta?.attachment.mediaType ?? part.mime;
  const size = meta?.attachment.size ?? part.size;
  const kind = meta?.attachment.kind ?? part.kind ?? "document";
  const warnings = meta?.attachment.extraction?.warnings ?? [];
  const summary = extractionSummary(meta?.attachment.extraction);
  const unavailable = !attachmentId
    ? false
    : meta !== null && !meta.availability;
  // 旧消息（v1 契约）里 file part 自带 data URL：仍可下载，但拿不到摘要与警告。
  // 新消息只在存储里，链接由 attachment id 现取——不在 DOM 里常驻 base64。
  const legacyUrl = !attachmentId && part.url?.startsWith("data:") ? part.url : null;
  const href =
    legacyUrl ?? (attachmentId && part.sessionId && !unavailable ? client.attachmentUrl(part.sessionId, attachmentId) : null);
  const isPreviewable = kind === "image" && href !== null;

  const toggleWarnings = useCallback(() => setWarningsOpen((open) => !open), []);

  return (
    <div
      className="attachment-card flex max-w-full flex-col gap-1 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs text-ink-2 sm:max-w-md"
      data-status={unavailable ? "error" : "ready"}
    >
      <div className="flex min-w-0 items-center gap-2">
        {isPreviewable ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={href} alt="" className="h-8 w-8 flex-none rounded-sm object-cover" />
        ) : (
          <KindIcon kind={kind} className="flex-none text-ink-3" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ink" title={name}>
            {name}
          </span>
          <span className="block truncate text-[0.625rem] text-ink-3">
            {[mime, size != null ? formatBytes(size) : null, summary].filter(Boolean).join(" · ")}
            {unavailable && <span className="text-danger"> · 文件已不可用</span>}
          </span>
        </span>
        {href && (
          <a
            href={href}
            {...(kind === "image" ? { target: "_blank", rel: "noreferrer" } : { download: name })}
            className="attachment-action flex h-6 w-6 flex-none items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-strong"
            title={kind === "image" ? `查看「${name}」` : `下载「${name}」`}
            aria-label={kind === "image" ? `查看 ${name}` : `下载 ${name}`}
          >
            <Download size={11} aria-hidden="true" />
          </a>
        )}
      </div>
      {warnings.length > 0 && (
        <>
          <button
            type="button"
            onClick={toggleWarnings}
            aria-expanded={warningsOpen}
            className="inline-flex items-center gap-1 self-start text-[0.625rem] text-warning transition-colors hover:underline"
          >
            <AlertTriangle size={10} aria-hidden="true" />
            {warningsOpen ? "收起解析说明" : `解析说明（${warnings.length}）`}
            <ChevronDown size={10} aria-hidden="true" className={warningsOpen ? "rotate-180 transition-transform" : "transition-transform"} />
          </button>
          {warningsOpen && (
            <ul className="list-disc space-y-0.5 pl-4 text-[0.625rem] leading-4 text-ink-3">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
