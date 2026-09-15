import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, File, LoaderCircle, Search, Wrench, X } from "lucide-react";
import { Markdown } from "@zmzai/theme";
import { client } from "@/lib/client";
import type { MessageSearchHit } from "@/lib/types";

type ContextPage = Awaited<ReturnType<typeof client.getMessageContext>>;
const iconButton = "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

function SearchText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = text.length > 8000;
  return <div className="min-w-0 overflow-x-auto break-words text-sm">
    <Markdown text={truncated && !expanded ? text.slice(0, 8000) : text} />
    {truncated && <button type="button" aria-expanded={expanded} className="mt-2 text-xs text-ink-3 underline" onClick={() => setExpanded(!expanded)}>{expanded ? "收起正文" : "展开完整正文"}</button>}
  </div>;
}

export default function SessionMessageSearch({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MessageSearchHit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<ContextPage | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [contextBusy, setContextBusy] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const searchRequest = useRef<AbortController | null>(null);
  const contextRequest = useRef<AbortController | null>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => { searchRequest.current?.abort(); contextRequest.current?.abort(); }, []);

  async function search(next: string | null = null) {
    searchRequest.current?.abort();
    const request = new AbortController();
    searchRequest.current = request;
    setBusy(true); setError(null);
    try {
      const page = await client.searchSessionMessages(sessionId, query.trim(), next, request.signal);
      if (request.signal.aborted) return;
      // Search pages replace each other; the result list cannot grow indefinitely.
      setResults(page.results); setCursor(page.nextCursor);
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : "搜索失败");
    } finally { if (!request.signal.aborted) setBusy(false); }
  }

  async function locate(value: { around: string } | { before: string } | { after: string }) {
    contextRequest.current?.abort();
    const request = new AbortController();
    contextRequest.current = request;
    setContextBusy(true); setContextError(null);
    try {
      const page = await client.getMessageContext(sessionId, value, request.signal);
      if (request.signal.aborted) return;
      setContext(page); setTarget("around" in value ? value.around : null);
    } catch (cause) {
      if (!request.signal.aborted) setContextError(cause instanceof Error ? cause.message : "消息加载失败");
    } finally { if (!request.signal.aborted) setContextBusy(false); }
  }

  useEffect(() => {
    searchRequest.current?.abort(); contextRequest.current?.abort();
    setResults([]); setCursor(null); setContext(null); setTarget(null); setContextBusy(false); setContextError(null); setError(null);
    if (!query.trim()) { setBusy(false); return; }
    setBusy(true);
    const timer = setTimeout(() => { void search(); }, 250);
    return () => { clearTimeout(timer); searchRequest.current?.abort(); contextRequest.current?.abort(); };
    // Requests are bound to this session/query generation and cancelled on replacement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, sessionId]);

  useEffect(() => {
    const root = contextRef.current;
    if (!root) return;
    root.scrollTop = 0;
    if (target) root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target)}"]`)?.scrollIntoView({ block: "center" });
  }, [context, target]);

  return (
    <section role="dialog" aria-modal="true" aria-label="搜索当前会话" className="absolute inset-0 z-30 flex min-h-0 flex-col bg-bg"
      onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); onClose(); }
        if (event.key === "Tab") {
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input,[tabindex="0"]'));
          const first = controls[0]; const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <form className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2" onSubmit={event => { event.preventDefault(); void search(); }}>
        <Search size={16} className="shrink-0 text-ink-3" />
        <input ref={inputRef} autoFocus aria-label="搜索当前会话" placeholder="搜索当前会话" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} className="h-8 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none" />
        {busy && <LoaderCircle size={14} className="shrink-0 animate-spin text-ink-3" />}
        <button ref={closeRef} type="button" title="关闭搜索" aria-label="关闭搜索" className={iconButton} onClick={onClose}><X size={16} /></button>
      </form>
      <div className="min-h-0 overflow-y-auto border-b border-line px-4 py-2" style={{ maxHeight: context ? "30%" : "100%" }}>
        {error && <div role="alert" className="py-2 text-xs text-danger">{error}<button className="ml-2 underline" onClick={() => void search()}>重试</button></div>}
        {!busy && !error && query.trim() && results.length === 0 && <p role="status" className="py-3 text-sm text-ink-3">没有匹配的消息</p>}
        {results.map(hit => <button type="button" key={hit.partId} onClick={() => void locate({ around: hit.messageId })} className="flex w-full items-start gap-2 border-b border-line/50 px-1 py-3 text-left text-xs text-ink-2 hover:bg-surface-2 focus-visible:outline focus-visible:outline-accent">
          {hit.kind === "tool" ? <Wrench size={14} className="mt-0.5 shrink-0" /> : hit.kind === "attachment_name" ? <File size={14} className="mt-0.5 shrink-0" /> : <Search size={14} className="mt-0.5 shrink-0" />}
          <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{hit.snippet.slice(0, hit.match.start)}<mark className="bg-warning-tint text-ink">{hit.snippet.slice(hit.match.start, hit.match.start + hit.match.length)}</mark>{hit.snippet.slice(hit.match.start + hit.match.length)}</span>
        </button>)}
        {cursor && <button type="button" disabled={busy} className="py-3 text-xs text-ink-2 disabled:opacity-40" onClick={() => void search(cursor)}>更多结果</button>}
      </div>
      {contextBusy && <div role="status" className="flex items-center gap-2 px-4 py-2 text-xs text-ink-3"><LoaderCircle size={14} className="animate-spin" />正在定位消息…</div>}
      {contextError && <div role="alert" className="px-4 py-2 text-xs text-danger">{contextError}</div>}
      {context && <>
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-1 text-xs text-ink-3">
          <span className="min-w-0 flex-1">消息上下文</span>
          <button type="button" title="更早消息" aria-label="更早消息" disabled={!context.beforeCursor || contextBusy} className={iconButton} onClick={() => void locate({ before: context.beforeCursor! })}><ArrowUp size={14} /></button>
          <button type="button" title="更新消息" aria-label="更新消息" disabled={!context.afterCursor || contextBusy} className={iconButton} onClick={() => void locate({ after: context.afterCursor! })}><ArrowDown size={14} /></button>
        </div>
        <div ref={contextRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {context.messages.map(message => <article key={message.info.id} data-message-id={message.info.id} className={`min-w-0 rounded-md p-3 ${message.info.id === target ? "bg-warning-tint ring-1 ring-warning/40" : ""}`}>
            <div className="mb-2 text-xs text-ink-3">{message.info.role === "user" ? "你" : "助手"}</div>
            {message.parts.map(part => part.type === "text" ? <SearchText key={part.id} text={part.text} />
              : part.type === "file" ? <div key={part.id} className="flex items-center gap-2 break-all text-xs"><File size={14} className="shrink-0" />{part.filename}</div>
              : part.type === "tool" ? <div key={part.id} className="flex items-center gap-2 break-all text-xs text-ink-2"><Wrench size={14} className="shrink-0" />{part.tool} {"title" in part.state ? part.state.title : ""}</div> : null)}
          </article>)}
        </div>
      </>}
    </section>
  );
}
