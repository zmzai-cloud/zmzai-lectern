"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarDays, Download } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@zmzai/theme";

import type { UpdateState } from "@/lib/types";

function formatReleaseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

function isPending(update: UpdateState | null): update is UpdateState {
  return update?.status === "available" || update?.status === "downloading" || update?.status === "ready";
}

/** 账户区常显的更新入口：hover 看发布日志，download 完成前点击直接下载，
 *  ready 后点击由父组件打开应用内确认框。 */
export function UpdateIndicator({ update, taskRunning, onDownload, onConfirm }: {
  update: UpdateState | null;
  taskRunning: boolean;
  onDownload: () => void;
  onConfirm: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  if (!isPending(update)) return null;
  const downloading = update.status === "downloading";
  const notes = update.releaseNotes;
  const statusText = downloading
    ? `正在下载 ${update.percent}%`
    : update.status === "ready"
      ? taskRunning ? "任务运行中，完成后可重启更新" : "已下载，点击重启更新"
      : "点击下载更新";
  const actionText = update.status === "ready" ? "重启以更新" : downloading ? "正在下载更新" : "下载更新";

  const open = () => {
    clear();
    setHovered(true);
  };
  const close = () => {
    clear();
    setHovered(false);
  };
  const hover = () => {
    clear();
    timer.current = window.setTimeout(() => setHovered(true), 120);
  };

  return (
    <div className="relative mr-0.5 shrink-0" onMouseEnter={hover} onMouseLeave={close}>
      {hovered && (
        <div
          id="update-changelog"
          role="tooltip"
          className="absolute bottom-full left-0 z-40 mb-2 w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-bg shadow-lg"
        >
          <div className="border-b border-line px-3.5 py-2.5">
            <div className="text-xs font-medium text-ink">v{update.version} 更新日志</div>
            {notes && <div className="mt-0.5 text-[0.6875rem] text-ink-3">{formatReleaseDate(notes.date)}</div>}
          </div>
          <div className="max-h-64 overflow-y-auto px-3.5 py-3">
            {notes ? notes.sections.map((section) => (
              <div key={section.title} className="mb-3 last:mb-0">
                <div className="mb-1 text-[0.6875rem] font-medium text-ink">{section.title}</div>
                <ul className="space-y-1">
                  {section.items.map((item, index) => (
                    <li key={`${section.title}-${index}`} className="flex gap-1.5 text-[0.6875rem] leading-relaxed text-ink-2">
                      <span className="mt-[0.45em] h-1 w-1 shrink-0 rounded-full bg-ink-3" aria-hidden />
                      <span className="min-w-0 break-words">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )) : (
              <p className="text-[0.6875rem] leading-relaxed text-ink-2">本次更新包含稳定性与问题修复。</p>
            )}
          </div>
          <div className="border-t border-line bg-surface px-3.5 py-2 text-[0.625rem] text-ink-3">{statusText}</div>
        </div>
      )}
      <button
        type="button"
        data-testid="update-indicator"
        aria-label={`更新 v${update.version}：${actionText}`}
        aria-describedby={hovered ? "update-changelog" : undefined}
        aria-disabled={downloading}
        onClick={() => {
          if (downloading) return;
          close();
          if (update.status === "ready") onConfirm();
          else onDownload();
        }}
        onFocus={open}
        onBlur={close}
        className={`flex h-7 w-7 items-center justify-center rounded-full bg-success text-bg transition-opacity hover:opacity-85 ${downloading ? "cursor-not-allowed opacity-60" : ""}`}
      >
        <Download size={14} strokeWidth={2} className={downloading ? "animate-pulse" : undefined} aria-hidden />
      </button>
    </div>
  );
}

export function UpdateConfirmDialog({ open, update, taskRunning, onOpenChange, onInstall }: {
  open: boolean;
  update: UpdateState | null;
  taskRunning: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: () => Promise<boolean>;
}) {
  const [installing, setInstalling] = useState(false);
  const install = async () => {
    if (installing) return;
    setInstalling(true);
    const ok = await onInstall();
    if (!ok) {
      setInstalling(false);
      onOpenChange(false);
    }
  };
  return (
    <Dialog open={open && update?.status === "ready"} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[26rem]">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-ink text-bg">
            <Download size={20} strokeWidth={2} aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-sm font-medium text-ink">v{update?.version} 已准备就绪</DialogTitle>
            <DialogDescription className="mt-1 flex items-center gap-1.5 text-xs text-ink-3">
              <CalendarDays size={13} aria-hidden />
              {update?.releaseNotes ? formatReleaseDate(update.releaseNotes.date) : "更新已下载"}
            </DialogDescription>
          </div>
        </div>
        {taskRunning && (
          <p role="status" className="mt-4 rounded-md bg-surface-2 px-3 py-2 text-[0.6875rem] leading-relaxed text-ink-2">
            任务运行中，完成后才能重启更新；现在重启会中止正在运行的任务。
          </p>
        )}
        <DialogFooter className="mt-5">
          <DialogClose asChild>
            <button
              type="button"
              className="rounded-md bg-surface-2 px-3.5 py-2 text-xs font-medium text-ink-2 transition-colors hover:bg-line hover:text-ink"
            >
              稍后
            </button>
          </DialogClose>
          <button
            type="button"
            disabled={taskRunning || installing}
            onClick={() => void install()}
            className="rounded-md bg-ink px-3.5 py-2 text-xs font-medium text-bg transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {installing ? "正在准备…" : "重启以更新"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
