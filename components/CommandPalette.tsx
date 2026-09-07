"use client";
import { usePlatform } from "@/lib/use-platform";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@zmzai/theme";

import { client } from "@/lib/client";

export type Command = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

type PaletteMode = "commands" | "files" | "search";

type Item = { key: string; label: string; sub?: string; hint?: string; run: () => void };

/**
 * 命令面板（P2-12）：⌘K 命令 / ⌘P 文件快开 / ⌘⇧F 全文搜索（IDE 感标配）。
 * mode "commands" 渲染传入命令列表；"files" 走 /api/fs/search 递归文件名搜索；
 * "search" 走 /api/sessions/search 全文搜索，选中后切换到命中会话。
 */
export default function CommandPalette({
  mode,
  commands,
  onOpenFile,
  onSelectSession,
  onClose,
  sessionId,
}: {
  mode: PaletteMode;
  commands: Command[];
  onOpenFile: (path: string, line?: number) => void;
  onSelectSession: (id: string) => void;
  onClose: () => void;
  sessionId?: string | null;
}) {
  const [query, setQuery] = useState("");
  const { modifier, shift } = usePlatform();
  const [index, setIndex] = useState(0);
  const [fileHits, setFileHits] = useState<{ path: string; type: "dir" | "file" }[]>([]);
  const [searchHits, setSearchHits] = useState<{ sessionId: string; title: string; snippet: string }[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 文件模式：输入防抖搜索
  useEffect(() => {
    if (mode !== "files") return;
    const t = setTimeout(() => {
      void client
        .fsSearch(query.trim(), sessionId)
        .then((r) => setFileHits(r.results.filter((x) => x.type === "file")))
        .catch(() => setFileHits([]));
    }, 180);
    return () => clearTimeout(t);
  }, [query, mode, sessionId]);

  // 全文搜索模式：输入防抖搜索（服务端遍历转录，防抖给长一点）
  useEffect(() => {
    if (mode !== "search") return;
    if (!query.trim()) {
      setSearchHits([]);
      return;
    }
    const t = setTimeout(() => {
      void client
        .searchSessions(query.trim())
        .then((r) => setSearchHits(r.results))
        .catch(() => setSearchHits([]));
    }, 280);
    return () => clearTimeout(t);
  }, [query, mode]);

  const items = useMemo<Item[]>(() => {
    if (mode === "commands") {
      const q = query.trim().toLowerCase();
      return commands
        .filter((c) => !q || c.label.toLowerCase().includes(q))
        .map((c) => ({ key: c.id, label: c.label, hint: c.hint, run: c.run }));
    }
    if (mode === "files") {
      return fileHits.map((f) => ({ key: f.path, label: f.path, hint: "文件", run: () => onOpenFile(f.path) }));
    }
    return searchHits.map((r) => ({ key: r.sessionId, label: r.title, sub: r.snippet, hint: "会话", run: () => onSelectSession(r.sessionId) }));
  }, [mode, commands, fileHits, searchHits, query, onOpenFile, onSelectSession]);

  useEffect(() => setIndex(0), [query, mode]);

  const commit = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    it.run();
  };

  const placeholder =
    mode === "files" ? "搜索文件名…（⏎ 打开）" : mode === "search" ? "搜索会话内容…（⏎ 跳转）" : "输入命令…";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 pt-[14vh]" onClick={onClose}>
      <div
        className="w-[560px] max-w-[92vw] overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => (i + 1) % Math.max(items.length, 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => (i - 1 + items.length) % Math.max(items.length, 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              commit(index);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder={placeholder}
          className="h-11 w-full border-b border-line bg-transparent px-4 text-sm text-ink outline-none placeholder:text-ink-3"
        />
        <div className="max-h-80 overflow-y-auto p-1.5">
          {items.map((it, i) => (
            <button
              key={it.key}
              type="button"
              onMouseEnter={() => setIndex(i)}
              onClick={() => commit(i)}
              className={cn(
                "flex w-full flex-col gap-0.5 rounded-sm px-3 py-2 text-left transition-colors",
                i === index ? "bg-selected" : "hover:bg-surface-3",
              )}
            >
              <span className="flex w-full items-center gap-2">
                <span className={cn("truncate text-xs", mode === "files" && "font-mono")} title={it.label}>
                  {it.label}
                </span>
                <span className="ml-auto shrink-0 text-[0.625rem] text-ink-3">{it.hint}</span>
              </span>
              {it.sub && <span className="truncate text-[0.6875rem] leading-4 text-ink-3">{it.sub}</span>}
            </button>
          ))}
          {items.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-ink-3">
              {mode === "files" ? "没有匹配的文件。" : mode === "search" ? (query.trim() ? "没有命中的会话。" : "输入关键词搜索会话内容。") : "没有匹配的命令。"}
            </div>
          )}
        </div>
        <div className="flex h-7 items-center gap-3 border-t border-line px-3 text-[0.625rem] text-ink-3">
          <span>↑↓ 选择</span>
          <span>⏎ 执行</span>
          <span>Esc 关闭</span>
          <span className="flex-1" />
          <span>{mode === "files" ? `${modifier}P 文件` : mode === "search" ? `${modifier}${shift}F 搜索` : `${modifier}K 命令`}</span>
        </div>
      </div>
    </div>
  );
}
