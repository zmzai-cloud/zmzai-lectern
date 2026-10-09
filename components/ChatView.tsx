import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useSessionReadState } from "@/lib/use-session-read-state";
import { Markdown, PermissionCard, Reasoning, ToolCard, cn } from "@zmzai/theme";
import { Icon } from "@zmzai/theme/components/icon";
import { toolGlyph, toolLabel } from "@zmzai/theme/components/tool-card";
import { TaskDeliveryCard, TaskProgressCard } from "./TaskStatus";
import type { TaskActionId, TaskPresentationView } from "@/lib/task-presentation";
import { ArrowDown, LoaderCircle, RotateCw, Search } from "lucide-react";

import type { ConnectionState } from "@/lib/client";
import { canvasKindOf } from "@/lib/canvas-kind";
import type { HistoryState } from "@/lib/session-history";
import type { PermissionMode } from "@/lib/permission-mode";
import type { ChatViewData, TodoItem } from "@/lib/chat-projector";
type SessionCheckpoint = import("@/lib/chat-projector").SessionCheckpoint;
import type { InputAttachmentRef, ModelRef, Part, PermissionRequest, SessionSummary, Artifact } from "@/lib/types";
import Composer, { type ComposerSendInput } from "./Composer";
import { MessageAttachmentCard } from "./AttachmentCards";
import DiffView, { diffStat } from "./DiffView";
import SessionMessageSearch from "./SessionMessageSearch";

type SubagentActivity = import("@/lib/chat-projector").SubagentActivity;
type UiPart = import("@/lib/chat-projector").UiPart;
type UiMessage = import("@/lib/chat-projector").UiMessage;

/** N5 失败自动诊断：把已知错误名/错误消息关键词映射成「可能原因 + 建议动作」，
 *  让错误卡不再只报干巴巴的 name+message，而是一眼能懂「为什么断、该怎么办」。 */
function diagnoseError(name: string, message: string): { cause: string; hint: string } | null {
  const n = (name || "").toLowerCase();
  const m = (message || "").toLowerCase();
  // 【建议文案不得指向已不存在的控件】这几条文案原来都写着「点『继续』」，
  // 而规格 3 §19 已经把那个按钮连同它背后的合成消息一起删掉了——留着这些
  // 提示，等于让用户去找一个不在那里的按钮。现在一律指向真实存在的通路：
  // 框架自己在同一任务里退避重试，或用户在输入框里补一句（§12 的 steering）。
  if (n.includes("streamidletimeout") || (m.includes("无响应") && m.includes("中止"))) {
    return { cause: "上游长时间无响应，模型可能卡住或不支持该输入（如非视觉模型收到图片）", hint: "换个模型或简化输入后重发；任务还没做完时框架会在同一任务里自己接着跑" };
  }
  if (n.includes("leaseexpired") || m.includes("服务重启")) {
    return { cause: "服务在运行期间重启，会话上下文已保留但本次运行被打断", hint: "任务会自动恢复，不必重做" };
  }
  if (/\b429\b/.test(m) || m.includes("rate limit") || m.includes("too many requests")) {
    return { cause: "触发上游限流（429），请求太频繁", hint: "稍等片刻，框架会在同一任务里退避重试" };
  }
  if (/\b50[234]\b/.test(m) || m.includes("bad gateway") || m.includes("service unavailable") || m.includes("internal server error")) {
    return { cause: "上游服务暂时不可用（5xx 网关/服务端错误）", hint: "稍后重试；若持续出现，检查模型服务状态" };
  }
  if (m.includes("timeout") || m.includes("etimedout") || m.includes("socket hang up") || m.includes("econnreset") || m.includes("terminated")) {
    return { cause: "网络连接中断或请求超时", hint: "检查网络；框架会在同一任务里退避重试，弱网下可缩短任务" };
  }
  if (n.includes("aborted") || m.includes("已取消") || m.includes("cancelled")) {
    return { cause: "任务被手动中止", hint: "需要继续时，在下方输入框里补一句说明即可" };
  }
  return null;
}

/** 内联 diff 卡片：edit/write 工具调用落盘后的变更预览（写入已即时生效）。
 *  标题行带「在文件 Tab 打开」（F3 联动）。 */
function EditDiffCard({ path, diff, onOpenFile }: { path: string; diff: string; onOpenFile?: (path: string, line?: number) => void }) {
  const [open, setOpen] = useState(false);
  const { additions, deletions } = diffStat(diff);
  return (
    <div className="overflow-hidden rounded-lg bg-surface-2/60 transition-colors hover:bg-surface-2">
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

/** 子任务折叠行（ZCode/Codex 式）：子代理调用是一行弱化过程行——
 *  `[users 图标] 子任务 · {agent} · {描述}`，运行中图标呼吸，完成后行尾带统计，
 *  失败整行红 + 「失败」标记；展开看任务全文 + 子代理步骤流（每个子工具一行，
 *  视觉与工具行同语言）+ 收尾统计。活动数据来自 subagent.started/step/finished
 *  事件投影（framework 桥接自子 runner）。 */
function SubtaskCard({ part, activity, onOpen }: { part: Extract<Part, { type: "subtask" }>; activity?: SubagentActivity; onOpen?: (child: { sessionId: string; agent: string; description: string }) => void }) {
  const [open, setOpen] = useState(false);
  const finished = activity?.finished;
  const running = !finished;
  const failed = finished?.state === "error";
  const toolCalls = finished?.toolCalls ?? activity?.steps.length ?? 0;
  const stat = finished
    ? `${toolCalls} 次工具${typeof finished.durationMs === "number" ? ` · ${finished.durationMs < 60_000 ? `${(finished.durationMs / 1000).toFixed(0)}s` : `${Math.floor(finished.durationMs / 60_000)} 分 ${Math.round((finished.durationMs % 60_000) / 1000)} 秒`}` : ""}`
    : "";
  return (
    <div className={cn("chat-subtask", open && "open", running && "running", failed && "failed")}>
      <button type="button" className="chat-subtask-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="users" size={13} strokeWidth={1.4} className="chat-subtask-icon" />
        <span className="shrink-0">子任务</span>
        <span className="chat-subtask-sep" aria-hidden>·</span>
        <span className="shrink-0">{part.agent}</span>
        <span className="chat-subtask-sep" aria-hidden>·</span>
        <span className="chat-subtask-desc" title={part.description}>{part.description}</span>
        {failed && <span className="chat-subtask-flag">失败</span>}
        {finished && !failed && stat && (
          <>
            <span className="chat-subtask-sep" aria-hidden>·</span>
            <span className="shrink-0">{stat}</span>
          </>
        )}
        {onOpen && (
          <span
            role="button"
            tabIndex={0}
            title="在右侧「子代理」页打开该子代理的完整对话"
            onClick={(e) => { e.stopPropagation(); onOpen({ sessionId: part.childSessionId, agent: part.agent, description: part.description }); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onOpen({ sessionId: part.childSessionId, agent: part.agent, description: part.description }); } }}
            className="shrink-0 rounded-pill px-2 py-0.5 text-[0.625rem] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            打开
          </span>
        )}
        <svg
          width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
          className={cn("chat-subtask-chevron", open && "open")}
        >
          <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="chat-subtask-body-wrap" inert={!open}>
        <div className="chat-subtask-body">
          <div className="whitespace-pre-wrap text-[0.6875rem] leading-5 text-ink-3">{part.prompt}</div>
          {activity?.steps.map((step, i) => (
            <div key={i} className={cn("flex min-w-0 items-center gap-2 text-[0.6875rem]", step.state === "error" ? "text-danger" : "text-ink-3")}>
              <Icon name={toolGlyph(step.tool)} size={11} strokeWidth={1.4} className="shrink-0" />
              <span className="shrink-0">{toolLabel(step.tool)}</span>
              {step.title && (
                <>
                  <span className="chat-subtask-sep" aria-hidden>·</span>
                  <span className="min-w-0 flex-1 truncate" title={step.title}>{step.title}</span>
                </>
              )}
            </div>
          ))}
          {finished && stat && <div className="text-[0.625rem] text-ink-3">{stat}</div>}
        </div>
      </div>
    </div>
  );
}

/** 工作流程组（ZCode 式收起）：一轮运行结束后，该条消息的全部过程 parts
 *  （思考块 + 工具调用，含被正文隔开的）收进一个组——行是「⚙ 工作流程 ·
 *  N 个步骤 · 时长」，点击展开逐行过程（子行各自可再展开）。按相邻分段会把
 *  中断-恢复的长会话切成十几个小组，已按轮次合并。运行中的活跃消息不折叠
 *  （调用方逐行实时渲染）。 */
function WorkflowGroup({ parts, onOpenFile, onOpenChild }: { parts: UiPart[]; onOpenFile: (path: string, line?: number) => void; onOpenChild?: (child: { sessionId: string; agent: string; description: string }) => void }) {
  const [open, setOpen] = useState(false);
  const tools = parts.flatMap((p) => (p.part.type === "tool" ? [p.part] : []));
  // 失败计数含失败子代理（ZCode 式：收起态就能看到这轮有没有出过事）
  const failed = tools.filter((t) => t.state.status === "error").length
    + parts.filter((p) => p.part.type === "subtask" && p.subagent?.finished?.state === "error").length;
  // 组时长 = 工具时间戳的首尾跨度（思考块无时间戳，不参与；拿不到就不显示）
  const duration = useMemo(() => {
    let start = Infinity;
    let end = -Infinity;
    for (const t of tools) {
      const state = t.state;
      if (!("time" in state)) continue;
      const startMs = Date.parse(state.time.start);
      if (Number.isFinite(startMs)) start = Math.min(start, startMs);
      const endMs = "end" in state.time ? Date.parse(state.time.end) : Number.NaN;
      if (Number.isFinite(endMs)) end = Math.max(end, endMs);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    const ms = end - start;
    if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
    const m = Math.floor(s / 60);
    return `${m}m${Math.round(s % 60)}s`;
  }, [tools]);
  return (
    <div className={cn("chat-workflow-group", open && "open")}>
      <button type="button" className="chat-workflow-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="settings" size={13} strokeWidth={1.4} />
        <span>工作流程</span>
        <span className="chat-workflow-sep" aria-hidden>·</span>
        <span>{parts.length} 个步骤</span>
        {failed > 0 && (
          <>
            <span className="chat-workflow-sep" aria-hidden>·</span>
            <span className="chat-workflow-failed">{failed} 个失败</span>
          </>
        )}
        {duration && (
          <>
            <span className="chat-workflow-sep" aria-hidden>·</span>
            <span>{duration}</span>
          </>
        )}
        <svg
          width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
          className={cn("chat-workflow-chevron", open && "open")}
        >
          <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {/* 展开动画走 CSS grid 0fr→1fr（globals.css），与 theme 工具行/思考行的
          framer 高度动画同参数（0.2s + 同一缓动），三种展开一个手感。
          内容常驻 DOM（收起时 0fr + inert），动画因此可逆且可访问性正确。 */}
      <div className="chat-workflow-body-wrap" inert={!open}>
        <div className="chat-workflow-body">
          {parts.map((p) => (
            <PartView key={p.part.id} part={p.part} diff={p.diff} markdown onOpenFile={onOpenFile} subagent={p.subagent} onOpenChild={onOpenChild} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** 运行中断折叠行（ZCode 式弱化）：错误不再摊开成一大块红框——收起是一行
 *  「✗ 运行中断 · 一句话原因」（danger 色，与失败工具行同层级），展开才看
 *  原始错误 / 可能原因 / 建议 / 断点统计。历史里的旧错误同样是安静的折叠行，
 *  不再像一堆待处理的作业。该做什么由诊断建议与任务卡按钮直接表达。 */
function ErrorCard({ error, isTail, todos, checkpoint, lastTool }: {
  error: { name: string; message: string };
  /** 断点统计只在「最后一条消息 + 空闲」时展示（同旧逻辑）：历史错误不重复报进度。 */
  isTail: boolean;
  todos: TodoItem[] | null;
  checkpoint: SessionCheckpoint | null;
  lastTool: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const d = diagnoseError(error.name, error.message);
  const brief = d?.cause ?? error.message.replace(/\s+/g, " ").trim();
  const done = todos?.filter((t) => t.status === "completed").length ?? 0;
  const total = todos?.length ?? 0;
  return (
    <div className={cn("chat-error-card", open && "open")}>
      <button type="button" className="chat-error-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="cross" size={13} strokeWidth={1.4} />
        <span className="shrink-0">运行中断</span>
        <span className="chat-workflow-sep" aria-hidden>·</span>
        <span className="chat-error-brief" title={`${error.name}: ${error.message}`}>{brief}</span>
        <svg
          width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
          className={cn("chat-error-chevron", open && "open")}
        >
          <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="chat-error-body-wrap" inert={!open}>
        <div className="chat-error-body">
          <div className="break-all font-mono text-[0.6875rem] leading-5 text-ink-3">{error.name}: {error.message}</div>
          {d && (
            <div className="space-y-0.5 text-[0.6875rem] leading-5">
              <div className="text-ink-2"><span className="font-medium text-ink">可能原因：</span>{d.cause}</div>
              <div className="text-ink-3"><span className="font-medium text-ink-2">建议：</span>{d.hint}</div>
            </div>
          )}
          {isTail && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.6875rem] text-ink-3">
              {total > 0 && <span>已完成 {done}/{total} 个步骤</span>}
              {lastTool && <span>最后一步：<span className="font-mono">{lastTool}</span></span>}
              {checkpoint && (
                <span>
                  已执行 <span className="font-mono">{checkpoint.toolCalls}</span> 个工具
                  {typeof checkpoint.elapsedMs === "number" ? ` · ${(checkpoint.elapsedMs / 1000).toFixed(0)}s` : ""}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
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
    <div className="group relative chat-text-block">
      {children}
      <div className="chat-copy-actions flex items-center gap-0.5 pt-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
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

function MessageText({ text, markdown = false }: { text: string; markdown?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = text.length > 8000;
  const shown = collapsible && !expanded ? text.slice(0, 8000) : text;
  return <>
    {markdown ? <Markdown text={shown} /> : <span className="whitespace-pre-wrap">{shown}</span>}
    {collapsible && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="mt-2 block text-xs text-ink-3 underline">{expanded ? "收起正文" : "展开完整正文"}</button>}
  </>;
}

function PartView({ part, diff, markdown = false, onOpenFile, subagent, onOpenChild }: { part: Part; diff?: string; markdown?: boolean; onOpenFile?: (path: string, line?: number) => void; subagent?: SubagentActivity; onOpenChild?: (child: { sessionId: string; agent: string; description: string }) => void }) {
  switch (part.type) {
    case "text":
      // assistant 正文用 Markdown（流式稳定、代码高亮）；用户消息保持纯文本。
      // 两种形态都包 per-block 悬停工具条（复制全文）。
      return markdown ? (
        <TextBlock text={part.text}>
          <div className="text-[0.875rem] leading-[1.65] text-ink">
            <MessageText text={part.text} markdown />
          </div>
        </TextBlock>
      ) : (
        <TextBlock text={part.text}>
          <div className="whitespace-pre-wrap text-[0.875rem] leading-[1.65] text-ink"><MessageText text={part.text} /></div>
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
      return <SubtaskCard part={part} activity={subagent} onOpen={onOpenChild} />;
    }
    case "file":
      // 用户随消息发送的附件（规格 2 §12）：持久卡片，不是「产物文件」。
      return <MessageAttachmentCard part={part} />;
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
  onSend: (input: ComposerSendInput) => void;
  onReply: (r: "once" | "always" | "reject", feedback?: string) => void;
  /** 任务呈现模型（规格 3 §14）。**由 page.tsx 统一派生**：同一份状态要同时
   *  驱动这里、上下文条和会话列表，各自算一遍必然会漂移。 */
  taskView?: TaskPresentationView | null;
  /** 任务动作（授权并继续 / 补充信息 / 选择方案 / 检查后重试 / 停止任务）。
   *  具体做什么由 page.tsx 决定——滚动到授权卡、聚焦输入框、或调 resume。 */
  onTaskAction?: (action: TaskActionId) => void;
  /** N6 卡住检测：运行中超过阈值无新事件（可能卡在长工具调用/上游无响应）。 */
  stalled?: boolean;
  onAbort: () => void;
  /** 点击消息内的文件路径（可带行号）→ 产物侧文件 Tab 打开并滚动定位（P1-10/F2 联动）。 */
  onOpenFile: (path: string, line?: number) => void;
  /** 点击产物卡：画布渲染得了的产物（网页/PDF/图片）直接进「成果预览」。
   *  没有它时退回 `onOpenFile`（文件 Tab）。 */
  onOpenPreview?: (path: string) => void;
  onOpenArtifact?: () => void;
  /** 历史分页：还有更早消息 + 触顶时回调（page.tsx 分页拉取并 prepend）。 */
  historyState: HistoryState;
  onLoadMore: () => void;
  onLoadNewer: () => void;
  onLoadLatest: () => void;
  onReadingHistory: (reading: boolean) => void;
  /**
   * 乐观回显：发送瞬间的用户消息（真实 message.updated 到达后自动让位）。
   * `attachments` 与 `images` 是两种历史来源——图片是旧链路的内联 data URL，
   * 附件是新链路的描述符（只有 id 与元数据）。
   */
  echo: {
    text: string;
    images: { url: string; mediaType: string }[];
    skill?: { id: string; name: string };
    references?: string[];
    attachments?: InputAttachmentRef[];
    sessionId?: string;
  } | null;
  /** 隔离操作结果横幅（page.tsx 持有，8s 自动消退）。 */
  wtNotice?: { kind: "ok" | "error"; text: string } | null;
  /** 回溯重发：编辑某条用户消息并从此重跑（page.tsx 调 API，截断 + 重跑由服务端完成）。 */
  onRewind: (messageId: string, text: string) => void;
  /** 会话级权限模式（Codex 基准 ④）：Composer 常驻胶囊，点击循环。 */
  permissionMode?: PermissionMode;
  onCyclePermissionMode?: () => void;
  /** 发送被 RECOVERY_REQUIRED 挡下（上一任务外部副作用未确认）：输入区上方挂
   *  持久横幅，按钮一键放行任务——替代一句 4s 消失的死胡同提示。 */
  recoveryBlocked?: boolean;
  onResolveRecovery?: () => void;
  /** 点击子任务行的「打开」→ 右侧工作台「子代理」页显示该子会话的完整对话。 */
  onOpenChildSession?: (child: { sessionId: string; agent: string; description: string }) => void;
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
    <details className="chat-task-plan" open={todos.some((t) => t.status === "in_progress")}>
      <summary className="cursor-pointer text-xs text-ink-2">任务计划 · {done}/{todos.length} 已完成</summary>
      <div className="pt-3">
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
    </details>
  );
}


/** 本轮小结卡（N5）：**一次 Attempt 运行**收尾的 AI 一句总结 + 结构化统计。
 *
 *  【它现在说的是「本轮」而不是「任务」】旧实现把 `kind: "completed"` 渲染成
 *  「任务完成」，可它只证明这一轮模型正常结束了——剩余步骤还在时，这句话就是
 *  在骗用户（规格 §3.2）。所以：① 文案改成「本轮已结束」，任务级的完成判定
 *  交给 `TaskDeliveryCard`（只认 task.delivered）；② 通用「继续下一步」按钮
 *  连同它发出的合成用户消息一起删除（§14.2 / §19）——任务由框架自己接着跑，
 *  轮次之间不再需要用户做任何事。
 *
 *  默认折叠：一轮结束不再是需要用户注意的事件，它只是轨迹上的一条记录。 */
type TimelineItem = { tool: string; title?: string; status: string; durationMs: number | null };

function SummaryCard({ summary, timeline }: { summary: SessionSummary; timeline?: TimelineItem[] }) {
  const kind = summary.kind;
  const label = kind === "completed" ? "本轮已结束" : kind === "aborted" ? "本轮被中断" : "本轮出错";
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
    <details className="chat-task-summary" open={kind !== "completed"} data-attempt-summary>
      <summary className="cursor-pointer py-2 text-xs text-ink-2">{label}{parts.length ? ` · ${parts.join(" · ")}` : ""}</summary>
      <div>
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="text-[0.6875rem] font-semibold tracking-wide text-ink-2">{label}</span>
        <span className="flex-1" />
        {parts.length > 0 && <span className="font-mono text-[0.625rem] text-ink-3">{parts.join(" · ")}</span>}
      </div>
      <div className="px-3 py-2.5 text-[0.8125rem] leading-[1.6] text-ink">{summary.text}</div>
      {timeline && timeline.length > 0 ? (
        <div className="flex items-center gap-1 px-3 pb-2 pt-1">
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
    </details>
  );
}

/** 产物卡片：一次可交付文件（HTML/截图/PDF/数据文件等）。轻量一行——图标（按
 *  contentType 选）、mono 路径、人类可读大小、「打开」按钮。只展示本轮 run 的
 *  产物，不跨轮累积。
 *
 *  【点击落到哪】画布渲染得了的（网页/PDF/图片）→ 成果预览；其余的本地文件 →
 *  文件 Tab（那里对二进制给的是占位，不是把字节当源码摊出来）；远端 URL →
 *  新窗口。 */
function ArtifactCard({ artifact, onOpenFile, onOpenPreview }: { artifact: Artifact; onOpenFile?: (path: string) => void; onOpenPreview?: (path: string) => void }) {
  const { path, bytes, contentType, downloadUrl, previewUrl } = artifact;
  const base = path.split("/").pop() ?? path;
  const isImage = contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(base);
  const isHtml = contentType.includes("html") || /\.html?$/i.test(base);
  const isPdf = contentType === "application/pdf" || /\.pdf$/i.test(base);
  const icon = isImage ? "🖼" : isHtml ? "🌐" : isPdf ? "📕" : contentType.startsWith("video/") ? "🎬" : "📄";
  const human = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
  const open = () => {
    const url = previewUrl || downloadUrl;
    // 本地工作区产物：交给画布 / 文件 Tab（路径联动）；远端/预览：新窗口打开
    const local = !url.startsWith("http");
    if (local && onOpenPreview && canvasKindOf(path)) onOpenPreview(path);
    else if (local && onOpenFile) onOpenFile(path);
    else if (url) window.open(url, "_blank", "noopener");
  };
  return (
    <button
      type="button"
      onClick={open}
      className="flex w-full items-center gap-2.5 rounded-lg bg-surface-2/60 px-3 py-2 text-left transition-colors hover:bg-surface-2"
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

/** 状态行措辞：已知工具给自然动词短语，未知工具退回「正在使用 X」（toolLabel）。
 *  裸英文工具名（task/read）对用户没有语义——工具行首已是中文动词，状态行
 *  保持同一语言（用户反馈圈出「正在使用 task」）。 */
const TOOL_ACTIVITY_PHRASE: Record<string, string> = {
  read: "正在读取文件",
  glob: "正在查找文件",
  grep: "正在搜索代码",
  search: "正在检索",
  websearch: "正在联网检索",
  bash: "正在执行命令",
  terminal: "正在执行命令",
  edit: "正在编辑文件",
  write: "正在写入文件",
  webfetch: "正在抓取网页",
  web_fetch: "正在抓取网页",
  task: "正在执行子任务",
};

export default function ChatView({ data, status, pending, sessionId, connState, selectedModel, onSelectModel, onSend, onReply, taskView, onTaskAction, stalled, onAbort, onOpenFile, onOpenPreview, onOpenArtifact, historyState, onLoadMore, onLoadNewer, onLoadLatest, onReadingHistory, echo, wtNotice, onRewind, permissionMode, onCyclePermissionMode, recoveryBlocked, onResolveRecovery, onOpenChildSession }: Props) {
  const { messages, todos, reads, summary, summaryArtifacts, editedPaths, checkpoint, task, taskAttempts } = data;
  // 乐观回显：runLoop 首事件前有装配开销（workspace agents/记忆/历史重建），
  // 用户气泡不等 SSE，发送瞬间就显示；真实同文本 user 消息到达后不重复追加
  const visible = useMemo(() => {
    if (!echo) return messages;
    const echoIds = new Set((echo.attachments ?? []).map((ref) => ref.id));
    // 有附件时按 attachment id 对齐：file-only 消息的文本是空的，按文本匹配会撞上
    // 更早的无文本消息，把回显误判成「已到达」而整条消失（规格 §12）。
    const echoed = messages.find(
      (m) =>
        m.role === "user" &&
        (echoIds.size > 0
          ? m.parts.some((p) => p.part.type === "file" && p.part.attachmentId && echoIds.has(p.part.attachmentId))
          : Boolean(echo.text) && m.parts.map((p) => (p.part.type === "text" ? p.part.text : "")).join("") === echo.text),
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
        // 附件用描述符形状回显：卡片立刻可画（名字/大小/类型），摘要由卡片自己取。
        ...(echo.attachments ?? []).map((ref, i) => ({
          part: {
            id: `__echo_att_${i}`,
            type: "file",
            mime: ref.mediaType,
            filename: ref.name,
            attachmentId: ref.id,
            size: ref.size,
            kind: ref.kind,
            status: "ready",
            messageId: "__echo__",
            sessionId: echo.sessionId ?? "",
          } as Part,
        })),
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
  // 断线时长：从进入非 connected 状态开始计时，恢复即清零（横幅展示「已断 Xs」）
  const [downSince, setDownSince] = useState<number | null>(null);
  const [downSeconds, setDownSeconds] = useState(0);
  // 运行时长（Zcode 式单一状态行）：running 起拍计时、空闲清零。与 currentTool
  // 一起构成 Composer 上方唯一运行状态——消息尾部不再放第二份「正在工作」，
  // 两处状态各说各话只会让人疑惑（用户反馈）。
  const [runSeconds, setRunSeconds] = useState(0);
  useEffect(() => {
    if (!running) {
      setRunSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setRunSeconds(0);
    const timer = setInterval(() => setRunSeconds(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);
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
  const followTail = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const virtual = useVirtualizer({ count: visible.length, getScrollElement: () => messagesRef.current, estimateSize: () => 140,
    getItemKey: index => visible[index]!.id, overscan: 8, scrollMargin,
  });
  useLayoutEffect(() => {
    const list = listRef.current; const root = messagesRef.current;
    if (!list || !root) return;
    setScrollMargin(list.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop);
  }, [historyState, todos, visible.length]);
  const readState = useSessionReadState(sessionId, messagesRef, !searchOpen && !historyState.hasNewer && !historyState.loading && !historyState.error && connState === "connected",
    [...visible].reverse().find(message => message.error || message.parts.some(item => item.part.type !== "reasoning" && (item.part.type !== "text" || item.part.text.trim().length > 0)))?.messageSeq ?? 0, 0);
  // 未读分隔线锚定「进入会话那一刻」的快照：只标记进入前就存在的未读消息
  // （seq 落在 (进入时已读, 进入时最新] 区间）。之后流式产生的新消息是用户
  // 当场看着产生的，不算未读——按实时 lastRead 判定的话，已读提交（底部驻留
  // 判定 + 轮询往返）永远落后于新消息产生，盯着尾部看也会在眼前内容头上挂出
  // 「未读消息」线（用户反馈的困惑源）。渲染期幂等初始化 ref，切会话重锚。
  const unreadAnchor = useRef<{ lastRead: number; latest: number } | null>(null);
  useEffect(() => { unreadAnchor.current = null; }, [sessionId]);
  if (readState && !unreadAnchor.current) unreadAnchor.current = { lastRead: readState.lastReadMessageSeq, latest: readState.latestMessageSeq };
  const anchor = unreadAnchor.current;
  const firstUnreadId = anchor
    ? visible.find(message => message.role === "assistant" && (message.messageSeq ?? 0) > anchor.lastRead && (message.messageSeq ?? 0) <= anchor.latest && message.parts.some(item => item.part.type !== "reasoning"))?.id
    : undefined;
  useEffect(() => { onReadingHistory(searchOpen || showLatest || !!historyState.hasNewer); }, [searchOpen, showLatest, historyState.hasNewer, onReadingHistory]);
  useEffect(() => { followTail.current = true; setShowLatest(false); setSearchOpen(false); }, [sessionId]);
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
  const anchorRef = useRef<{ id: string; offset: number } | null>(null);
  useEffect(() => { anchorRef.current = null; }, [sessionId]);
  useEffect(() => {
    if (historyState.error) anchorRef.current = null;
  }, [historyState.error]);
  const captureAnchor = () => {
    const el = messagesRef.current;
    if (!el) return;
    const row = Array.from(el.querySelectorAll<HTMLElement>("[data-virtual-message]")).find(item => item.getBoundingClientRect().bottom > el.getBoundingClientRect().top);
    if (row) anchorRef.current = { id: row.dataset.virtualMessage!, offset: row.getBoundingClientRect().top - el.getBoundingClientRect().top };
  };
  const handleLoadMore = () => {
    if (historyState.loading) return;
    captureAnchor();
    onLoadMore();
  };
  // 新消息/片段到达时自动滚到底（流式输出的基本体验）；触顶加载更早时锚定原视口
  useLayoutEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    if (visible.length === 0) { el.scrollTop = 0; return; }
    if (anchorRef.current) {
      const a = anchorRef.current;
      const index = visible.findIndex(message => message.id === a.id);
      if (index >= 0) {
        virtual.scrollToIndex(index, { align: "start" });
        requestAnimationFrame(() => {
          const row = el.querySelector<HTMLElement>(`[data-virtual-message="${CSS.escape(a.id)}"]`);
          if (row) el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset;
        });
      }
      anchorRef.current = null;
    } else if (followTail.current && !historyState.hasNewer) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visible, pending, virtual.getTotalSize()]);
  return (
    <div className="chat-view relative grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-bg">
      {/* 消息区与 Composer 是两个明确的 grid row：上面只能在自身内部滚动，
          下面的 Composer 因此不可能越过 Debug Area。 */}
      <div className="flex min-h-0 flex-col" inert={searchOpen}>
      {sessionId && <div className="absolute right-4 top-3 z-10">
        <button ref={searchButtonRef} type="button" title="搜索当前会话" aria-label="搜索当前会话" onClick={() => setSearchOpen(true)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><Search size={15} /></button>
      </div>}
      {/* 头部条已移除：「对话 / 空闲 / 自动」等控件按 visual spec §4.2 并入任务
          上下文条（TaskContextStrip，由 page.tsx 渲染在对话区顶部）。此处直接进
          入横幅与消息流，不再有第二根 36px 条。 */}
      {/* 断线横幅：reconnecting 提示自动恢复；offline 提示手动刷新（重连仍在后台退避重试） */}
      {connState !== "connected" && (
        <div
          className={cn(
            "flex h-7 shrink-0 items-center gap-2 px-4 text-[0.6875rem]",
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
            "flex h-7 shrink-0 items-center gap-2 px-4 text-[0.6875rem]",
            wtNotice.kind === "ok" ? "border-line bg-success-tint text-success" : "border-danger/30 bg-danger-tint text-danger",
          )}
        >
          <span className="truncate">{wtNotice.text}</span>
        </div>
      )}
      {/* 上下文读取 pill（P2-13）：本轮 Agent 读过的文件，点击联动打开 */}
      {reads.length > 0 && (
        <details className="chat-read-context mx-auto w-full max-w-[calc(var(--conversation-content-max)_+_3rem)] shrink-0 px-6 py-2">
          <summary className="cursor-pointer text-xs text-ink-3">已读取 {reads.length} 个文件</summary>
          <div className="flex flex-wrap gap-1 pt-2">
          {reads.map((path) => (
            <button
              key={path}
              type="button"
              onClick={() => onOpenFile(path)}
              title={`${path} · 点击在文件 Tab 打开`}
              className="max-w-full truncate rounded-lg bg-surface-2 px-2.5 py-1.5 font-mono text-xs text-ink-2 transition-colors hover:bg-line hover:text-ink"
            >
              {path}
            </button>
          ))}
          </div>
        </details>
      )}
      <div
        className={cn(
          // 内容列宽 = --conversation-content-max + 两侧 px-6，让「正文左边界」与
          // Composer 卡片左边缘落在同一条竖线上（规格 §5.2 单一阅读轴）。
          "messages mx-auto min-h-0 w-full max-w-[calc(var(--conversation-content-max)_+_3rem)] flex-1 overflow-y-auto px-6 py-8",
          visible.length === 0 ? "flex flex-col" : "",
        )}
        ref={messagesRef}
        data-cached-messages={messages.length}
        onScroll={(e) => {
          // 触顶自动加载更早历史（hasMore 且未在加载中——防抖在 page 层）
          const el = e.currentTarget;
          followTail.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          setShowLatest(!followTail.current);
          onReadingHistory(searchOpen || !followTail.current || !!historyState.hasNewer);
          if (historyState.hasMore && !historyState.error && el.scrollTop < 80) handleLoadMore();
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
      {(historyState.loading || historyState.error || historyState.hasMore) && (
        <div className="flex min-h-10 items-center justify-center gap-2 py-2 text-xs text-ink-3" role={historyState.error ? "alert" : "status"}>
          {historyState.error ? (
            <>
              <span className="min-w-0 break-words text-danger" title={historyState.error}>
                {historyState.phase === "initial" ? "历史消息加载失败" : "更早消息加载失败"}
              </span>
              <button type="button" onClick={handleLoadMore} title="重试加载历史消息" aria-label="重试加载历史消息"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                <RotateCw size={14} />
              </button>
            </>
          ) : historyState.loading ? (
            <><LoaderCircle size={14} className="shrink-0 animate-spin" /><span>正在加载{historyState.phase === "initial" ? "历史" : "更早"}消息…</span></>
          ) : (
            <button type="button" onClick={handleLoadMore} className="min-h-8 hover:text-ink">加载更早消息</button>
          )}
        </div>
      )}
      {todos && todos.length > 0 && <TodoCard todos={todos} />}
      {/* N6 实时进度：运行中展示「正在执行第 N 步 · 当前工具」，取代单一状态点 */}
        {visible.length === 0 && !historyState.loading && !historyState.error && (
          <div className="chat-welcome flex-1">
            <div className="text-[1.5rem] font-semibold tracking-[-0.035em] text-ink">今天想完成什么？</div>
            <div className="max-w-md text-[0.8125rem] leading-6 text-ink-3">
              从一个问题、一个想法，或一项需要完成的工作开始。
            </div>
          </div>
        )}
        <div ref={listRef} className="relative w-full" style={{ height: virtual.getTotalSize(), overflowAnchor: "none" }}>
        {virtual.getVirtualItems().map(item => {
          const idx = item.index;
          const m = visible[idx]!;
          const renderMessage = () => {
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
                <div key={m.id} data-message-id={m.id} className="flex justify-end">
                  <div className="chat-user-message w-full">
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
              <div key={m.id} data-message-id={m.id} className="group flex justify-end">
                <div className="chat-user-message relative">
                  <div className="chat-user-bubble whitespace-pre-wrap px-4 py-3 text-[0.875rem] leading-[1.65] text-ink">
                    {m.skill && (
                      <div className="mb-1.5 flex items-center gap-1.5 text-[0.8125rem] leading-5">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" className="shrink-0 text-accent">
                          <path d="m8 1.8 5 2.9v6.6l-5 2.9-5-2.9V4.7l5-2.9Z" /><path d="m3 4.7 5 2.9 5-2.9M8 7.6v6.6" />
                        </svg>
                        <span className="font-medium text-accent">{m.skill.name}</span>
                        <span className="text-ink"><MessageText text={text} /></span>
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
                    {m.parts.map(({ part }) => part.type === "file" ? <div key={part.id} className="mt-2 rounded-md border border-line px-3 py-2 text-xs"><a href={part.url} download={part.filename}>📎 {part.filename}</a></div> : null)}
                  </div>
                  <div className="mt-1 flex justify-end items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
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
          // ZCode 式过程流，两种状态：
          // · 运行中（活跃尾部消息）→ 每个过程 part 逐行实时展示（弱化折叠行，
          //   图标 名称 · 摘要；运行中的工具保持单行折叠，呼吸图标即实时反馈）；
          // · 本轮结束后 → **按轮次合并**（用户拍板）：同一条消息的全部过程
          //   （思考 + 工具，含被正文隔开的）收进一个「工作流程」组，组行放在
          //   首个过程 part 的位置（保持时间顺序：先干活后总结），正文原位。
          //   按相邻分段会把中断-恢复的长会话切成十几个「1 个步骤」小组，碎片化
          //   满屏（实测一个真实会话 17 组）。diff 卡、子任务卡是「结果」不进组。
          type Slot = { kind: "part" | "live"; item: UiPart } | { kind: "flow"; items: UiPart[] };
          const slots: Slot[] = [];
          let flowGroup: { kind: "flow"; items: UiPart[] } | null = null;
          for (const item of m.parts) {
            // diff 卡（edit/write 落盘预览）是「结果」不进组；思考/工具/子任务是过程
            const isFlow = (item.part.type === "reasoning" || item.part.type === "subtask" || (item.part.type === "tool" && !item.diff));
            if (lastActive) {
              slots.push({ kind: isFlow ? "live" : "part", item });
              continue;
            }
            if (isFlow) {
              if (!flowGroup) {
                flowGroup = { kind: "flow", items: [] };
                slots.push(flowGroup);
              }
              flowGroup.items.push(item);
              continue;
            }
            slots.push({ kind: "part", item });
          }
          const blocks: React.ReactNode[] = slots.map((slot) =>
            slot.kind === "flow" ? (
              <WorkflowGroup key={`${m.id}-flow`} parts={slot.items} onOpenFile={onOpenFile} onOpenChild={onOpenChildSession} />
            ) : (
              <PartView key={`${m.id}-${slot.kind}-${slot.item.part.id}`} part={slot.item.part} diff={slot.item.diff} markdown onOpenFile={onOpenFile} subagent={slot.item.subagent} onOpenChild={onOpenChildSession} />
            ),
          );
          return (
            <div key={m.id} data-message-id={m.id} className="chat-assistant-message">
              <div className="min-w-0 flex-1 space-y-1.5">
              {blocks}
              {m.error && (
                <ErrorCard
                  error={m.error}
                  isTail={idx === visible.length - 1 && !running}
                  todos={todos}
                  checkpoint={checkpoint}
                  lastTool={m.parts
                    .map((p) => p.part)
                    .filter((p): p is Extract<Part, { type: "tool" }> => p.type === "tool")
                    .pop()?.tool}
                />
              )}
              {/* P1 的「继续」chip 已删除（规格 3 §19）：它发的是前端拼出来的伪用户
                  消息，而任务目标/验收条件/剩余步骤全靠从上下文猜——多轮或压缩之后
                  必然漂移。上游抖动现在由框架自己在同一任务里退避重试，直到任务层
                  给出 blocked/failed；用户该做什么由下方任务卡的动作按钮表达。 */}
              {/* 运行状态只在 Composer 上方状态行出现一处（流光标 + 当前工具 + 时长）。
                  消息尾部不再放「正在工作…」——上下两处各说各话的状态是困惑源。 */}
              </div>
            </div>
          );
          };
          return <div key={m.id} data-index={idx} data-virtual-message={m.id} ref={virtual.measureElement}
            className="absolute left-0 top-0 min-h-8 w-full pb-5" style={{ transform: `translateY(${item.start - scrollMargin}px)` }}>
            {m.id === firstUnreadId && <div className="mb-4 flex items-center gap-3 text-[0.6875rem] text-ink-3"><span className="h-px flex-1 bg-line" />未读消息<span className="h-px flex-1 bg-line" /></div>}
            {renderMessage()}
          </div>;
        })}
        </div>
        {historyState.hasNewer && <button type="button" disabled={historyState.loading} className="my-3 w-full text-xs text-ink-3 disabled:opacity-40" onClick={() => { captureAnchor(); onLoadNewer(); }}>加载更新消息</button>}
        {/* 任务区（规格 3 §14.1）。分层原则（ZCode/Codex 基准）：状态不常驻会话流——
            · 运行/排队/恢复等纯状态 → 顶部任务上下文条 + Composer 上方状态行，流里不留卡；
            · 交付卡 —— task.delivered 后出现一次，是内容（做成了什么）不是状态；
            · 行动卡 —— 只在任务等用户（needsUser：授权/补充/选择/外部确认）时出现，
              带 blocker 说明与动作按钮，事情办完即消失。 */}
        {task && taskView && taskView.completed && <TaskDeliveryCard task={task} />}
        {task && taskView && !taskView.completed && taskView.status !== "failed" && taskView.status !== "cancelled" && taskView.needsUser && (
          <TaskProgressCard task={task} view={taskView} attempts={taskAttempts} onAction={(action) => onTaskAction?.(action)} />
        )}
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
          />
        )}
        {/* 本轮产物卡片：只展示 summary 对应的这一轮 run 的产物（summaryArtifacts），
            不跨轮累积。挂在 SummaryCard 下方，与「总结陈词」一起构成收尾区。 */}
        {summary && !running && summaryArtifacts.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs font-medium text-ink-3">
              <span>本轮产物</span>
              <span className="font-mono text-xs text-ink-3">{summaryArtifacts.length}</span>
              {onOpenArtifact && (
                <button type="button" onClick={onOpenArtifact} className="ml-auto rounded-md bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-line hover:text-ink">
                  打开成果
                </button>
              )}
            </div>
            {summaryArtifacts.map((a) => (
              <ArtifactCard key={a.artifactId} artifact={a} onOpenFile={onOpenFile} onOpenPreview={onOpenPreview} />
            ))}
          </div>
        )}
        {pending && (
          // 锚点供任务动作「授权并继续」定位（规格 §14.2）。PermissionCard 来自
          // @zmzai/theme，不给它加 props——包一层就够，也避免把宿主的责任压给主题包。
          <div data-permission-card>
            <PermissionCard
              request={{ id: pending.id, permission: pending.permission, patterns: pending.patterns, metadata: pending.metadata }}
              onReply={(reply, feedback) => onReply(reply, feedback)}
            />
          </div>
        )}
      </div>
      </div>
      <div className="chat-input-dock" inert={searchOpen}>
      {(showLatest || historyState.hasNewer) && <button type="button" title="回到最新消息" aria-label="回到最新消息" className="chat-latest inline-flex items-center gap-1.5" onClick={() => { followTail.current = true; onReadingHistory(false); if (historyState.hasNewer || historyState.error) onLoadLatest(); else messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight }); setShowLatest(false); }}><ArrowDown size={14} />回到最新消息{readState && readState.unreadCount > 0 ? ` · ${readState.unreadCount} 条未读` : ""}</button>}
      {/* 发送被挡（上一任务外部副作用未确认）：持久横幅 + 一键放行。这与断线横幅
          同一层级——都是「现在做不了某件事 + 出路在这」的事，不是 4s 提示的事。 */}
      {recoveryBlocked && (
        <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-warning/30 bg-warning-tint px-4 py-1.5 text-[0.6875rem] text-warning">
          <span className="min-w-0 flex-1">上次任务中断，外部改动未确认——新消息暂时发不出</span>
          <button
            type="button"
            onClick={() => onResolveRecovery?.()}
            className="shrink-0 rounded-pill bg-warning/15 px-2.5 py-1 font-medium text-warning transition-colors hover:bg-warning/25"
          >
            核对并继续上次任务
          </button>
        </div>
      )}
      {/* 状态与输入器共享同一个 grid row，避免隐式第三行挤压消息区。 */}
      <div className="flex h-7 shrink-0 items-center justify-center">
        {(whisper || running) && (
          <div className="flex items-center text-[0.6875rem] tracking-wide text-ink-3">
            {running ? (
              <span className="flex items-center gap-2 px-3">
                <span className="streaming-caret" />
                <span>{currentTool ? TOOL_ACTIVITY_PHRASE[currentTool] ?? `正在使用 ${toolLabel(currentTool)}` : "正在思考"}</span>
                {runSeconds > 0 && (
                  <span className="font-mono">{runSeconds < 60 ? `${runSeconds}s` : `${Math.floor(runSeconds / 60)} 分 ${runSeconds % 60} 秒`}</span>
                )}
              </span>
            ) : (
              <span className="px-3">{whisper}</span>
            )}
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
        permissionMode={permissionMode}
        onCyclePermissionMode={onCyclePermissionMode}
      />
      </div>
      {searchOpen && sessionId && <SessionMessageSearch key={sessionId} sessionId={sessionId} onClose={() => { setSearchOpen(false); requestAnimationFrame(() => searchButtonRef.current?.focus()); }} />}
    </div>
  );
}
