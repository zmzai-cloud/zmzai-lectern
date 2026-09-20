"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, cn } from "@zmzai/theme";

import { canvasKindOf } from "@/lib/canvas-kind";
import { client } from "@/lib/client";

type Props = {
  /** 要在成果预览中打开的工作区文件路径（相对工作区根）。 */
  path: string | null;
  onPathChange: (path: string) => void;
  sessionId?: string | null;
  /** 跳到「文件」Tab 的路线（§4.5：成果预览空态要给出「查看当前任务文件」的路线）。 */
  onOpenFiles?: () => void;
};

/**
 * 成果预览：把工作区生成的产物在隔离 iframe 中实时渲染。
 * 组件名仍为 CanvasPane（内部实现名，spec 明示避免无谓重命名），
 * 但用户可见文案一律为「成果预览」。
 *
 * 渲染分三路（判定见 `lib/canvas-kind.ts`）：
 * · 网页 → 受控工作区文件路由加载，让相对 CSS / JS / 图片引用照常解析；
 * · PDF → 同样交给 URL，由 Chromium 内建阅读器画（翻页、缩放、下载都是现成的）；
 * · 图片 → `<img>`；
 * 都不认识的路径回退为文本预览。
 *
 * 【PDF 的 iframe 为什么不带 sandbox】实测（Electron 44 / macOS，逐像素统计）：
 * `sandbox="allow-scripts"` 与 `sandbox="allow-scripts allow-same-origin"` 都把
 * PDF 打成**全白**——Chromium 的阅读器是插件进程，沙箱帧里起不来，而且不报错。
 * 不带 sandbox 与 `<object type="application/pdf">` 都能正常出页面（非白像素 55%）。
 * 于是这里只能二选一：要么沙箱要么能看。PDF 不是可执行标记语言，且这份字节来自
 * 用户自己的工作区（不是模型生成的 HTML），所以选「能看」。
 * HTML 路线继续带 sandbox——那条路线才是不可信内容。
 */
export default function CanvasPane({ path, onPathChange, sessionId, onOpenFiles }: Props) {
  const [draft, setDraft] = useState(path ?? "");
  const [content, setContent] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [mediaType, setMediaType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** 每次打开/刷新都换 URL，确保 iframe 不会保留上一版 document。 */
  const [revision, setRevision] = useState(0);
  // §7.5：结果头部提供桌面/移动视口切换。HTML 产物常是页面，视口是真实需要的能力。
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");

  const kind = path ? canvasKindOf(path) : null;

  useEffect(() => {
    setDraft(path ?? "");
  }, [path]);

  /**
   * 取一次内容。渲染型产物（网页/PDF/图片）的 src 是 URL，浏览器自己去拿，
   * 这里只为了**确认文件存在**并拿到路径回填；文本回退才真的需要内容。
   */
  const open = useCallback(async (p: string) => {
    if (!p.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const f = await client.fsFile(p.trim(), sessionId);
      setContent(f.content);
      setBinary(f.binary);
      setMediaType(f.mediaType);
      onPathChange(f.path);
      setRevision((current) => current + 1);
    } catch (err) {
      setContent(null);
      setBinary(false);
      setMediaType(null);
      setError(err instanceof Error ? err.message : "打开失败");
    } finally {
      setLoading(false);
    }
  }, [onPathChange, sessionId]);

  const previewSrc = path && (kind === "html" || kind === "pdf")
    ? `/api/preview/${encodeURIComponent(sessionId ?? "_")}/${path.split("/").map(encodeURIComponent).join("/")}?v=${revision}`
    : null;
  const imageSrc = path && kind === "image"
    ? `/api/preview/${encodeURIComponent(sessionId ?? "_")}/${path.split("/").map(encodeURIComponent).join("/")}?v=${revision}`
    : null;

  useEffect(() => {
    if (path) void open(path);
  }, [open, path]);

  // §4.5 空态：说明「可预览的产物类型」+ 给出到文件的路线，而不是一大片空白。
  if (!path) {
    return (
      <div className="wb-empty">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" className="text-ink-3">
          <rect x="2.5" y="4" width="19" height="15" rx="2" />
          <path d="M2.5 8.5h19M6 6.2h.01M8.5 6.2h.01" strokeLinecap="round" />
          <path d="M9 13l-2 2 2 2M15 13l2 2-2 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="text-sm font-semibold text-ink-2">还没有可预览的成果</div>
        <div className="max-w-60 text-center text-xs leading-5 text-ink-3">
          可预览的类型是 <code className="font-mono">.html</code> / <code className="font-mono">.htm</code>、
          <code className="font-mono">.pdf</code> 与常见图片格式。
          当前任务产出后会在这里打开；其他产物请到「文件」查看源码。
        </div>
        <div className="flex w-full max-w-72 items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void open(draft);
            }}
            placeholder="工作区文件路径…"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 rounded-sm border border-line bg-surface px-2.5 font-mono text-xs text-ink outline-none placeholder:text-ink-3 focus:border-ink"
          />
          <Button variant="secondary" size="sm" disabled={!draft.trim() || loading} onClick={() => void open(draft)}>
            打开
          </Button>
        </div>
        {onOpenFiles && (
          <button
            type="button"
            onClick={onOpenFiles}
            className="rounded-[3px] bg-surface-2 px-2 py-1 text-[0.6875rem] font-medium text-ink-2 transition-colors hover:text-ink"
          >
            查看当前任务文件
          </button>
        )}
        {error && <div className="text-xs text-danger">{error}</div>}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="truncate font-mono text-[0.6875rem] text-ink-2" title={path}>
          {path}
        </span>
        <span className="flex-1" />
        {/* 视口切换：HTML 产物常是页面，移动端宽度是真实需要的能力。
            PDF 有阅读器自带的缩放，图片有 img 的自然尺寸，都不需要这一排。 */}
        {kind === "html" && (
          <span className="flex shrink-0 items-center gap-0.5">
            {(["desktop", "mobile"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setViewport(v)}
                title={v === "desktop" ? "桌面视口" : "移动视口（390px）"}
                aria-pressed={viewport === v}
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-sm transition-colors",
                  viewport === v ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink",
                )}
              >
                {v === "desktop" ? (
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                    <rect x="1.5" y="2.5" width="13" height="9" rx="1.2" />
                    <path d="M5.5 14h5" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                    <rect x="4.5" y="1.5" width="7" height="13" rx="1.2" />
                    <path d="M7 12.5h2" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            ))}
          </span>
        )}
        <button
          type="button"
          onClick={() => void open(path)}
          className="shrink-0 text-[0.6875rem] text-ink-3 transition-colors hover:text-ink"
        >
          {loading ? "加载中…" : "刷新"}
        </button>
      </div>
      {error ? (
        <div className="wb-empty">
          <div className="text-sm font-semibold text-danger">无法加载成果预览</div>
          <div className="max-w-md break-words text-center font-mono text-xs leading-5 text-ink-3">{error}</div>
          <button
            type="button"
            onClick={() => void open(path)}
            className="rounded-[3px] bg-surface-2 px-2 py-1 text-[0.6875rem] font-medium text-ink-2 transition-colors hover:text-ink"
          >
            重试
          </button>
        </div>
      ) : loading && content === null ? (
        <div className="wb-empty text-xs text-ink-3">正在加载成果预览…</div>
      ) : kind === "html" ? (
        <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-surface-2">
          <iframe
            title="成果预览"
            src={previewSrc ?? undefined}
            sandbox="allow-scripts"
            className="min-h-0 shrink-0 border-0 bg-white"
            style={
              viewport === "mobile"
                ? { inlineSize: 390, blockSize: "100%", maxInlineSize: "100%" }
                : { inlineSize: "100%", blockSize: "100%" }
            }
          />
        </div>
      ) : kind === "pdf" ? (
        /* 不带 sandbox：带上就白屏（见文件头说明）。 */
        <iframe
          title="成果预览"
          src={previewSrc ?? undefined}
          className="min-h-0 w-full flex-1 border-0 bg-surface-2"
          data-canvas-pdf
        />
      ) : kind === "image" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-2 p-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- 工作区文件的受控路由，不走 next/image 优化 */}
          <img src={imageSrc ?? undefined} alt={path} className="max-h-full max-w-full object-contain" />
        </div>
      ) : binary ? (
        /* 走到这里的路径连扩展名都没有线索（例如 `.bin`），服务端嗅探说了它不是文本。 */
        <div className="wb-empty">
          <div className="text-sm font-semibold text-ink-2">这个文件不是文本，画布也认不出它的类型</div>
          <div className="max-w-md break-words text-center font-mono text-xs leading-5 text-ink-3">{path}</div>
          <div className="text-xs text-ink-3">
            {mediaType ? `服务端嗅探结果：${mediaType}` : "内容不是 UTF-8 文本，也不匹配任何已知文件头。"}
          </div>
        </div>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto p-3 text-xs leading-5 text-ink-2">{content}</pre>
      )}
    </div>
  );
}
