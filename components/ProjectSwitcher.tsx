"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeft } from "lucide-react";
import { cn } from "@zmzai/theme";

import { client } from "@/lib/client";
import type { ProjectsState } from "@/lib/types";

/**
 * 项目切换器（左侧栏顶部）：列出最近项目 + 添加本地文件夹。
 * App 内走系统原生对话框（window.lecternNative.pickFolder）；Web 降级为手动输入路径。
 * 切换后服务端 workspaceRoot 全站跟随（会话/文件/Git/终端换库），页面整体重载。
 */
export default function ProjectSwitcher({
  onCollapseSidebar,
  /**
   * 当前项目名上抛给父级（visual spec §4.2：任务上下文条要能辨识当前项目）。
   * 切换器仍是侧栏的稳定起点，这里只是把名字同步出去，不做状态提升。
   */
  onActiveChange,
}: {
  onCollapseSidebar?: () => void;
  onActiveChange?: (name: string | null) => void;
}) {
  const [state, setState] = useState<ProjectsState | null>(null);
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    void client.listProjects().then(setState).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 当前项目名上抛（§4.2）。依赖用 activeName 而非 state，避免无关字段变化触发。
  const activeName = state?.active?.name ?? null;
  useEffect(() => {
    onActiveChange?.(activeName);
  }, [activeName, onActiveChange]);

  // 弹层点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const switchTo = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await client.switchProject(id);
      setOpen(false);
      // 全站跟随：整页重载（会话库/文件树/终端全部换到新项目）
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "切换失败");
    } finally {
      setBusy(false);
    }
  }, []);

  const add = useCallback(
    async (path: string) => {
      if (!path.trim()) return;
      setBusy(true);
      setError(null);
      try {
        await client.addProject(path.trim());
        // addProject 已激活新项目，直接重载进入
        window.location.reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : "添加失败");
        setBusy(false);
      }
    },
    [],
  );

  const pickFolder = useCallback(async () => {
    const bridge = window.lecternNative;
    if (bridge?.pickFolder) {
      const path = await bridge.pickFolder();
      if (path) await add(path);
    } else {
      // Web 无原生对话框：展开手动输入行
      setManual((m) => m);
    }
  }, [add]);

  const active = state?.active;
  const hasBridge = typeof window !== "undefined" && Boolean(window.lecternNative?.pickFolder);

  return (
    <div ref={rootRef} className="relative shrink-0 px-3 pb-1 pt-3">
      <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 py-1 text-left transition-colors hover:bg-surface-2"
        title={active?.path}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 text-ink-3">
          <path d="M1.5 4a1.5 1.5 0 0 1 1.5-1.5h3l1.5 2h6A1.5 1.5 0 0 1 15 6v6a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 2 12V4z" strokeLinejoin="round" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-ink">{active?.name ?? "项目"}</span>
          <span className="block truncate font-mono text-[0.625rem] text-ink-3">{active?.path ?? ""}</span>
        </span>
        <svg
          width="9"
          height="9"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className={cn("shrink-0 text-ink-3 transition-transform", open && "rotate-180")}
        >
          <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {onCollapseSidebar && (
        <button
          type="button"
          onClick={onCollapseSidebar}
          title="收起会话栏"
          aria-label="收起会话栏"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-strong"
        >
          <PanelLeft size={16} strokeWidth={1.55} aria-hidden="true" />
        </button>
      )}
      </div>

      {open && (
        <div className="absolute left-3 right-3 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-md border border-line bg-surface p-1.5 shadow-lg ring-1 ring-line">
          <div className="px-2 py-1.5 text-[0.6875rem] font-semibold text-ink-3">项目（关联本地文件夹）</div>
          {(state?.projects ?? []).map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={busy}
              onClick={() => void switchTo(p.id)}
              className={cn(
                "block w-full rounded-sm px-2 py-1.5 text-left transition-colors",
                p.id === active?.id ? "bg-selected" : "hover:bg-surface-3",
              )}
            >
              <span className="block truncate text-xs font-medium text-ink">{p.name}</span>
              <span className="block truncate font-mono text-[0.625rem] text-ink-3">{p.path}</span>
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            disabled={busy}
            onClick={() => void pickFolder()}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
            {hasBridge ? "添加文件夹（系统对话框）" : "添加文件夹（输入路径）"}
          </button>
          {!hasBridge && (
            <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-1">
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void add(manual);
                }}
                placeholder="/absolute/path/to/project"
                spellCheck={false}
                className="h-7 min-w-0 flex-1 rounded-sm border border-line bg-bg px-2 font-mono text-[0.6875rem] text-ink outline-none placeholder:text-ink-3 focus:border-ink"
              />
              <button
                type="button"
                disabled={busy || !manual.trim()}
                onClick={() => void add(manual)}
                className="shrink-0 rounded-sm bg-ink px-2 py-1 text-[0.6875rem] font-medium text-paper transition-opacity disabled:opacity-40"
              >
                添加
              </button>
            </div>
          )}
          {error && <div className="px-2 pb-1.5 text-[0.6875rem] text-danger">{error}</div>}
        </div>
      )}
    </div>
  );
}
