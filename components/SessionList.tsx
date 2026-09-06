"use client";

import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@zmzai/theme";
import type { SessionListItem } from "@/lib/types";

function timeLabel(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

/**
 * 会话四分组（visual spec §4.3）。
 *
 * **只是视觉分组**——不改变 project-scoped 的 session API，也不改变归档语义：
 * 归档会话进 `archived` 组，其余按「是否需要你处理 / 是否正在跑 / 其余」归类。
 */
type GroupKey = "needs_attention" | "running" | "recent" | "archived";

const GROUP_LABEL: Record<GroupKey, string> = {
  needs_attention: "需要处理",
  running: "进行中",
  recent: "最近",
  archived: "已归档",
};

/** 分组求值顺序：归档 > 待确认(HITL) > 进行中 > 需要处理 > 最近（先命中先归）。
 *  待确认排在 running 前：被权限卡住的后台会话最需要用户看见。 */
function groupOf(
  s: SessionListItem,
  activity?: Record<string, { kind: string; at: number }>,
): GroupKey {
  if (s.archived) return "archived";
  if (s.awaitingPermission) return "needs_attention";
  if (s.running) return "running";
  // 需要处理 = 后台任务刚结束且你还没点开（未读动态），或上一次 run 以失败/中断收尾。
  if (activity?.[s.id]) return "needs_attention";
  if (s.lastOutcome === "error" || s.lastOutcome === "aborted") return "needs_attention";
  return "recent";
}

/** 终态 → 可读文案 + 语义色（三重表达：点形状 + 文字 + title，颜色仅辅助）。 */
const OUTCOME: Record<string, { label: string; dot: string; text: string; tint: string }> = {
  awaiting: { label: "待确认", dot: "animate-pulse bg-warning", text: "text-warning", tint: "bg-warning-tint" },
  running: { label: "运行中", dot: "animate-pulse bg-live", text: "text-live", tint: "bg-live-tint" },
  completed: { label: "完成", dot: "bg-success", text: "text-ink-3", tint: "bg-surface-2" },
  aborted: { label: "中断", dot: "bg-warning", text: "text-warning", tint: "bg-warning-tint" },
  error: { label: "失败", dot: "bg-danger", text: "text-danger", tint: "bg-danger-tint" },
  idle: { label: "空闲", dot: "bg-ink-3", text: "text-ink-3", tint: "bg-surface-2" },
};

function outcomeOf(s: SessionListItem): string {
  if (s.awaitingPermission) return "awaiting";
  if (s.running) return "running";
  return s.lastOutcome ?? (s.title ? "completed" : "idle");
}

/** 后台动态（未读）的终态文案。key 是 kind 字符串，因此显式声明索引签名。 */
const BG_LABEL: Record<string, string> = {
  completed: "已完成",
  aborted: "已中断",
  error: "已失败",
};

type Props = {
  sessions: SessionListItem[];
  activeId: string | null;
  /** 顶部插槽（项目切换器）。 */
  top?: ReactNode;
  /** 底部插槽（账户块）。 */
  bottom?: ReactNode;
  /** 主行动：新建会话（Qoder 式「+ 创建」按钮，不传则不渲染）。 */
  onNewSession?: () => void;
  /** 新建会话是否可用（未登录 relay 时禁用）。 */
  canCreate?: boolean;
  /** 新会话默认使用隔离副本（git worktree，robustness-plan §9），持久化开关。 */
  isolateNew?: boolean;
  onToggleIsolateNew?: () => void;
  onSelectSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteSession: (id: string) => void;
  /** N6 置顶/归档（服务端持久化，父组件即时反馈）。 */
  onTogglePinned: (id: string) => void;
  onToggleArchived: (id: string) => void;
  /** 后台会话动态（P2-15 续）：id → 结束态。非激活会话结束时列表出徽标，点击清除。 */
  activity?: Record<string, { kind: string; at: number }>;
  width?: number;
};

export default function SessionList({ sessions, activeId, top, bottom, onNewSession, canCreate, isolateNew, onToggleIsolateNew, onSelectSession, onRenameSession, onDeleteSession, onTogglePinned, onToggleArchived, activity, width }: Props) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  // 归档组默认折叠：它是低信号区，展开是 explicit 动作（§4.3 把它列为第四组而非独立视图）。
  const [archivedOpen, setArchivedOpen] = useState(false);

  const q = query.trim().toLowerCase();
  // 标题/代理/模型/项目名任意字段命中即保留（归档会话也参与搜索，否则搜到却看不见）
  const filtered = useMemo(
    () =>
      sessions.filter((s) =>
        q
          ? `${s.title} ${s.agent} ${s.model?.modelId ?? ""} ${s.projectName ?? ""}`
              .toLowerCase()
              .includes(q)
          : true,
      ),
    [sessions, q],
  );

  // 搜索时不做分组：分组维度（是否需要处理）与搜索意图无关，平铺更好扫。
  // 非搜索态按四分组，空组不渲染（不占视觉），组内保持「置顶优先 + 原顺序」。
  const groups = useMemo(() => {
    const buckets: Record<GroupKey, SessionListItem[]> = {
      needs_attention: [],
      running: [],
      recent: [],
      archived: [],
    };
    for (const s of filtered) buckets[groupOf(s, activity)].push(s);
    const pinnedFirst = (list: SessionListItem[]) =>
      [...list].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
    return (["needs_attention", "running", "recent", "archived"] as GroupKey[])
      .map((key) => ({ key, items: pinnedFirst(buckets[key]) }))
      .filter((g) => g.items.length > 0);
  }, [filtered, activity]);

  const renderRow = (s: SessionListItem) => (
    <SessionRow
      key={s.id}
      s={s}
      active={activeId === s.id}
      renaming={editingId === s.id}
      editingTitle={editingTitle}
      bgActivity={activity?.[s.id] ?? null}
      onEditingTitleChange={setEditingTitle}
      onSelect={onSelectSession}
      onRename={onRenameSession}
      onEndRename={() => setEditingId(null)}
      onStartRename={(id, title) => {
        setEditingId(id);
        setEditingTitle(title);
      }}
      onTogglePinned={onTogglePinned}
      onToggleArchived={onToggleArchived}
      onDelete={onDeleteSession}
    />
  );

  return (
    <aside className="flex shrink-0 flex-col border-r border-line bg-surface" style={width ? { width } : undefined}>
      {/* 项目切换器（关联本地文件夹） */}
      {top}

      {/* 主行动行：新建会话 + 隔离副本 + 搜索合为一行。
          旧版「按钮→开关→『会话』标题→分组头」四层纵向堆叠，第一屏全是 chrome；
          拍平后 chrome 只占一行，搜索时本行原地变为输入框（Slack 式）。 */}
      {onNewSession && (
        <div className="flex shrink-0 items-center gap-1.5 px-3 pb-1 pt-3">
          {searchOpen ? (
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  setSearchOpen(false);
                }
              }}
              placeholder="搜索会话…"
              className="h-9 min-w-0 flex-1 rounded-sm border border-line bg-bg px-3 text-[0.8125rem] text-ink outline-none placeholder:text-ink-3 focus:border-ink"
            />
          ) : (
            <button
              type="button"
              disabled={!canCreate}
              onClick={onNewSession}
              title={canCreate ? "新建会话（⌘N）" : "登录 relay 后可新建会话"}
              className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-sm px-3 text-[0.8125rem] font-medium text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
                <path d="M8 2.5v11M2.5 8h11" strokeLinecap="round" />
              </svg>
              <span className="truncate">新建会话</span>
              <span className="ml-auto shrink-0 font-mono text-[0.625rem] text-ink-3">⌘N</span>
            </button>
          )}
          {onToggleIsolateNew && !searchOpen && (
            <button
              type="button"
              onClick={onToggleIsolateNew}
              title={
                isolateNew
                  ? "新会话将使用隔离副本（git worktree）：改动只进副本，合并前主工作区零污染"
                  : "开启后新会话使用隔离副本（git worktree）：改动只进副本，合并前主工作区零污染"
              }
              aria-pressed={isolateNew}
              className={cn(
                "flex h-9 w-8 shrink-0 items-center justify-center rounded-sm transition-colors",
                isolateNew
                  ? "bg-accent text-accent-ink"
                  : "text-ink-3 hover:bg-surface-2 hover:text-ink",
              )}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <circle cx="4.5" cy="3.5" r="1.7" />
                <circle cx="4.5" cy="12.5" r="1.7" />
                <circle cx="11.5" cy="6.5" r="1.7" />
                <path d="M4.5 5.2v5.6M11.5 8.2c0 2-2 2.6-5.2 2.8" strokeLinecap="round" />
              </svg>
            </button>
          )}
          <button
            type="button"
            title={searchOpen ? "关闭搜索" : "搜索会话"}
            onClick={() => {
              setSearchOpen((v) => !v);
              if (searchOpen) setQuery("");
            }}
            className={cn(
              "flex h-9 w-8 shrink-0 items-center justify-center rounded-sm transition-colors",
              searchOpen
                ? "bg-surface-2 text-ink"
                : "text-ink-3 hover:bg-surface-2 hover:text-ink",
            )}
          >
            {searchOpen ? (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5L14 14" strokeLinecap="round" />
              </svg>
            )}
          </button>
        </div>
      )}

      {/* 会话列表：分组节头（最近/进行中/…）自带标签，「会话」总标题层已并入上行 chrome */}
      <div className="flex min-h-0 flex-1 flex-col pt-2.5">
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {filtered.length === 0 && (
            <div className="px-3 py-4 text-xs text-ink-3">
              {q ? "没有匹配的会话。" : "还没有会话，新建一个开始。"}
            </div>
          )}
          {q
            ? filtered.map(renderRow)
            : groups.map((g) => {
                const collapsed = g.key === "archived" && !archivedOpen;
                return (
                  <section key={g.key} className="mb-1">
                    <button
                      type="button"
                      onClick={() => g.key === "archived" && setArchivedOpen((v) => !v)}
                      title={GROUP_LABEL[g.key]}
                      aria-expanded={g.key === "archived" ? archivedOpen : undefined}
                      className={cn(
                        "flex w-full items-center gap-1 px-2 py-1 text-left text-[0.625rem] font-semibold tracking-wide text-ink-3",
                        g.key === "archived" ? "transition-colors hover:text-ink" : "cursor-default",
                      )}
                    >
                      {g.key === "archived" && (
                        <svg
                          width="9"
                          height="9"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={cn("shrink-0 transition-transform", archivedOpen && "rotate-90")}
                        >
                          <path d="M6 3.5L10.5 8L6 12.5" />
                        </svg>
                      )}
                      <span>{GROUP_LABEL[g.key]}</span>
                      <span className="font-mono text-[0.625rem] text-ink-3/70">{g.items.length}</span>
                    </button>
                    {!collapsed && g.items.map(renderRow)}
                  </section>
                );
              })}
        </div>
      </div>
      {bottom && <div className="shrink-0 p-3">{bottom}</div>}
    </aside>
  );
}

/** 会话行：四分组与搜索平铺共用同一渲染，避免两条路径各写一份而漂移。 */
function SessionRow({
  s,
  active,
  renaming,
  editingTitle,
  bgActivity,
  onEditingTitleChange,
  onSelect,
  onRename,
  onStartRename,
  onEndRename,
  onTogglePinned,
  onToggleArchived,
  onDelete,
}: {
  s: SessionListItem;
  active: boolean;
  renaming: boolean;
  editingTitle: string;
  /** 后台动态（未读）：非激活会话跑完后的结束态。 */
  bgActivity: { kind: string; at: number } | null;
  onEditingTitleChange: (v: string) => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onStartRename: (id: string, title: string) => void;
  onEndRename: () => void;
  onTogglePinned: (id: string) => void;
  onToggleArchived: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const outcome = outcomeOf(s);
  const style = OUTCOME[outcome] ?? OUTCOME.idle!;
  // 后台动态（未读）：终态文案本身就是「小型可读标识」（§4.3），用 tint 底色表达
  // 「还没看」，不再用一个无意义的「新」字胶囊占位。
  const bgLabel = bgActivity ? BG_LABEL[bgActivity.kind] ?? "已结束" : "";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => !renaming && onSelect(s.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !renaming) onSelect(s.id);
      }}
      className={cn(
        "group relative mb-0.5 block w-full cursor-pointer rounded-sm py-2 pl-3 pr-2 text-left transition-colors",
        active ? "bg-selected" : "hover:bg-surface-2",
      )}
    >
      {/* 活跃行标记：一条左侧竖线 + selected 背景。不再叠加 shadow/ring（§4.3）。 */}
      {active && (
        <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />
      )}
      {renaming ? (
        <input
          autoFocus
          value={editingTitle}
          onChange={(e) => onEditingTitleChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter" && editingTitle.trim()) {
              onRename(s.id, editingTitle.trim());
              onEndRename();
            } else if (e.key === "Escape") {
              onEndRename();
            }
          }}
          onBlur={onEndRename}
          className="h-6 w-full rounded-sm border border-line bg-bg px-1.5 text-[0.8125rem] text-ink outline-none focus:border-ink"
        />
      ) : (
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn("flex min-w-0 items-center gap-1 truncate text-[0.8125rem] font-medium", active ? "text-ink" : "text-ink-2")}>
            {s.pinned && (
              <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 text-ink-3">
                <path d="M9.5 2.5l4 4L6 14l-1-1 2-2-3.5.5L3 11l3-3-3.5-1 1-1L8 5.5l1-1L9.5 2.5z" strokeLinejoin="round" />
              </svg>
            )}
            <span className="truncate">{s.title || "未命名会话"}</span>
            {bgActivity && (
              <span
                title={`后台任务${bgLabel}，点开查看后消失`}
                className={cn(
                  "ml-0.5 inline-flex shrink-0 items-center rounded-[3px] px-1 py-px text-[0.5625rem] leading-none",
                  style.tint,
                  style.text,
                )}
              >
                {bgLabel}
              </span>
            )}
          </span>
          <span className="shrink-0 font-mono text-[0.625rem] text-ink-3 group-hover:invisible">
            {timeLabel(s.time.updated ?? s.time.created)}
          </span>
        </div>
      )}
      <div className="mt-0.5 flex items-center gap-1.5 truncate text-[0.6875rem] text-ink-3">
        {/* 状态：点形状 + 可读文字 + title（三重表达，颜色只是辅助） */}
        <span title={style.label} className={cn("h-1.5 w-1.5 shrink-0 rounded-full", style.dot)} />
        <span className={cn("shrink-0", style.text)}>{style.label}</span>
        <span className="truncate">
          {s.agent}
          {s.model ? ` · ${s.model.providerId}/${s.model.modelId}` : ""}
        </span>
        {typeof s.messageCount === "number" && s.messageCount > 0 && (
          <span className="shrink-0 font-mono text-[0.625rem] text-ink-3">{s.messageCount} 条</span>
        )}
      </div>
      {/* hover 操作：置顶 / 归档 / 重命名 / 删除 */}
      {!renaming && (
        <div className="absolute right-1.5 top-1.5 hidden items-center gap-0.5 group-hover:flex">
          <button
            type="button"
            title={s.pinned ? "取消置顶" : "置顶"}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePinned(s.id);
            }}
            className={cn("flex h-5 w-5 items-center justify-center rounded-sm bg-surface transition-colors", s.pinned ? "text-accent" : "text-ink-3 hover:text-ink")}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill={s.pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4">
              <path d="M9.5 2.5l4 4L6 14l-1-1 2-2-3.5.5L3 11l3-3-3.5-1 1-1L8 5.5l1-1L9.5 2.5z" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            title={s.archived ? "取消归档" : "归档"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleArchived(s.id);
            }}
            className="flex h-5 w-5 items-center justify-center rounded-sm bg-surface text-ink-3 transition-colors hover:text-ink"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="2.5" y="3" width="11" height="10" rx="1.2" />
              <path d="M5.5 3V2.5A1 1 0 0 1 6.5 1.5h3A1 1 0 0 1 10.5 2.5V3" />
              <path d="M2.5 6.5h11" />
            </svg>
          </button>
          <button
            type="button"
            title="重命名"
            onClick={(e) => {
              e.stopPropagation();
              onStartRename(s.id, s.title || "");
            }}
            className="flex h-5 w-5 items-center justify-center rounded-sm bg-surface text-ink-3 transition-colors hover:text-ink"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M11.3 2.3a1.5 1.5 0 0 1 2.1 2.1L5 12.8l-3 .7.7-3 8.6-8.2z" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            title="删除会话"
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`删除会话「${s.title || "未命名"}」？消息记录将一并删除。`)) onDelete(s.id);
            }}
            className="flex h-5 w-5 items-center justify-center rounded-sm bg-surface text-ink-3 transition-colors hover:text-danger"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
