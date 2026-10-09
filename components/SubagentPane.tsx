"use client";

import { useCallback, useEffect, useState } from "react";
import { Markdown, Reasoning, ToolCard } from "@zmzai/theme";

import { client } from "@/lib/client";
import type { Part, TranscriptMessage } from "@/lib/types";
import { cn } from "@zmzai/theme";

/** 子代理消息盒子（工作台「子代理」Tab）：只读渲染一个子会话的完整转录。
 *
 *  数据就是普通会话的 messages API（子会话与父会话同库同形状），拉最近 50 条；
 *  跑动中的子代理靠 4s 轮询刷新——不接 SSE，盒子是「看」的窗口不是「控」的入口。
 *  渲染复用会话流的语言：用户右侧气泡、助手全宽正文、工具/思考弱化折叠行。
 *
 *  内容来源：page 传来的 sessions 清单 + fallback（最近派生、跑着的优先）——
 *  没点过「打开」也自动展示，空态只属于真没有子任务的会话；并行派生多个
 *  子代理时顶部出 chips，盒内切换不回会话流。 */
export function SubagentPane({
  session,
  sessions = [],
  onSelect,
}: {
  session: { sessionId: string; agent: string; description: string } | null;
  sessions?: { sessionId: string; agent: string; description: string; running: boolean }[];
  onSelect?: (child: { sessionId: string; agent: string; description: string }) => void;
}) {
  const [messages, setMessages] = useState<TranscriptMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (!session) return;
      if (!silent) setRefreshing(true);
      try {
        const page = await client.getMessagesPage(session.sessionId, null, 50);
        setMessages(page.messages);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "读取子会话失败");
      } finally {
        if (!silent) setRefreshing(false);
      }
    },
    [session],
  );

  useEffect(() => {
    setMessages(null);
    setError(null);
    if (!session) return;
    void load();
    // 挂载期间低频轮询：子代理在跑时能看到步骤推进；终态后轮询只是空转一次校验
    const timer = setInterval(() => void load(true), 4000);
    return () => clearInterval(timer);
  }, [session, load]);

  if (!session) {
    return (
      <div className="wb-empty text-[0.8125rem] text-ink-3" data-subagent-pane>
        <div className="text-[0.9375rem] font-medium text-ink-2">还没有子代理</div>
        <div>在会话里派发子任务后，这里会实时展示它的执行过程。</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-subagent-pane>
      {/* 并行子代理切换（>1 才出现）：跑着的带脉冲点，当前项加深。 */}
      {sessions.length > 1 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line/60 px-3 py-1.5">
          {sessions.map((child) => {
            const active = child.sessionId === session.sessionId;
            return (
              <button
                key={child.sessionId}
                type="button"
                onClick={() => onSelect?.({ sessionId: child.sessionId, agent: child.agent, description: child.description })}
                title={`${child.agent} · ${child.description}${child.running ? " · 执行中" : ""}`}
                className={cn(
                  "inline-flex max-w-[11rem] items-center gap-1.5 rounded-pill px-2.5 py-1 text-[0.6875rem] transition-colors",
                  active ? "bg-surface-2 font-medium text-ink" : "text-ink-3 hover:bg-surface-2/60 hover:text-ink-2",
                )}
                data-subagent-chip={child.sessionId}
              >
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", child.running ? "bg-live animate-pulse" : "bg-ink-3/50")} />
                <span className="truncate">{child.description || child.agent}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="wb-bar-sm shrink-0">
        <span className="truncate font-medium text-ink-2" title={`${session.agent} · ${session.description}`}>
          {session.agent} · {session.description}
        </span>
        <span className="ml-auto font-mono text-[0.625rem] text-ink-3">{session.sessionId.slice(0, 12)}</span>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-2 rounded-md px-2 py-0.5 text-[0.625rem] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
        >
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {error && <div className="text-xs text-danger">{error}</div>}
        {messages === null && !error && <div className="text-xs text-ink-3">正在读取子会话…</div>}
        {messages?.length === 0 && <div className="text-xs text-ink-3">子会话还没有消息（可能刚派生，稍候刷新）。</div>}
        {messages?.map((m) => (
          <SubagentMessage key={m.info.id} message={m} />
        ))}
      </div>
    </div>
  );
}

function SubagentMessage({ message }: { message: TranscriptMessage }) {
  if (message.info.role !== "assistant") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    if (!text.trim()) return null;
    return (
      <div className="flex justify-end">
        <div className="chat-user-bubble max-w-[78%] whitespace-pre-wrap px-4 py-3 text-[0.875rem] leading-[1.65] text-ink">{text}</div>
      </div>
    );
  }
  return (
    <div className="chat-assistant-message space-y-1.5">
      {message.parts.map((part) => (
        <SubagentPart key={part.id} part={part} />
      ))}
    </div>
  );
}

function SubagentPart({ part }: { part: Part }) {
  switch (part.type) {
    case "text":
      return (
        <div className="text-[0.875rem] leading-[1.65] text-ink">
          <Markdown text={part.text} />
        </div>
      );
    case "reasoning":
      return <Reasoning text={part.text} />;
    case "tool":
      return <ToolCard call={{ id: part.callId, tool: part.tool, state: part.state }} sessionIdle={false} />;
    case "compaction":
      return <div className="text-xs text-ink-2">上下文已压缩：{part.summary}</div>;
    default:
      return null;
  }
}
