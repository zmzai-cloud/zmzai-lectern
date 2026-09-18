"use client";

import { useState } from "react";

import type { TaskRecordView } from "@/lib/types";
import type { TaskActionId, TaskPresentationView, TaskTone } from "@/lib/task-presentation";
import type { TaskAttempt } from "@/lib/chat-projector";
import { cn } from "@zmzai/theme";

/** 任务进度 / 阻塞 / 交付三张卡（规格 3 §14.1 / §14.2 / §14.3）。
 *
 *  【为什么从 SummaryCard 里分出来】旧实现把「这一轮跑完了」和「任务完成了」
 *  画在同一张卡上，并且都叫「任务完成」——这正是规格 §3.2 的根因。现在两者
 *  在数据上已经分开（`session.summary` vs `task.*`），在视觉上也要分开：
 *  本文件的三张卡只认 `TaskRecordView`，`SummaryCard` 只讲「本轮」。
 *
 *  视觉遵循「去线原则」：分层靠 tint 底色，不给卡片、胶囊加描边；线条只留给
 *  面板边界、浮层与输入焦点。 */

const TONE_DOT: Record<TaskTone, string> = {
  idle: "bg-ink-3",
  live: "bg-live",
  wait: "bg-warning",
  warn: "bg-warning",
  ok: "bg-success",
  danger: "bg-danger",
};

const TONE_TEXT: Record<TaskTone, string> = {
  idle: "text-ink-2",
  live: "text-ink",
  wait: "text-ink",
  warn: "text-ink",
  ok: "text-ink",
  danger: "text-danger",
};

function ms(value: number): string {
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function StepMark({ status }: { status: string }) {
  if (status === "completed")
    return <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-success text-[8px] font-bold text-bg">✓</span>;
  if (status === "in_progress") return <span className="h-3.5 w-3.5 animate-pulse rounded-full border-2 border-live" />;
  if (status === "cancelled")
    return <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-surface-2 text-[8px] text-ink-3">—</span>;
  if (status === "blocked")
    return <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-warning/20 text-[8px] text-ink-2">!</span>;
  return <span className="h-3.5 w-3.5 rounded-full border border-ink-3" />;
}

/** 动作按钮。`primary` 的那颗是「用户此刻该做的那件事」，其余是次要动作。 */
function TaskActionButton({ action, onAction }: { action: TaskPresentationView["actions"][number]; onAction: (id: TaskActionId) => void }) {
  return (
    <button
      type="button"
      onClick={() => onAction(action.id)}
      title={action.hint}
      className={cn(
        "rounded-pill px-3 py-1 text-[0.6875rem] font-medium transition-colors",
        action.primary ? "bg-ink text-bg hover:opacity-90" : "bg-surface-2 text-ink-2 hover:bg-line hover:text-ink",
      )}
    >
      {action.label}
    </button>
  );
}

/** 进度区（规格 §14.1）：当前步骤、x/y、最近里程碑、运行时间 + 可展开的计划。 */
export function TaskProgressCard({
  task,
  view,
  attempts,
  onAction,
}: {
  task: TaskRecordView;
  view: TaskPresentationView;
  attempts: TaskAttempt[];
  onAction: (id: TaskActionId) => void;
}) {
  const [open, setOpen] = useState(false);
  const progress = view.progress;
  const milestone = task.evidence?.recent[0];
  return (
    <div className="chat-task-progress rounded-lg bg-surface-2/60 px-3 py-2.5" data-task-status={task.status}>
      <div className="flex items-center gap-2">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[view.tone], view.tone === "live" && "animate-pulse")} />
        <span className={cn("text-[0.6875rem] font-semibold tracking-wide", TONE_TEXT[view.tone])} data-task-label>
          {view.label}
        </span>
        {progress && (
          <span className="font-mono text-[0.625rem] text-ink-3">
            {progress.done}/{progress.total}
          </span>
        )}
        {typeof task.activeMs === "number" && task.activeMs > 0 && <span className="font-mono text-[0.625rem] text-ink-3">{ms(task.activeMs)}</span>}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[0.625rem] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
        >
          {open ? "收起" : "计划与轨迹"}
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={cn("transition-transform", open && "rotate-180")}>
            <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="mt-1.5 space-y-0.5 pl-3.5">
        <div className="text-[0.8125rem] leading-[1.6] text-ink" data-task-goal>
          {task.goal}
        </div>
        {progress?.current && (
          <div className="text-[0.75rem] leading-5 text-ink-2">
            正在做：<span className="text-ink">{progress.current}</span>
          </div>
        )}
        {milestone && (
          <div className="truncate text-[0.75rem] leading-5 text-ink-2" title={milestone.summary}>
            最近一步：{milestone.summary}
          </div>
        )}
      </div>

      {view.needsUser && task.blocker && (
        <div className="mt-2 rounded-md bg-warning/10 px-2.5 py-2" data-task-blocker={task.blocker.kind}>
          <div className="text-[0.75rem] leading-5 text-ink" data-task-blocker-message>
            {task.blocker.message}
          </div>
          <div className="mt-0.5 text-[0.6875rem] leading-5 text-ink-2" data-task-blocker-action>
            {task.blocker.requiredAction}
          </div>
        </div>
      )}

      {view.actions.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-3.5">
          {view.actions.map((action) => (
            <TaskActionButton key={action.id} action={action} onAction={onAction} />
          ))}
        </div>
      )}

      {open && (
        <div className="mt-2.5 space-y-2 pl-3.5">
          {task.steps.length > 0 && (
            <div className="space-y-1">
              {task.steps.map((step) => (
                <div key={step.id} className="flex items-center gap-2">
                  <StepMark status={step.status} />
                  <span className={cn("text-xs leading-5", step.status === "completed" ? "text-ink-3 line-through" : step.status === "in_progress" ? "font-medium text-ink" : "text-ink-2")}>
                    {step.title}
                  </span>
                </div>
              ))}
            </div>
          )}
          {attempts.length > 0 && (
            <div className="space-y-0.5">
              <div className="text-[0.6875rem] font-semibold tracking-wide text-ink-3">执行轨迹</div>
              {attempts.map((item) => (
                <div key={item.attempt} className="flex items-center gap-2 font-mono text-[0.625rem] leading-5">
                  <span className={cn("h-1 w-1 shrink-0 rounded-full", item.outcome === "error" ? "bg-danger" : item.outcome === "aborted" ? "bg-warning" : "bg-success")} />
                  <span className="shrink-0 text-ink-2">第 {item.attempt} 轮</span>
                  <span className="text-ink-3">{item.toolCalls} 次工具调用</span>
                  {item.filesEdited > 0 && <span className="text-ink-3">改动 {item.filesEdited} 个文件</span>}
                  {item.durationMs > 0 && <span className="ml-auto shrink-0 text-ink-3">{ms(item.durationMs)}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 最终交付卡（规格 §14.1）。四个问题固定回答，缺一不可——「做成了什么 /
 *  改了哪些主要内容 / 如何验证 / 是否仍有未完成项」。 */
export function TaskDeliveryCard({ task }: { task: TaskRecordView }) {
  const result = task.result;
  const passed = task.acceptanceCriteria.filter((criterion) => criterion.required && criterion.status === "passed").length;
  const required = task.acceptanceCriteria.filter((criterion) => criterion.required).length;
  const evidence = task.evidence?.count ?? 0;
  const changes = result?.changes ?? [];
  return (
    <div className="chat-task-delivery rounded-lg bg-surface-2/60 px-3 py-2.5" data-task-delivered>
      <div className="flex items-center gap-2">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT.ok)} />
        <span className="text-[0.6875rem] font-semibold tracking-wide text-ink">任务完成</span>
        <span className="flex-1" />
        {/* 完成判定依据摆出来：用户不必相信这句「完成」，可以自己核对（§18.4） */}
        <span className="font-mono text-[0.625rem] text-ink-3" data-task-basis>
          验收 {passed}/{required} · 证据 {evidence} 条
        </span>
      </div>
      <div className="mt-1.5 space-y-1.5 pl-3.5 text-[0.8125rem] leading-[1.6] text-ink">
        <div data-task-outcome>{result?.outcome ?? "任务已交付。"}</div>
        {changes.length > 0 && (
          <div className="text-ink-2">
            改动：<span className="font-mono text-[0.6875rem]">{changes.join("、")}</span>
          </div>
        )}
        {result && result.verification.length > 0 && (
          <div className="text-ink-2">
            验证：
            {result.verification.map((item, index) => (
              <span key={index} className="block pl-1">
                · {item}
              </span>
            ))}
          </div>
        )}
        <div className="text-ink-2" data-task-remaining>
          剩余项：{result && result.remaining.length > 0 ? result.remaining.join("、") : "无"}
        </div>
      </div>
    </div>
  );
}
