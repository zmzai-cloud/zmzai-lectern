"use client";

import { useSyncExternalStore } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, cn } from "@zmzai/theme";

/**
 * 自绘确认框（替代原生 window.confirm，2026-10-11 用户拍板）。
 *
 * 【为什么要自绘】原生 confirm 在 Electron 里是系统级弹窗：样式与应用
 * 完全脱节、阻塞渲染进程、无法带危险分级。这里复用 @zmzai/theme 的
 * Radix Dialog（焦点圈闭/Esc/Portal 语义齐全）。
 *
 * 【调用形态】Promise 单例：调用方 `await confirmDialog({...})` 即可，
 * 不需要在每个调用点摆 JSX——全 app 只挂一个 <ConfirmDialogHost/>（page）。
 * confirm 期间再 confirm 会顶掉前一个（resolve false）——确认框本就该
 * 互斥，静默取消旧的比排队两个更符合直觉。
 */

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 破坏性操作（删除/丢弃/回滚）：确认键 danger 红。默认 false。 */
  danger?: boolean;
};

type Pending = { options: ConfirmOptions; resolve: (ok: boolean) => void };

let pending: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

/** 弹出自绘确认框；resolve(true)=确认，resolve(false)=取消/Esc/被顶掉。 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = { options, resolve };
    emit();
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => pending;

export function ConfirmDialogHost() {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const settle = (ok: boolean) => {
    current?.resolve(ok);
    pending = null;
    emit();
  };
  return (
    <Dialog open={current != null} onOpenChange={(open) => { if (!open) settle(false); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{current?.options.title}</DialogTitle>
          {current?.options.description && <DialogDescription>{current.options.description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            onClick={() => settle(false)}
            className="rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-line hover:text-ink"
          >
            {current?.options.cancelLabel ?? "取消"}
          </button>
          <button
            type="button"
            onClick={() => settle(true)}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-85",
              current?.options.danger ? "bg-danger text-bg" : "bg-ink text-bg",
            )}
          >
            {current?.options.confirmLabel ?? "确认"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
