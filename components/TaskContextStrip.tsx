"use client";

import type { ReactNode } from "react";
import { cn } from "@zmzai/theme";
import { FolderClosed } from "lucide-react";

import type {
  IconKind,
  TaskPresentation,
  TaskPresentationState,
  TaskPresentationView,
} from "@/lib/task-presentation";

/**
 * 任务上下文条（visual-system-realignment spec §4.2 / §5）。
 *
 * 位于中央对话区顶部，替代原先散落的「对话 / 空闲 / 自动」等独立控件。
 * **状态的唯一展示来源是 `deriveTaskPresentation` 的派生结果**——本组件不做
 * 任何状态判断，只负责把 TaskPresentation 渲染出来。
 *
 * 每条状态同时具备三重表达（§7.2「颜色不是唯一表达」）：
 *   1. 图标（形状）—— IconGlyph；
 *   2. 可读文字—— presentation.label；
 *   3. 辅助技术可读说明—— role="status" + aria-label。
 *
 * 宽度不足时按 §4.2 的折叠顺序：先折叠路径和模型，再折叠操作详情；
 * 任务标题与状态文字始终可见（不允许只剩一个无文字的状态点）。
 */

type Props = {
  presentation: TaskPresentation;
  /** 任务标题（绝不截断到不可读；超长时 truncate + title 兜底全文）。 */
  title: string;
  /** 项目名（可选，次级）。 */
  projectName?: string | null;
  /** 当前操作 / 完成摘要（可选，窄屏优先折叠）。 */
  summary?: string | null;
  /** 次级元数据，如模型名（可选，窄屏优先折叠）。 */
  meta?: string | null;
  /**
   * 当前持久任务的呈现模型（规格 3 §15.2）。
   *
   * 【为什么给它，而 presentation.state 已经够画一个状态点】`presentation`
   * 回答的是「这条会话看起来处于什么状态」，粒度是会话级的六态；任务层能回答
   * 更具体的问题——在等**什么**（授权 / 补充信息 / 登录）、做到第几步。用户扫
   * 一眼就能判断要不要回来处理，而不必点进会话看。没有任务（历史会话）时
   * 传 null，条的行为与改造前一致。
   */
  task?: TaskPresentationView | null;
  /**
   * 右侧动作区（连接态、隔离副本、自治档位等）。
   *
   * §4.2 明文要求上下文条替代散落的「对话 / 空闲 / 自动」等独立控制，因此这些
   * 控件由调用方以插槽注入——条本身不认识任何具体控件，保持「只渲染状态」。
   */
  actions?: ReactNode;
};

/** 状态 → 语义色 class。只消费 theme 既有语义 token，不写硬编码色值（§7.3）。 */
const STATE_STYLE: Record<
  TaskPresentationState,
  { text: string; tint: string; dot: string }
> = {
  idle: { text: "text-ink-2", tint: "bg-surface-2", dot: "bg-ink-3" },
  running: { text: "text-live", tint: "bg-live-tint", dot: "bg-live" },
  needs_input: { text: "text-warning", tint: "bg-warning-tint", dot: "bg-warning" },
  review_ready: { text: "text-ink-2", tint: "bg-surface-2", dot: "bg-accent" },
  delivered: { text: "text-success", tint: "bg-success-tint", dot: "bg-success" },
  failed: { text: "text-danger", tint: "bg-danger-tint", dot: "bg-danger" },
};

/** 辅助技术的完整状态说明（比可见 label 更完整，便于屏幕阅读器理解上下文）。 */
const STATE_DESCRIPTION: Record<TaskPresentationState, string> = {
  idle: "空闲：没有正在执行的任务",
  running: "运行中：Agent 正在执行任务",
  needs_input: "需要输入：有等待你确认的审批或提问",
  review_ready: "待审查：任务已完成并有待你审查的变更",
  delivered: "已交付：任务产出了可预览的成果",
  failed: "失败：任务执行失败",
};

/** 图标（形状）：颜色之外的第一重表达，全部 12px 线性图标。 */
function IconGlyph({ kind, pulse }: { kind: IconKind; pulse: boolean }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: pulse ? "animate-spin" : undefined,
    "aria-hidden": true,
  };
  switch (kind) {
    case "spinner":
      // 转圈：3/4 圆弧 + 缺口，pulse 时旋转
      return (
        <svg {...common}>
          <path d="M8 1.8a6.2 6.2 0 1 1-6.2 6.2" />
        </svg>
      );
    case "question":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.2" />
          <path d="M6.3 6.2a1.7 1.7 0 1 1 1.7 1.7v1.1" />
          <path d="M8 11.3h.01" />
        </svg>
      );
    case "diff":
      // 差异：两条不等长竖线（并排对比语义）
      return (
        <svg {...common}>
          <path d="M4.5 2.5v11M11.5 2.5v11" />
          <path d="M2.5 6h4M9.5 10h4" />
        </svg>
      );
    case "artifact":
      // 成果：带折角的文档
      return (
        <svg {...common}>
          <path d="M9 1.8H4a1.2 1.2 0 0 0-1.2 1.2v10a1.2 1.2 0 0 0 1.2 1.2h8a1.2 1.2 0 0 0 1.2-1.2V6.3z" />
          <path d="M9 1.8V6.3h4.2" />
        </svg>
      );
    case "error":
      return (
        <svg {...common}>
          <path d="M8 2.6 14.2 13.4H1.8z" />
          <path d="M8 6.6v2.6M8 11.6h.01" />
        </svg>
      );
    case "spark":
    default:
      // 就绪：四角星
      return (
        <svg {...common}>
          <path d="M8 2.2v3.2M8 10.6v3.2M2.2 8h3.2M10.6 8h3.2" />
          <path d="M8 5.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z" />
        </svg>
      );
  }
}

export default function TaskContextStrip({
  presentation,
  title,
  projectName,
  summary,
  meta,
  task,
  actions,
}: Props) {
  const style = STATE_STYLE[presentation.state];
  const isRunning = presentation.state === "running";
  // 有任务时用任务层的文案（「等待授权」比「需输入」说得清）与进度；
  // 没有任务就退回会话级六态的文案。
  const label = task?.label ?? presentation.label;
  const description = task ? `任务状态：${label}${task.progress ? `，已完成 ${task.progress.done}/${task.progress.total} 步` : ""}` : STATE_DESCRIPTION[presentation.state];

  return (
    // 整条不是 live region：任务标题/摘要每次切会话都会变，整条播报太吵。
    // 只有状态徽标是 role="status"，状态变化才播报。
    <div className="task-context flex min-h-12 min-w-0 flex-1 items-center gap-3 px-4">
      <FolderClosed size={17} strokeWidth={1.6} className="shrink-0 text-ink-2" aria-hidden />
      {/* 主状态徽标：图标 + 文字（形状与文字都不折叠，颜色只是辅助） */}
      <span
        role="status"
        aria-label={description}
        data-task-primary-status="true"
        data-task-status={task?.status}
        className={cn(
          "order-2 inline-flex shrink-0 items-center gap-1 py-0.5 text-xs font-medium",
          presentation.state === "idle" && "sr-only",
          style.text,
        )}
        title={description}
      >
        <IconGlyph kind={presentation.icon} pulse={isRunning} />
        {label}
      </span>

      {/* 任务进度（规格 §14.1「2/5 已完成」）。只在真有步骤时出现——
          显示一个恒为 0/0 的进度条比不显示更糟。 */}
      {task?.progress && (
        <span className="order-2 shrink-0 font-mono text-[0.6875rem] text-ink-3" data-task-progress>
          {task.progress.done}/{task.progress.total}
        </span>
      )}

      {/* 任务标题：可截断但有 title 兜底；绝不让它消失 */}
      <span className="min-w-0">
        <span
          className="block truncate text-[0.875rem] font-semibold text-ink"
          title={projectName ? `${title} · ${projectName}` : title}
        >
          {title}
        </span>
        {(projectName || meta) && (
          <span className="hidden min-w-0 truncate text-xs leading-4 text-ink-3 sm:block">
            {[projectName, meta].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>

      {/* 操作/完成摘要（更次级，宽屏才显示） */}
      {summary && isRunning && (
        <span
          className="hidden min-w-0 flex-1 truncate text-xs text-ink-3 lg:block"
          title={summary}
        >
          {summary}
        </span>
      )}

      <span className="flex-1" />

      {/* 次级失败 badge（§7.6）：失败但产物在时，失败降级为次级信息而非吞掉 */}
      {presentation.failureBadge && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-danger-tint px-2 py-1 text-xs font-medium text-danger"
          title={presentation.failureBadge.label}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <path d="M8 2.6 14.2 13.4H1.8z" />
            <path d="M8 6.6v2.6M8 11.6h.01" />
          </svg>
          {presentation.failureBadge.label}
        </span>
      )}

      {actions && (
        <span className="order-3 flex shrink-0 items-center gap-1.5">{actions}</span>
      )}
    </div>
  );
}
