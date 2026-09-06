import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown, PermissionCard, Reasoning, ToolCard, ToolGroup, cn } from "@zmzai/theme";

import type { ConnectionState } from "@/lib/client";
import type { ChatViewData, TodoItem } from "@/lib/chat-projector";
import type { ModelRef, Part, PermissionRequest, SessionSummary, Artifact } from "@/lib/types";
import Composer from "./Composer";
import DiffView, { diffStat } from "./DiffView";

type SubagentActivity = import("@/lib/chat-projector").SubagentActivity;
type UiPart = import("@/lib/chat-projector").UiPart;
type UiMessage = import("@/lib/chat-projector").UiMessage;

/** N5 失败自动诊断：把已知错误名/错误消息关键词映射成「可能原因 + 建议动作」，
 *  让错误卡不再只报干巴巴的 name+message，而是一眼能懂「为什么断、该怎么办」。 */
function diagnoseError(name: string, message: string): { cause: string; hint: string } | null {
  const n = (name || "").toLowerCase();
  const m = (message || "").toLowerCase();
  if (n.includes("streamidletimeout") || (m.includes("无响应") && m.includes("中止"))) {
    return { cause: "上游长时间无响应，模型可能卡住或不支持该输入（如非视觉模型收到图片）", hint: "点「继续」续跑；若反复超时，换个模型或简化输入" };
  }
  if (n.includes("leaseexpired") || m.includes("服务重启")) {
    return { cause: "服务在运行期间重启，会话上下文已保留但本次运行被打断", hint: "点「继续」即可在同一会话接续，无需重做" };
  }
  if (/\b429\b/.test(m) || m.includes("rate limit") || m.includes("too many requests")) {
    return { cause: "触发上游限流（429），请求太频繁", hint: "稍等片刻再点「继续」，系统会退避重试" };
  }
  if (/\b50[234]\b/.test(m) || m.includes("bad gateway") || m.includes("service unavailable") || m.includes("internal server error")) {
    return { cause: "上游服务暂时不可用（5xx 网关/服务端错误）", hint: "稍后重试；若持续出现，检查模型服务状态" };
  }
  if (m.includes("timeout") || m.includes("etimedout") || m.includes("socket hang up") || m.includes("econnreset") || m.includes("terminated")) {
    return { cause: "网络连接中断或请求超时", hint: "检查网络后点「继续」重试；弱网下可缩短任务" };
  }
  if (n.includes("aborted") || m.includes("已取消") || m.includes("cancelled")) {
    return { cause: "任务被手动中止", hint: "可直接点「继续」接着上次断点跑" };
  }
  return null;
}

/** 内联 diff 卡片：edit/write 工具调用落盘后的变更预览（写入已即时生效）。
 *  标题行带「在文件 Tab 打开」（F3 联动）。 */
function EditDiffCard({ path, diff, onOpenFile }: { path: string; diff: string; onOpenFile?: (path: string, line?: number) => void }) {
  const [open, setOpen] = useState(false);
  const { additions, deletions } = diffStat(diff);
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-ink">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 text-ink-3">
            <path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6L9 2z" strokeLinejoin="round" />
            <path d="M9 2v4h4" strokeLinejoin="round" />
          </svg>
          <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-ink-2" title={path}>{path}</span>
          <span className="shrink-0 font-mono text-[0.625rem]">
            <span className="text-success">+{additions}</span> <span className="text-danger">-{deletions}</span>
          </span>
          <svg
            width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
            className={cn("shrink-0 text-ink-3 transition-transform", open && "rotate-180")}
          >
            <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => onOpenFile?.(path)}
          title="在文件 Tab 打开完整文件"
          className="shrink-0 rounded-pill bg-surface-2 px-2 py-0.5 text-[0.625rem] font-medium text-ink-2 transition-colors hover:text-ink"
        >
          打开
        </button>
      </div>
      {open && <DiffView diff={diff} className="max-h-72 border-t border-line" path={path} />}
    </div>
  );
}

/** 子任务可展开卡片（R3，opencode 式联动）：默认一行（agent + 描述 + 状态），
 *  展开看任务全文 + 子会话工具步骤实时流 + 结束统计。活动数据来自
 *  subagent.started/step/finished 事件投影（framework 桥接自子 runner）。 */
function SubtaskCard({ part, activity }: { part: Extract<Part, { type: "subtask" }>; activity?: SubagentActivity }) {
  const [open, setOpen] = useState(false);
  const running = !activity?.finished;
  const failed = activity?.finished?.state === "error";
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2"
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 text-ink-3">
          <circle cx="8" cy="8" r="2" />
          <circle cx="13.2" cy="3.5" r="1.4" />
          <circle cx="13.2" cy="12.5" r="1.4" />
          <path d="M9.7 7.1l2.3-2.4M9.7 8.9l2.3 2.4" />
        </svg>
        <span className="shrink-0 text-[0.6875rem] font-medium text-ink-2">子任务·{part.agent}</span>
        <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-ink-3" title={part.description}>{part.description}</span>
        <span
          className={cn(
            "shrink-0 rounded-pill px-1.5 py-0.5 text-[0.625rem]",
            running ? "bg-live-tint text-live" : failed ? "bg-danger-tint text-danger" : "bg-surface-2 text-ink-3",
          )}
        >
          {running ? "执行中" : failed ? "失败" : "完成"}
        </span>
        <svg
          width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
          className={cn("shrink-0 text-ink-3 transition-transform", open && "rotate-180")}
        >
          <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="space-y-1 border-t border-line px-3 py-2">
          <div className="whitespace-pre-wrap text-[0.6875rem] leading-5 text-ink-3">{part.prompt}</div>
          {activity?.steps.map((step, i) => (
            <div key={i} className="flex items-center gap-2 font-mono text-[0.625rem] text-ink-3">
              <span className={cn("h-1 w-1 shrink-0 rounded-full", step.state === "error" ? "bg-danger" : "bg-success")} />
              <span className="shrink-0 text-ink-2">{step.tool}</span>
              {step.title && <span className="min-w-0 truncate">{step.title}</span>}
            </div>
          ))}
          {activity?.finished && (
            <div className="pt-1 text-[0.625rem] text-ink-3">
              {activity.finished.toolCalls ?? activity.steps.length} 次工具调用
              {typeof activity.finished.durationMs === "number" ? ` · ${(activity.finished.durationMs / 1000).toFixed(1)}s` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** per-block 悬停工具条（Codex 基准 ①）：每种内容块（markdown 正文/纯文本）
 *  悬停浮出「复制」胶囊，复制全文带 ✓ 反馈。参考 demos/lectern-ui-codex-baseline.html。 */
function TextBlock({ text, children }: { text: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };
  return (
    <div className="group relative">
      {children}
      <div className="absolute -top-2.5 right-1 z-10 hidden items-center gap-0.5 rounded-md border border-line bg-bg py-0.5 pl-0.5 pr-1 shadow-sm group-hover:flex">
        <button
          type="button"
          onClick={copy}
          title="复制全文"
          className={cn(
            "flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[0.625rem] transition-colors",
            copied ? "text-success" : "text-ink-3 hover:bg-surface-2 hover:text-ink",
          )}
        >
          {copied ? (
            "✓ 已复制"
          ) : (
            <>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
                <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" strokeLinecap="round" />
              </svg>
              复制
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function PartView({ part, diff, markdown = false, onOpenFile, subagent }: { part: Part; diff?: string; markdown?: boolean; onOpenFile?: (path: string, line?: number) => void; subagent?: SubagentActivity }) {
  switch (part.type) {
    case "text":
      // assistant 正文用 Markdown（流式稳定、代码高亮）；用户消息保持纯文本。
      // 两种形态都包 per-block 悬停工具条（复制全文）。
      return markdown ? (
        <TextBlock text={part.text}>
          <div className="text-[0.875rem] leading-[1.65] text-ink">
            <Markdown text={part.text} />
          </div>
        </TextBlock>
      ) : (
        <TextBlock text={part.text}>
          <div className="whitespace-pre-wrap text-[0.875rem] leading-[1.65] text-ink">{part.text}</div>
        </TextBlock>
      );
    case "reasoning":
      return <Reasoning text={part.text} />;
    case "tool": {
      // edit/write 且拿到 file.edited 的 diff → 渲染内联 diff 卡片（替代 ToolCard）
      if (diff && (part.tool === "edit" || part.tool === "write")) {
        const path = (part.state.input as { path?: string } | undefined)?.path ?? "";
        return <EditDiffCard path={path} diff={diff} onOpenFile={onOpenFile} />;
      }
      // 入口截流（R2）：输出超限被截断且全文已落盘 → 提示条点击跳文件 tab 看全文
      const meta = part.state.status === "completed" ? part.state.metadata : undefined;
      if (meta?.truncated && typeof meta.outputPath === "string") {
        return (
          <div className="space-y-1">
            <ToolCard call={{ id: part.callId, tool: part.tool, state: part.state }} sessionIdle={false} />
            <button
              type="button"
              onClick={() => onOpenFile?.(meta.outputPath as string)}
              className="text-[0.6875rem] text-warning transition-colors hover:underline"
            >
              输出已截流{typeof meta.omittedBytes === "number" ? `（省略 ${Math.round((meta.omittedBytes as number) / 1024)}KB）` : ""}，点击在文件页查看全文 →
            </button>
          </div>
        );
      }
      return (
        <ToolCard call={{ id: part.callId, tool: part.tool, state: part.state }} sessionIdle={false} />
      );
    }
    case "subtask": {
      return <SubtaskCard part={part} activity={subagent} />;
    }
    case "file":
      return <div className="text-xs text-ink-2">产物文件：{part.filename}</div>;
    case "image":
      // 多模态图片输入（P2-11）：用户随消息上传的图片直接内联展示
      return part.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={part.url} alt="附件图片" className="max-h-64 rounded-lg border border-line" />
      ) : (
        <div className="text-xs text-ink-2">产物图片</div>
      );
    case "compaction":
      return <div className="text-xs text-ink-2">上下文已压缩：{part.summary}</div>;
    default:
      return null;
  }
}

type Props = {
  /** 已投影的渲染数据（page.tsx 的 ChatProjector 增量产出，rAF 批量快照）。 */
  data: ChatViewData;
  status: string;
  pending: PermissionRequest | null;
  sessionId: string | null;
  /**
   * SSE 连接状态（断线自动重连；reconnecting/offline 时出横幅）。
   * 注意：连接态 pill 已随「对话」头部条一并并入任务上下文条（visual spec §4.2），
   * 由 page.tsx 通过 TaskBarActions 渲染，此处只保留横幅用途。
   */
  connState: ConnectionState;
  selectedModel: ModelRef | null;
  onSelectModel: (m: ModelRef | null) => void;
  onSend: (t: string) => void;
  onReply: (r: "once" | "always" | "reject", feedback?: string) => void;
  /** 续跑：中断后带断点上下文（已完成步骤/改过文件/最后一步/错误摘要）继续，
   *  而非裸发「继续」二字——让模型真正接上断点。 */
  onContinue: (ctx: string) => void;
  /** N6 卡住检测：运行中超过阈值无新事件（可能卡在长工具调用/上游无响应）。 */
  stalled?: boolean;
  onAbort: () => void;
  /** 点击消息内的文件路径（可带行号）→ 产物侧文件 Tab 打开并滚动定位（P1-10/F2 联动）。 */
  onOpenFile: (path: string, line?: number) => void;
  /** 历史分页：还有更早消息 + 触顶时回调（page.tsx 分页拉取并 prepend）。 */
  hasMore: boolean;
  onLoadMore: () => void;
  /** 乐观回显：发送瞬间的用户消息（真实 message.updated 到达后自动让位）。 */
  echo: { text: string; images: { url: string; mediaType: string }[]; skill?: { id: string; name: string }; references?: string[] } | null;
  /** 隔离操作结果横幅（page.tsx 持有，8s 自动消退）。 */
  wtNotice?: { kind: "ok" | "error"; text: string } | null;
  /** 回溯重发：编辑某条用户消息并从此重跑（page.tsx 调 API，截断 + 重跑由服务端完成）。 */
  onRewind: (messageId: string, text: string) => void;
};

/** 任务计划卡：todo.updated 投影（Agent 拆解步骤的实时进度）。 */
function TodoCard({ todos }: { todos: TodoItem[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  const icon = (status: TodoItem["status"]) => {
    if (status === "completed")
      return <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-success text-[8px] font-bold text-bg">✓</span>;
    if (status === "in_progress")
      return <span className="h-3.5 w-3.5 animate-pulse rounded-full border-2 border-live" />;
    if (status === "cancelled")
      return <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-surface-2 text-[8px] text-ink-3">—</span>;
    return <span className="h-3.5 w-3.5 rounded-full border border-ink-3" />;
  };
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[0.6875rem] font-semibold tracking-wide text-ink-3">任务计划</span>
        <span className="font-mono text-[0.625rem] text-ink-3">{done}/{todos.length}</span>
        <span className="h-1 flex-1 overflow-hidden rounded-pill bg-surface-2">
          <span
            className="block h-full rounded-pill bg-live transition-all"
            style={{ width: `${todos.length ? Math.round((done / todos.length) * 100) : 0}%` }}
          />
        </span>
      </div>
      <div className="space-y-1.5">
        {todos.map((t, i) => (
          <div key={i} className="flex items-center gap-2">
            {icon(t.status)}
            <span
              className={cn(
                "text-xs leading-5",
                t.status === "completed" ? "text-ink-3 line-through" : t.status === "in_progress" ? "font-medium text-ink" : "text-ink-2",
              )}
            >
              {t.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 运行中实时进度条（N6）：任务跑着时，用户眼前不再只有一个点在闪，
 *  而是「正在执行第 N 步 · 当前工具」的明确进展。数据全在投影快照里——
 *  todos 的 in_progress 项 + 消息里最后一个 running 工具，纯前端拼装。 */
function LiveProgressBar({ todos, currentTool }: { todos: TodoItem[]; currentTool: string | null }) {
  const done = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const current = todos.find((t) => t.status === "in_progress")?.content;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-live/30 bg-live/5 px-3 py-2">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <span className="h-2 w-2 animate-pulse rounded-full bg-live" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[0.6875rem] leading-5">
          <span className="shrink-0 font-medium text-ink">
            {total > 0 ? `正在执行第 ${Math.min(done + 1, total)}/${total} 步` : "正在执行"}
          </span>
          {currentTool && (
            <span className="truncate font-mono text-[0.625rem] text-ink-2" title={currentTool}>
              {currentTool}
            </span>
          )}
          {current && <span className="truncate text-ink-3" title={current}>· {current}</span>}
        </div>
        {total > 0 && (
          <div className="mt-1 h-1 overflow-hidden rounded-pill bg-surface-2">
            <span className="block h-full rounded-pill bg-live transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      {total > 0 && <span className="shrink-0 font-mono text-[0.625rem] text-ink-3">{pct}%</span>}
    </div>
  );
}

/** 任务终态小结卡（N5）：run 收尾的 AI 一句总结 + 结构化统计。
 *  让「一个 call tool 结束」有了明确收尾——完成/中断/失败三种终态都有落点。
 *  N6：总结里的「下一步建议」从文字升级为可执行——点击按钮直接续跑；
 *      并附「执行轨迹」可展开时间线（这轮跑了哪些工具、各花多久）。 */
type TimelineItem = { tool: string; title?: string; status: string; durationMs: number | null };

function SummaryCard({ summary, onFollowUp, timeline }: { summary: SessionSummary; onFollowUp?: () => void; timeline?: TimelineItem[] }) {
  const kind = summary.kind;
  const label = kind === "completed" ? "任务完成" : kind === "aborted" ? "任务中断" : "任务失败";
  const dot = kind === "completed" ? "bg-success" : kind === "aborted" ? "bg-warning" : "bg-danger";
  const meta = summary.meta;
  const parts: string[] = [];
  if (meta) {
    if (meta.filesEdited > 0) parts.push(`改动 ${meta.filesEdited} 个文件`);
    parts.push(`${meta.toolCalls} 次工具调用`);
    if (meta.durationMs > 0) parts.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
  }
  const [showTimeline, setShowTimeline] = useState(false);
  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="text-[0.6875rem] font-semibold tracking-wide text-ink-2">{label}</span>
        <span className="flex-1" />
        {parts.length > 0 && <span className="font-mono text-[0.625rem] text-ink-3">{parts.join(" · ")}</span>}
      </div>
      <div className="px-3 py-2.5 text-[0.8125rem] leading-[1.6] text-ink">{summary.text}</div>
      {(kind === "completed" && onFollowUp) || (timeline && timeline.length > 0) ? (
        <div className="flex items-center gap-1 border-t border-line px-3 py-1.5">
          {kind === "completed" && onFollowUp && (
            <button
              type="button"
              onClick={onFollowUp}
              title="基于这条总结，继续完成建议的下一步"
              className="rounded-pill border border-line bg-surface px-3 py-1 text-[0.6875rem] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
            >
              继续下一步 →
            </button>
          )}
          {timeline && timeline.length > 0 && (
            <button
              type="button"
              onClick={() => setShowTimeline((v) => !v)}
              className="inline-flex items-center gap-1 rounded-pill px-2 py-1 text-[0.6875rem] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            >
              执行轨迹
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={cn("transition-transform", showTimeline && "rotate-180")}>
                <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      ) : null}
      {showTimeline && timeline && timeline.length > 0 && (
        <div className="space-y-0.5 border-t border-line px-3 py-2">
          {timeline.map((t, i) => (
            <div key={i} className="flex items-center gap-2 font-mono text-[0.625rem] leading-5">
              <span className={cn("h-1 w-1 shrink-0 rounded-full", t.status === "error" ? "bg-danger" : t.status === "running" ? "bg-live" : "bg-success")} />
              <span className="shrink-0 text-ink-2">{t.tool}</span>
              {t.title && <span className="min-w-0 truncate text-ink-3" title={t.title}>{t.title}</span>}
              {typeof t.durationMs === "number" && <span className="ml-auto shrink-0 text-ink-3">{(t.durationMs / 1000).toFixed(1)}s</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 产物卡片：一次可交付文件（HTML/截图/数据文件等）。轻量一行——图标（按
 *  contentType 选）、mono 路径、人类可读大小、「打开」按钮（本地走 shell.openPath，
 *  远端/预览走 window.open）。只展示本轮 run 的产物，不跨轮累积。 */
function ArtifactCard({ artifact, onOpenFile }: { artifact: Artifact; onOpenFile?: (path: string) => void }) {
  const { path, bytes, contentType, downloadUrl, previewUrl } = artifact;
  const base = path.split("/").pop() ?? path;
  const isImage = contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(base);
  const isHtml = contentType.includes("html") || /\.html?$/i.test(base);
  const icon = isImage ? "🖼" : isHtml ? "🌐" : contentType.startsWith("video/") ? "🎬" : "📄";
  const human = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
  const open = () => {
    const url = previewUrl || downloadUrl;
    // 本地工作区产物：交给文件 Tab 打开（路径联动）；远端/预览：新窗口打开
    if (onOpenFile && !url.startsWith("http")) onOpenFile(path);
    else if (url) window.open(url, "_blank", "noopener");
  };
  return (
    <button
      type="button"
      onClick={open}
      className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-accent/40 hover:bg-surface-2"
      title={`${path} · 点击打开`}
    >
      <span className="text-[0.9375rem] leading-none">{icon}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-ink-2" title={path}>{base}</span>
      <span className="shrink-0 font-mono text-[0.625rem] text-ink-3">{human}</span>
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 text-ink-3">
        <path d="M6 3h6M6 7h6M6 11h4M3.5 3h.01M3.5 7h.01M3.5 11h.01" strokeLinecap="round" />
      </svg>
    </button>
  );
}

export default function ChatView({ data, status, pending, sessionId, connState, selectedModel, onSelectModel, onSend, onReply, onContinue, stalled, onAbort, onOpenFile, hasMore, onLoadMore, echo, wtNotice, onRewind }: Props) {
  const { messages, todos, reads, summary, summaryArtifacts, editedPaths, checkpoint } = data;
  // 乐观回显：runLoop 首事件前有装配开销（workspace agents/记忆/历史重建），
  // 用户气泡不等 SSE，发送瞬间就显示；真实同文本 user 消息到达后不重复追加
  const visible = useMemo(() => {
    if (!echo) return messages;
    const echoed = messages.find(
      (m) => m.role === "user" && m.parts.map((p) => (p.part.type === "text" ? p.part.text : "")).join("") === echo.text,
    );
    // SSE 的真实消息抵达会取代乐观回显。若旧 runner / 短暂版本切换未带回
    // skill 元数据，把本次发送时已知的选择合并进去，避免 skill 前缀闪现后消失。
    if (echoed) {
      const fallbackSkill = echo.skill;
      if (!fallbackSkill || echoed.skill) return messages;
      return messages.map((message) => message.id === echoed.id ? { ...message, skill: { ...fallbackSkill, digest: "" } } : message);
    }
    const echoMessage: UiMessage = {
      id: "__echo__",
      role: "user",
      ...(echo.skill ? { skill: { ...echo.skill, digest: "" } } : {}),
      ...(echo.references?.length ? { references: echo.references } : {}),
      parts: [
        ...echo.images.map((im, i) => ({ part: { id: `__echo_img_${i}`, type: "image", url: im.url, mediaType: im.mediaType, messageId: "__echo__", sessionId: "" } as Part })),
        ...(echo.text ? [{ part: { id: "__echo_text", type: "text", text: echo.text, messageId: "__echo__", sessionId: "" } as Part }] : []),
      ],
    };
    return [...messages, echoMessage];
  }, [messages, echo]);
  const running = status === "running";
  // N6 实时进度：运行中当前工具 = 所有消息里最后一个 status==="running" 的 tool。
  // 从投影快照反向找（不额外订阅），rAF 批量渲染已保证实时性足够。
  const currentTool = useMemo(() => {
    if (!running) return null;
    for (let i = visible.length - 1; i >= 0; i--) {
      const m = visible[i]!;
      for (let j = m.parts.length - 1; j >= 0; j--) {
        const p = m.parts[j]!.part;
        if (p.type === "tool" && p.state.status === "running") return p.tool;
      }
    }
    return null;
  }, [visible, running]);
  // 续跑断点上下文：从中断前的已投影数据拼出「进行到哪」的显式描述，
  // 让「继续」不再裸发二字——模型能明确知道自己已做/未做的部分。
  const buildContinueContext = useMemo(() => {
    return (m: UiMessage): string => {
      const done = todos?.filter((t) => t.status === "completed").length ?? 0;
      const total = todos?.length ?? 0;
      const toolParts = m.parts.map((p) => p.part).filter((p): p is Extract<Part, { type: "tool" }> => p.type === "tool");
      const lastTool = toolParts[toolParts.length - 1]?.tool;
      const errName = m.error?.name ?? "";
      const errMsg = m.error?.message ?? "";
      const lines: string[] = ["（续跑提示：上一次任务中断了，请接着完成，不要从头重做。）"];
      if (total > 0) lines.push(`- 已完成的步骤：${done}/${total}`);
      if (lastTool) lines.push(`- 中断前最后一步工具调用：${lastTool}`);
      if (editedPaths.length > 0) lines.push(`- 已经改动过的文件：${editedPaths.slice(0, 5).join("、")}${editedPaths.length > 5 ? ` 等 ${editedPaths.length} 个` : ""}`);
      if (errName) lines.push(`- 中断原因：${errName}${errMsg ? `（${errMsg}）` : ""}`);
      lines.push("请基于以上进度继续，直接开始未完成的部分。");
      return lines.join("\n");
    };
  }, [todos, editedPaths]);
  // 断线时长：从进入非 connected 状态开始计时，恢复即清零（横幅展示「已断 Xs」）
  const [downSince, setDownSince] = useState<number | null>(null);
  const [downSeconds, setDownSeconds] = useState(0);
  useEffect(() => {
    if (connState === "connected") {
      setDownSince(null);
      setDownSeconds(0);
      return;
    }
    setDownSince((prev) => prev ?? Date.now());
  }, [connState]);
  useEffect(() => {
    if (downSince == null) return;
    const t = setInterval(() => setDownSeconds(Math.round((Date.now() - downSince) / 1000)), 1000);
    return () => clearInterval(t);
  }, [downSince]);
  // Whisper 状态行（Codex 基准 ②）：系统事件在 Composer 上方一行灰字呈现，
  // 两侧细线夹注，4.2s 自动消退——不打断阅读流，替代 toast 式提示。
  const [whisper, setWhisper] = useState<string | null>(null);
  const whisperTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showWhisper = (text: string) => {
    setWhisper(text);
    if (whisperTimer.current) clearTimeout(whisperTimer.current);
    whisperTimer.current = setTimeout(() => setWhisper(null), 4200);
  };
  // run 状态迁移 → whisper：开始装配 / 收尾小结（完成带统计）
  const prevRunning = useRef(false);
  useEffect(() => {
    if (!prevRunning.current && running) showWhisper("已发送 · 正在装配上下文");
    if (prevRunning.current && !running && summary) {
      const parts: string[] = [];
      if (summary.meta && summary.meta.toolCalls > 0) parts.push(`${summary.meta.toolCalls} 次工具调用`);
      if (summary.meta && summary.meta.durationMs > 0) parts.push(`${(summary.meta.durationMs / 1000).toFixed(1)}s`);
      showWhisper(parts.length > 0 ? `任务完成 · ${parts.join(" · ")}` : "任务完成");
    }
    prevRunning.current = running;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, summary]);
  // compaction 到达 → whisper（压缩卡本身仍在消息流里留痕）
  const compactionCount = useMemo(
    () => messages.reduce((n, m) => n + m.parts.filter((p) => p.part.type === "compaction").length, 0),
    [messages],
  );
  const prevCompaction = useRef(compactionCount);
  useEffect(() => {
    if (compactionCount > prevCompaction.current) showWhisper("上下文已压缩 · 历史摘要已注入");
    prevCompaction.current = compactionCount;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compactionCount]);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  // 用户消息「编辑重发」原位编辑态：气泡变 textarea，保存即截断重跑
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  // 保存编辑：确认后交 page.tsx 调 rewind API（服务端截断 + 重跑）
  const saveEdit = () => {
    if (!editing) return;
    const next = editing.text.trim();
    if (!next) {
      setEditing(null); // 清空文本 = 放弃编辑
      return;
    }
    if (!window.confirm("保存并从此消息重新执行？此消息之后的全部消息将被删除。")) return;
    setEditing(null);
    onRewind(editing.id, next);
  };
  // 历史翻页的视口锚定：prepend 后恢复滚动位置；平时新消息到达滚到底部
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const handleLoadMore = () => {
    const el = messagesRef.current;
    if (el) anchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    onLoadMore();
  };
  // 新消息/片段到达时自动滚到底（流式输出的基本体验）；触顶加载更早时锚定原视口
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    if (anchorRef.current) {
      const a = anchorRef.current;
      el.scrollTop = el.scrollHeight - a.height + a.top;
      anchorRef.current = null;
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, pending]);
  return (
    <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-bg">
      {/* 消息区与 Composer 是两个明确的 grid row：上面只能在自身内部滚动，
          下面的 Composer 因此不可能越过 Debug Area。 */}
      <div className="flex min-h-0 flex-col">
      {/* 头部条已移除：「对话 / 空闲 / 自动」等控件按 visual spec §4.2 并入任务
          上下文条（TaskContextStrip，由 page.tsx 渲染在对话区顶部）。此处直接进
          入横幅与消息流，不再有第二根 36px 条。 */}
      {/* 断线横幅：reconnecting 提示自动恢复；offline 提示手动刷新（重连仍在后台退避重试） */}
      {connState !== "connected" && (
        <div
          className={cn(
            "flex h-7 shrink-0 items-center gap-2 border-b px-4 text-[0.6875rem]",
            connState === "offline" ? "border-danger/30 bg-danger-tint text-danger" : "border-line bg-warning-tint text-warning",
          )}
        >
          {connState === "offline"
            ? `连接已断开（${downSeconds}s）——正在后台重试，也可点击会话列表重建连接`
            : `连接中断，正在恢复…（已断 ${downSeconds}s，恢复后自动补齐缺失消息）`}
        </div>
      )}
      {/* N6 卡住检测横幅：运行中超过 60s 无新事件，可能卡在长工具调用/上游无响应。
          给用户主动感知，可中止；framework 看门狗 300s 会兜底报错。 */}
      {stalled && running && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-warning/30 bg-warning-tint px-4 text-[0.6875rem] text-warning">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-warning" />
          已超过 60s 无新进展，可能卡在长任务或上游无响应——可等待，或
          <button type="button" onClick={onAbort} className="font-medium underline underline-offset-2 hover:text-ink">
            中止
          </button>
        </div>
      )}
      {/* 隔离副本操作结果横幅（合并成功 / 冲突引导 / 丢弃确认） */}
      {wtNotice && (
        <div
          className={cn(
            "flex h-7 shrink-0 items-center gap-2 border-b px-4 text-[0.6875rem]",
            wtNotice.kind === "ok" ? "border-line bg-success-tint text-success" : "border-danger/30 bg-danger-tint text-danger",
          )}
        >
          <span className="truncate">{wtNotice.text}</span>
        </div>
      )}
      {/* 上下文读取 pill（P2-13）：本轮 Agent 读过的文件，点击联动打开 */}
      {reads.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-4 py-1.5">
          <span className="text-[0.625rem] text-ink-3">读过</span>
          {reads.map((path) => (
            <button
              key={path}
              type="button"
              onClick={() => onOpenFile(path)}
              title={`${path} · 点击在文件 Tab 打开`}
              className="max-w-44 truncate rounded-[3px] bg-surface-2 px-2 py-0.5 font-mono text-[0.625rem] text-ink-2 transition-colors hover:bg-line hover:text-ink"
            >
              {path}
            </button>
          ))}
        </div>
      )}
      <div
        className="messages mx-auto min-h-0 w-full max-w-3xl min-[1440px]:max-w-4xl min-[1920px]:max-w-5xl flex-1 space-y-7 overflow-y-auto px-6 py-6"
        ref={messagesRef}
        onScroll={(e) => {
          // 触顶自动加载更早历史（hasMore 且未在加载中——防抖在 page 层）
          const el = e.currentTarget;
          if (hasMore && el.scrollTop < 80) handleLoadMore();
        }}
        onClick={(e) => {
          // F2 路径联动：点击 Markdown 正文中的 code/a 元素，若文本像工作区内路径
          // 则打开文件 Tab；支持 path:line 形式（滚动定位到行）
          const el = (e.target as HTMLElement).closest("code, a");
          const raw = el?.textContent ?? "";
          const m = raw.trim().match(/^([.\w-]+(?:\/[.\w-]+)*\.[A-Za-z0-9]{1,6})(?::(\d{1,6}))?$/);
          if (m) {
            e.preventDefault();
            onOpenFile(m[1]!, m[2] ? Number(m[2]) : undefined);
          }
        }}
      >
      {/* 「加载更早」提示：触顶自动触发，仅作状态提示 */}
      {hasMore && (
        <div className="py-2 text-center text-[0.6875rem] text-ink-3">上滑加载更早消息…</div>
      )}
      {todos && todos.length > 0 && <TodoCard todos={todos} />}
      {/* N6 实时进度：运行中展示「正在执行第 N 步 · 当前工具」，取代单一状态点 */}
      {running && visible.length > 0 && <LiveProgressBar todos={todos ?? []} currentTool={currentTool} />}
        {visible.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="text-ink-3" aria-hidden>
              <path d="M8 1.8v3.1M8 11.1v3.1M1.8 8h3.1M11.1 8h3.1" strokeLinecap="round" />
              <path d="M8 4.9A3.1 3.1 0 1 0 8 11.1 3.1 3.1 0 0 0 8 4.9z" />
            </svg>
            <div className="text-[0.9375rem] font-semibold text-ink">开始一个任务</div>
            <div className="max-w-md text-xs leading-5 text-ink-3">
              描述你想交付的结果。Agent 会在当前项目中执行，变更、审查和成果会留在这项任务里。
            </div>
          </div>
        )}
        {visible.map((m, idx) => {
          const isAssistant = m.role === "assistant";
          const lastActive = isAssistant && idx === visible.length - 1 && running;
          if (!isAssistant) {
            // IDE 式用户消息：右侧浅色圆角气泡（含图片附件内联展示） + hover 操作（复制/编辑重发）
            const text = m.parts
              .map((p) => (p.part.type === "text" ? p.part.text : ""))
              .join("");
            const imageParts = m.parts.filter((p) => p.part.type === "image" && p.part.url);
            if (editing?.id === m.id) {
              // 原位编辑态：气泡变 textarea，保存即回溯重跑（服务端截断该消息之后的历史）
              return (
                <div key={m.id} className="flex justify-end">
                  <div className="w-[85%]">
                    <textarea
                      autoFocus
                      value={editing.text}
                      onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                      onKeyDown={(e) => {
                        // Cmd/Ctrl+Enter 保存；Escape 取消
                        if (e.key === "Escape") setEditing(null);
                        else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEdit();
                      }}
                      rows={Math.min(12, Math.max(2, editing.text.split("\n").length))}
                      className="w-full resize-y rounded-lg border border-accent bg-surface px-3 py-2 text-[0.875rem] leading-[1.65] text-ink outline-none"
                    />
                    <div className="mt-1.5 flex justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="rounded-md px-2.5 py-1 text-xs text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={saveEdit}
                        className="rounded-md bg-accent px-2.5 py-1 text-xs text-accent-ink transition-opacity hover:opacity-90"
                      >
                        保存并重跑
                      </button>
                    </div>
                  </div>
                </div>
              );
            }
            return (
              <div key={m.id} className="group flex justify-end [content-visibility:auto] [contain-intrinsic-size:auto_120px]">
                <div className="relative max-w-[85%]">
                  <div className="whitespace-pre-wrap rounded-lg rounded-br-sm bg-surface-2 px-3.5 py-2.5 text-[0.875rem] leading-[1.65] text-ink">
                    {m.skill && (
                      <div className="mb-1.5 flex items-center gap-1.5 text-[0.8125rem] leading-5">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" className="shrink-0 text-accent">
                          <path d="m8 1.8 5 2.9v6.6l-5 2.9-5-2.9V4.7l5-2.9Z" /><path d="m3 4.7 5 2.9 5-2.9M8 7.6v6.6" />
                        </svg>
                        <span className="font-medium text-accent">{m.skill.name}</span>
                        <span className="text-ink">{text}</span>
                      </div>
                    )}
                    {m.references?.length ? <div className="mb-1.5 flex flex-wrap gap-1">{m.references.map((path) => <span key={path} className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-[0.625rem] text-ink-2">@{path}</span>)}</div> : null}
                    {imageParts.length > 0 && (
                      <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
                        {imageParts.map((p) =>
                          p.part.type === "image" ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img key={p.part.id} src={p.part.url} alt="附件图片" className="max-h-48 rounded-md border border-line" />
                          ) : null,
                        )}
                      </div>
                    )}
                    {!m.skill && text}
                  </div>
                  <div className="absolute -left-14 top-1 hidden items-center gap-0.5 group-hover:flex">
                    <button
                      type="button"
                      title="复制"
                      onClick={() => void navigator.clipboard.writeText(text)}
                      className="flex h-6 w-6 items-center justify-center rounded-sm text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                        <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
                        <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" strokeLinecap="round" />
                      </svg>
                    </button>
                    {!running && (
                      <button
                        type="button"
                        title="编辑重发（截断此消息之后的对话并重新执行）"
                        onClick={() => setEditing({ id: m.id, text })}
                        className="wb-iconbtn"
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                          <path d="M11.3 2.3a1.5 1.5 0 0 1 2.1 2.1L5 12.8l-3 .7.7-3 8.6-8.2z" strokeLinejoin="round" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          }
          // Agent 消息：全宽开放排版（主流惯例：无头像无标签，运行指示放内容尾部）
          // M3 + N5 步骤条：整条消息里「已完成的普通工具」统一收拢成一个可展开的
          // ToolGroup 步骤条（挂在非工具内容之后），不再被 text/reasoning 打断成多个
          // 小组——长工具链（几十次调用）也只占一行摘要，点开才看细节。运行中/失败/
          // 带 diff 的工具仍原位展示（它们需要即时反馈，不折叠）。
          const blocks: React.ReactNode[] = [];
          const doneTools: UiPart[] = [];
          for (const p of m.parts) {
            const plainDone = p.part.type === "tool" && p.part.state.status === "completed" && !p.diff && !p.subagent;
            if (plainDone) {
              doneTools.push(p);
              continue;
            }
            blocks.push(
              <PartView key={`${m.id}-part-${p.part.id}`} part={p.part} diff={p.diff} markdown onOpenFile={onOpenFile} subagent={p.subagent} />,
            );
          }
          if (doneTools.length > 0) {
            blocks.push(
              <ToolGroup
                key={`${m.id}-toolgrp`}
                calls={doneTools.map((p) => {
                  const t = p.part as Extract<Part, { type: "tool" }>;
                  return { id: t.callId, tool: t.tool, state: t.state };
                })}
                sessionIdle={false}
              />,
            );
          }
          return (
            <div key={m.id} className="space-y-2.5 [content-visibility:auto] [contain-intrinsic-size:auto_120px]">
              {blocks}
              {m.error && (
                <div className="rounded-sm border border-danger/40 bg-danger/5 px-3 py-2 text-xs leading-5 text-danger">
                  <div>上游请求失败（{m.error.name}）：{m.error.message}</div>
                  {/* N5 失败自动诊断：已知错误映射「原因 + 建议」，替代干巴巴的报错 */}
                  {(() => {
                    const d = diagnoseError(m.error.name, m.error.message);
                    if (!d) return null;
                    return (
                      <div className="mt-1.5 space-y-0.5 border-t border-danger/20 pt-1.5 text-[0.6875rem] leading-5">
                        <div className="text-ink-2"><span className="font-medium text-ink">可能原因：</span>{d.cause}</div>
                        <div className="text-ink-3"><span className="font-medium text-ink-2">建议：</span>{d.hint}</div>
                      </div>
                    );
                  })()}
                  {/* N5 断点显式化：中断时展示「已完成进度 + 最后一步」，让用户
                      一眼知道进行到哪、还剩什么，而非只有一条干巴巴的报错。 */}
                  {idx === visible.length - 1 && !running && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-danger/20 pt-1.5 text-[0.6875rem] text-ink-2">
                      {(() => {
                        const done = todos?.filter((t) => t.status === "completed").length ?? 0;
                        const total = todos?.length ?? 0;
                        const lastTool = m.parts
                          .map((p) => p.part)
                          .filter((p): p is Extract<Part, { type: "tool" }> => p.type === "tool")
                          .pop()?.tool;
                        return (
                          <>
                            {total > 0 && <span>已完成 {done}/{total} 个步骤</span>}
                            {lastTool && <span>最后一步：<span className="font-mono">{lastTool}</span></span>}
                            {/* N6 中途快照：长任务运行中落过 checkpoint，中断时展示「已执行 N 个工具 · 耗时」 */}
                            {checkpoint && (
                              <span>
                                已执行 <span className="font-mono">{checkpoint.toolCalls}</span> 个工具
                                {typeof checkpoint.elapsedMs === "number" ? ` · ${(checkpoint.elapsedMs / 1000).toFixed(0)}s` : ""}
                              </span>
                            )}
                            <span className="text-ink-3">点「继续」在同一会话续跑</span>
                          </>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
              {/* P1 一键继续：最后一条 assistant 消息带错误且会话已空闲 → 错误卡下方出「继续」chip。
                  续跑会带上断点上下文（进度/改过文件/最后一步/原因），模型能接上而非从头发散。 */}
              {m.error && isAssistant && idx === visible.length - 1 && !running && !pending && (
                <div className="pt-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      // N6 幂等提示：上次已改过文件，续跑可能重复操作 → 先确认
                      const ctx = buildContinueContext(m);
                      if (editedPaths.length > 0) {
                        if (window.confirm(`上次已改动 ${editedPaths.length} 个文件。继续会在这些改动基础上接着做，不会自动回滚。是否继续？`)) {
                          onContinue(ctx);
                        }
                      } else {
                        onContinue(ctx);
                      }
                    }}
                    title="带断点上下文在同一会话继续（进度、已改文件、最后一步）"
                    className="rounded-pill border border-line bg-surface px-3 py-1 text-[0.6875rem] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                  >
                    继续
                  </button>
                </div>
              )}
              {lastActive && (
                <div className="flex items-center gap-2 pt-0.5 text-[0.6875rem] text-live">
                  <span className="streaming-caret" />
                  正在工作…
                </div>
              )}
            </div>
          );
        })}
        {/* 任务终态小结（N5）：run 收尾的 AI 一句总结，挂在消息流末尾。
            只在非 running 时显示——running 时 summary 尚未生成（终态才发）。
            N6：总结卡带「继续下一步」按钮 + 可展开「执行轨迹」时间线。 */}
        {summary && !running && (
          <SummaryCard
            summary={summary}
            timeline={(() => {
              const items: TimelineItem[] = [];
              for (const m of messages) {
                for (const p of m.parts) {
                  if (p.part.type !== "tool") continue;
                  const st = p.part.state;
                  const start = "time" in st && st.time?.start ? Date.parse(st.time.start) : null;
                  const end = st.status === "completed" || st.status === "error" ? ("time" in st && st.time?.end ? Date.parse(st.time.end) : null) : null;
                  items.push({
                    tool: p.part.tool,
                    title: "title" in st && st.title ? st.title : undefined,
                    status: st.status,
                    durationMs: start && end ? end - start : null,
                  });
                }
              }
              return items;
            })()}
            onFollowUp={() =>
              onSend(`基于上面的任务总结，请继续完成你建议的下一步工作，直接开始执行。\n\n（上一轮总结：${summary.text}）`)
            }
          />
        )}
        {/* 本轮产物卡片：只展示 summary 对应的这一轮 run 的产物（summaryArtifacts），
            不跨轮累积。挂在 SummaryCard 下方，与「总结陈词」一起构成收尾区。 */}
        {summary && !running && summaryArtifacts.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-ink-3">
              <span>本轮产物</span>
              <span className="font-mono text-[0.625rem] text-ink-3">{summaryArtifacts.length}</span>
            </div>
            {summaryArtifacts.map((a) => (
              <ArtifactCard key={a.artifactId} artifact={a} onOpenFile={onOpenFile} />
            ))}
          </div>
        )}
        {pending && (
          <PermissionCard
            request={{ id: pending.id, permission: pending.permission, patterns: pending.patterns, metadata: pending.metadata }}
            onReply={(reply, feedback) => onReply(reply, feedback)}
          />
        )}
      </div>
      </div>
      {/* Whisper 状态行：无事件时保留占位高度，避免 Composer 跳动 */}
      <div className="flex h-7 shrink-0 items-center justify-center">
        {whisper && (
          <div className="flex items-center text-[0.6875rem] tracking-wide text-ink-3">
            <span className="h-px w-11 bg-line" />
            <span className="px-3">{whisper}</span>
            <span className="h-px w-11 bg-line" />
          </div>
        )}
      </div>
      <Composer
        sessionId={sessionId}
        running={running}
        selectedModel={selectedModel}
        onSelectModel={onSelectModel}
        onSend={onSend}
        onAbort={onAbort}
      />
    </div>
  );
}
