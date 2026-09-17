"use client";

import { cn } from "@zmzai/theme";

import type { ConnectionState } from "@/lib/client";
import type { SessionIsolation } from "@/lib/types";

/**
 * 任务上下文条右侧动作区（visual spec §4.2 / §4.7）。
 *
 * 原先这些控件散落在 ChatView 的「对话」头部条里：连接态 pill、worktree 隔离
 * pill、自治档位开关。§4.2 要求它们并入任务上下文条，而上下文条只负责渲染状态、
 * 不认识具体控件，因此以插槽形式由本组件组装。
 *
 * 与 ChatView 解耦后，本组件只依赖 page.tsx 已有的状态（connState / isolation /
 * autoMode），不再需要把 status 透传给对话区。
 */

type Props = {
  connState: ConnectionState;
  /** 会话级 worktree 隔离状态（robustness-plan §9）。 */
  isolation?: SessionIsolation | null;
  onWorktreeAction?: (action: "merge" | "discard") => Promise<void>;
  /** 任务运行中：合并/丢弃必须禁用（与原先 `disabled={running}` 语义一致）。 */
  locked: boolean;
  autoMode: boolean;
  onToggleAuto: () => void;
};

export default function TaskBarActions({
  connState,
  isolation,
  onWorktreeAction,
  locked,
  autoMode,
  onToggleAuto,
}: Props) {
  return (
    <>
      {/* 连接态：正常不占视觉；断线时黄点转圈 / 红点（全量文案在下方横幅里） */}
      {connState !== "connected" && (
        <span
          title={connState === "offline" ? "连接已中断，点击面板可重试" : "连接中断，正在自动恢复…"}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium",
            connState === "offline" ? "bg-danger-tint text-danger" : "bg-warning-tint text-warning",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              connState === "offline" ? "bg-danger" : "animate-pulse bg-warning",
            )}
          />
          {connState === "offline" ? "已断开" : "重连中"}
        </span>
      )}

      {/* 会话级 worktree 隔离（robustness-plan §9）：pill 标识 + 合并/丢弃 */}
      {isolation?.enabled && onWorktreeAction && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-surface-2 py-1 pl-2 pr-1 text-xs font-medium text-ink-2">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
            <circle cx="4.5" cy="3.5" r="1.7" />
            <circle cx="4.5" cy="12.5" r="1.7" />
            <circle cx="11.5" cy="6.5" r="1.7" />
            <path d="M4.5 5.2v5.6M11.5 8.2c0 2-2 2.6-5.2 2.8" strokeLinecap="round" />
          </svg>
          <span title={isolation.path}>隔离副本</span>
          <button
            type="button"
            disabled={locked}
            onClick={() => void onWorktreeAction("merge")}
            title="把副本提交合并回主工作区当前分支（主工作区有未提交改动时会拒绝）"
            className="rounded-md px-2 py-1 text-xs font-medium text-ink transition-colors hover:bg-accent hover:text-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            合并
          </button>
          <button
            type="button"
            disabled={locked}
            onClick={() => void onWorktreeAction("discard")}
            title="丢弃副本（未合并的提交一并删除）"
            className="rounded-md px-2 py-1 text-xs font-medium text-ink-3 transition-colors hover:bg-danger-tint hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
          >
            丢弃
          </button>
        </span>
      )}

      {/* 自治档位（P1-7）：对标 Qoder 的 Quest 自动执行。
          开关是安全相关控件，激活态保留实心填充以示「已开启」，文字与图标同步变化。 */}
      <button
        type="button"
        onClick={onToggleAuto}
        aria-pressed={autoMode}
        title={autoMode ? "自动档：写文件/命令不再逐次确认，点击切回确认档" : "确认档：敏感操作逐次确认，点击切到自动档"}
        className={cn(
          "inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors",
          autoMode ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2 hover:text-ink",
        )}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          {autoMode ? (
            <path d="M2.5 8.5l3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <>
              <rect x="3.5" y="6.5" width="9" height="7" rx="1.2" />
              <path d="M5.5 6.5V5a2.5 2.5 0 0 1 5 0v1.5" />
            </>
          )}
        </svg>
        {autoMode ? "自动" : "确认"}
      </button>
    </>
  );
}
