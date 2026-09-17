"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useRouter } from "next/navigation";
import { PanelBottom, PanelLeft, PanelRight } from "lucide-react";
import { cn } from "@zmzai/theme";
import { usePlatform } from "@/lib/use-platform";

import CommandPalette, { type Command } from "@/components/CommandPalette";
import ProjectSwitcher from "@/components/ProjectSwitcher";
import SessionList from "@/components/SessionList";
import TaskContextStrip from "@/components/TaskContextStrip";
import TaskBarActions from "@/components/TaskBarActions";
import ChatView from "@/components/ChatView";
import WorkbenchPanel from "@/components/WorkbenchPanel";
import DebugArea from "@/components/DebugArea";
import AccountBlock from "@/components/AccountBlock";
import { client, type ConnectionState } from "@/lib/client";
import { detectPermissionMode, PERMISSION_MODES, type PermissionMode } from "@/lib/permission-mode";
import { ChatProjector, EMPTY_CHAT_VIEW, transcriptToEvents, type ChatViewData } from "@/lib/chat-projector";
import { SessionHistory, EMPTY_HISTORY_STATE, type HistoryState } from "@/lib/session-history";
import { readPref, writePref, clearPref } from "@/lib/prefs";
import { deriveTaskPresentation, previewableOf, type SessionStatus } from "@/lib/task-presentation";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SPLITTER_STEP,
  SPLITTER_STEP_LARGE,
  WORKBENCH_DEFAULT_WIDTH,
  WORKBENCH_MIN_WIDTH,
  availableWidthFor,
  canSplitSideBySide,
  clampWorkbenchWidth,
  defaultTaskWorkbenchLayout,
  layoutModeFor,
  readLegacyLayout,
  readTaskWorkbenchLayout,
  workbenchMaxFor,
  workbenchPresentationFor,
  writeTaskWorkbenchLayout,
  type ActiveOverlay,
  type TaskWorkbenchLayout,
  type WorkbenchTab,
} from "@/lib/task-layout";
import type { SessionInfo, SessionListItem, PermissionRequest, PermissionSettings, LecternEvent, ModelRef, ThinkingEffort, AuthStatus, SessionIsolation } from "@/lib/types";
import { PERMISSION_DOMAIN_OF } from "@/lib/types";

/** 把 UI 会话状态映射为状态机域的 SessionStatus（state-driven spec §6）。
 *  会话状态流里没有终态（只有 running / waiting_* / 空），终态取自
 *  chatData.summary.kind（framework session.summary 事件的 kind）。 */
function toSessionStatus(status: string, summaryKind?: string | null): SessionStatus {
  if (status === "running") return "running";
  if (status === "waiting_permission" || status === "waiting_input") return "waiting";
  if (summaryKind === "error") return "failed";
  if (summaryKind === "completed") return "completed";
  return "idle";
}

/** 任务标题：首条用户消息的首行；无消息时回退「新任务」（§4.2 任务标题不为空）。 */
function taskTitleOf(data: ChatViewData): string {
  for (const m of data.messages) {
    if (m.role !== "user") continue;
    const text = m.parts
      .map((p) => (p.part.type === "text" ? p.part.text : ""))
      .join("")
      .trim();
    if (text) return text.split("\n")[0]!.slice(0, 80);
  }
  return "新任务";
}

function readWidth(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw == null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * 垂直分隔条（规格 §5.5.2）。
 *
 * 拖动期间**只更新宽度变量**，不触碰消息 DOM、滚动锚点或工作台内容；到达边界后
 * 保持稳定，不回弹、不产生指针漂移（位移始终基于 pointerdown 时的起点值计算）。
 *
 * 无障碍：role="separator" + 方向 + 当前值/最小值/最大值，方向键 16px、
 * Shift 48px、Home/End 到边界、双击复位。
 */
function VerticalSplitter({ label, value, min, max, direction, onReset, onChange, onDragChange }: { label: string; value: number; min: number; max: number; direction: 1 | -1; onReset?: () => void; onChange: (value: number) => void; onDragChange?: (dragging: boolean) => void }) {
  const drag = useRef<{ id: number; x: number; value: number } | null>(null);
  // 拖拽中状态只用于视觉反馈（轨道变 accent 实心），不参与尺寸计算。
  const [dragging, setDragging] = useState(false);
  const apply = useCallback((next: number) => onChange(Math.min(max, Math.max(min, next))), [max, min, onChange]);

  // Electron 有时不会把 pointer capture 后的 move 回送到 React 合成事件；
  // 由 window 接管拖动，离开 12px 热区后也能稳定继续调整。
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const start = drag.current;
      if (start?.id === event.pointerId) apply(start.value + direction * (event.clientX - start.x));
    };
    const finish = (event: globalThis.PointerEvent) => {
      if (drag.current?.id !== event.pointerId) return;
      drag.current = null;
      setDragging(false);
      onDragChange?.(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [apply, direction, onDragChange]);

  // 组件在拖动中被卸载（切会话/切断点）时也要解除捕获层，否则页面会卡在
  // 「透明层吃掉所有点击」的状态里。
  useEffect(() => () => onDragChange?.(false), [onDragChange]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // pointer capture 让后续 move 始终路由到本元素（而不是被 iframe/预览区截走），
    // 是规格 §5.5.2「不因 iframe 捕获鼠标而中断拖动」的第一道保险；
    // 第二道是页面级的透明捕获层，见 page.tsx 的 splitter-capture。
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 某些环境下不支持；window 监听仍是主路径 */
    }
    drag.current = { id: event.pointerId, x: event.clientX, value };
    setDragging(true);
    onDragChange?.(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  return <div role="separator" aria-orientation="vertical" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} tabIndex={0} data-dragging={dragging} title={onReset ? `${label}（双击复位，方向键调整，Shift 加速）` : label} onPointerDown={onPointerDown} onDoubleClick={onReset} onKeyDown={(event) => {
    const step = event.shiftKey ? SPLITTER_STEP_LARGE : SPLITTER_STEP;
    if (event.key === "ArrowLeft") { event.preventDefault(); apply(value - direction * step); }
    if (event.key === "ArrowRight") { event.preventDefault(); apply(value + direction * step); }
    if (event.key === "Home") { event.preventDefault(); apply(min); }
    if (event.key === "End") { event.preventDefault(); apply(max); }
  }} className="wb-splitter wb-splitter-v hidden min-[760px]:block">
    <span className="wb-splitter-track" />
  </div>;
}

function HorizontalSplitter({ label, value, min, max, onReset, onChange }: { label: string; value: number; min: number; max: number; onReset?: () => void; onChange: (value: number) => void }) {
  const drag = useRef<{ id: number; y: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const apply = useCallback((next: number) => onChange(Math.min(max, Math.max(min, next))), [max, min, onChange]);
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const start = drag.current;
      if (start?.id === event.pointerId) apply(start.value - (event.clientY - start.y));
    };
    const finish = (event: globalThis.PointerEvent) => {
      if (drag.current?.id !== event.pointerId) return;
      drag.current = null;
      setDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [apply]);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { id: event.pointerId, y: event.clientY, value };
    setDragging(true);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };
  return <div role="separator" aria-orientation="horizontal" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} tabIndex={0} data-dragging={dragging} title={onReset ? `${label}（双击复位）` : label} onPointerDown={onPointerDown} onDoubleClick={onReset} onKeyDown={(event) => {
    if (event.key === "ArrowUp") { event.preventDefault(); apply(value + 16); }
    if (event.key === "ArrowDown") { event.preventDefault(); apply(value - 16); }
    if (event.key === "Home") { event.preventDefault(); apply(min); }
    if (event.key === "End") { event.preventDefault(); apply(max); }
  }} className="wb-splitter wb-splitter-h">
    <span className="wb-splitter-track" />
  </div>;
}

/** 把最新回调同步进 ref 桥（避免命令面板捕获旧闭包）。 */
function PaletteBridge({ bridge, action }: { bridge: React.RefObject<{ newSession: () => void }>; action: () => void }) {
  useEffect(() => {
    bridge.current = { newSession: action };
  }, [bridge, action]);
  return null;
}

/** N6 完成提示音：短促双音 beep（Web Audio，无需资源文件），静默失败不阻塞。
 *  调用方负责时机判断（仅 document.hidden / 后台会话时播放，前台不打扰）。 */
function playDoneChime(): void {
  try {
    const Ctx = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const play = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur);
    };
    play(880, 0, 0.15);
    play(1174.66, 0.15, 0.2);
    setTimeout(() => void ctx.close(), 600);
  } catch {
    /* 提示音失败静默跳过 */
  }
}

/** 后台会话动态：多会话并行时（配合 worktree 隔离），非激活会话结束即在此登记，
 *  列表出徽标 + 隐藏窗口时系统通知/提示音；点击该会话清除。 */
type BackgroundActivity = Record<string, { kind: string; at: number }>;

export default function App() {
  const { isMac, modifier, shift } = usePlatform();
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // 侧栏已去代理分组：会话固定用 default agent，模型选择交给底部 Composer（默认推荐）
  const activeAgent = "default";
  // 消息流投影：事件不再累积进 state（无限增长 + 每 delta 全量重投影 O(n²)），
  // 改为增量折叠进 ChatProjector，rAF 批量取快照渲染（lib/chat-projector.ts）
  const projectorRef = useRef<ChatProjector | null>(null);
  const rafRef = useRef<number | null>(null);
  const [chatData, setChatData] = useState<ChatViewData>(EMPTY_CHAT_VIEW);
  const [historyState, setHistoryState] = useState<HistoryState>(EMPTY_HISTORY_STATE);
  const historyRef = useRef<SessionHistory | null>(null);
  const readingHistoryRef = useRef(false);
  const sendIdentityRef = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const sessionCreationIdentityRef = useRef<{ fingerprint: string; requestId: string } | null>(null);
  // 乐观回显：send 时暂存本条用户消息，切会话后作废
  const [echo, setEcho] = useState<{ text: string; images: { url: string; mediaType: string }[]; skill?: { id: string; name: string }; references?: string[] } | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [pending, setPending] = useState<PermissionRequest | null>(null);
  // 后台会话动态（P2-15 续）：id → 结束态；点击会话清除
  const [backgroundActivity, setBackgroundActivity] = useState<BackgroundActivity>({});
  const activeIdRef = useRef<string | null>(null);
  const prevRunningRef = useRef<Map<string, boolean>>(new Map());
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  // SSE 连接状态（断线自动重连；offline 时 UI 出手动重试）
  const [connState, setConnState] = useState<ConnectionState>("connected");
  const [selectedModel, setSelectedModel] = useState<ModelRef | null>(null);
  // P1-10/F2 文件联动：消息路径点击（可带行号）/ ⌘P 快开 → 产物侧文件 Tab（ts 保证重复触发也生效）
  const [openFileReq, setOpenFileReq] = useState<{ path: string; ts: number; line?: number } | null>(null);
  // P1-7 自治档位：自动 = 授权请求自动「始终允许」
  const [autoMode, setAutoMode] = useState(false);
  // ref 镜像：档位只在 SSE 订阅闭包里被读取（判断授权是否自动放行），若不走镜像
  // 就得把它列进订阅 effect 的依赖——那样每次切换档位都会 unsub + 重订阅、
  // 重置投影器并整段重拉历史。与下方 permAutoRef 同一套处理方式。
  const autoModeRef = useRef(false);
  // 设置 → 通用 → 权限：细粒度自动执行配置（terminal/edit/task/gitWrite）。
  // ref 镜像：SSE 订阅闭包读最新值，配置变更不重订阅。
  const [permAuto, setPermAuto] = useState<PermissionSettings>({});
  const permAutoRef = useRef<PermissionSettings>({});
  // P2-12 命令面板
  const [palette, setPalette] = useState<"commands" | "files" | "search" | null>(null);
  const paletteActionsRef = useRef<{ newSession: () => void }>({ newSession: () => undefined });
  // 左侧栏收起/展开（Qoder 同款，持久化）
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // 窄断点下的覆盖层（规格 §7.1 的 ResponsivePresentation）：**不持久化**。
  // 侧栏与工作台共用它，因此天然互斥；离开窄断点即失效，桌面偏好原样回来。
  const [activeOverlay, setActiveOverlay] = useState<ActiveOverlay>(null);
  const [sidebarWidth, setSidebarWidth] = useState(256);
  // 工作台布局：开合 / 宽度 / 标签 / 是否显式选过标签共用一个对象（规格 §7.1 / §9）。
  // 落盘只在 updateTaskLayout 里**同步**发生，不靠「写回 effect」——切任务时 state
  // 会晚一个提交才跟上，effect 会把上一个任务的宽度写到新任务名下（§12.3）。
  const [taskLayout, setTaskLayout] = useState<TaskWorkbenchLayout>(() => defaultTaskWorkbenchLayout());
  const {
    open: workbenchOpen,
    width: workbenchWidth,
    tab: workbenchTab,
    tabExplicit: workbenchTabExplicit,
  } = taskLayout;
  // 拖动中挂一层透明捕获层（规格 §5.5.2）：预览区里的 iframe 会吞掉 pointermove，
  // 拖过它时拖动就断了。拖动期间此标志为真，页面顶部渲染 splitter-capture。
  const [workbenchDragging, setWorkbenchDragging] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(1440);
  const [viewportHeight, setViewportHeight] = useState(900);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(260);
  const [bottomPanelOpen, setBottomPanelOpen] = useState(false);
  const [layoutReady, setLayoutReady] = useState(false);
  useEffect(() => {
    setSidebarWidth(readWidth("lectern:sidebar-width", 256, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
    setBottomPanelHeight(readWidth("lectern:bottom-panel-height", 260, 160, 640));
    setBottomPanelOpen(localStorage.getItem("lectern:bottom-panel-open") === "1");
    setViewportWidth(window.innerWidth);
    setViewportHeight(window.innerHeight);
    setLayoutReady(true);
  }, []);
  // 会话级 worktree 隔离（robustness-plan §9）：新建会话默认勾选「隔离副本」（持久化）
  const [isolateNew, setIsolateNew] = useState(false);
  // active 会话的隔离状态（切换会话时按服务端为准查询）+ 操作结果横幅
  const [activeIsolation, setActiveIsolation] = useState<SessionIsolation | null>(null);
  const [wtNotice, setWtNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const toggleIsolateNew = useCallback(() => {
    setIsolateNew((v) => {
      writePref("isolateNew", v ? "0" : "1");
      return !v;
    });
  }, []);

  // 隔离操作横幅自动消退（8s）
  useEffect(() => {
    if (!wtNotice) return;
    const t = setTimeout(() => setWtNotice(null), 8000);
    return () => clearTimeout(t);
  }, [wtNotice]);

  useEffect(() => {
    void client.authStatus().then(setAuth);
  }, []);
  useEffect(() => {
    if (!layoutReady) return;
    localStorage.setItem("lectern:sidebar-width", String(sidebarWidth));
    localStorage.setItem("lectern:bottom-panel-height", String(bottomPanelHeight));
    localStorage.setItem("lectern:bottom-panel-open", bottomPanelOpen ? "1" : "0");
  }, [layoutReady, sidebarWidth, bottomPanelHeight, bottomPanelOpen]);

  // ── 按任务装载工作台布局（规格 §9 / §12.3）────────────────────────────────
  // 装载必须与「切任务」落在**同一个提交**里。WorkbenchPanel 只在挂载时读一次
  // initialTab，晚一个提交再换布局会让新任务的第一帧挂着上一个任务的标签；
  // 反过来，把当前 state 写到上一个任务的键上则会让任务之间串台。两者都是
  // 「按任务恢复」的直接违背，所以这里既不用「写回 effect」也不用水合守卫：
  //   · 装载：owner 变化时在渲染期同步换掉，React 会立刻重跑渲染而不提交中间结果；
  //   · 落盘：更新时同步写，写谁的键取**已提交**的 activeId。
  const [layoutOwner, setLayoutOwner] = useState("__draft__");
  const layoutOwnerNow = activeId ?? "__draft__";
  /** 布局的最新镜像：事件路径（用户动作 / clamp）读它，避免把四个字段塞进依赖数组。 */
  const taskLayoutRef = useRef<TaskWorkbenchLayout>(taskLayout);
  if (layoutReady && layoutOwner !== layoutOwnerNow) {
    // 纯读：不带 legacy，因此这里不会写入存储（迁移交给下面的 effect）。
    setLayoutOwner(layoutOwnerNow);
    setTaskLayout(readTaskWorkbenchLayout(layoutOwnerNow));
  }
  useEffect(() => {
    taskLayoutRef.current = taskLayout;
  }, [taskLayout]);

  /** 用户动作 / clamp 的唯一写入口：更新 state 并**同步**落盘（规格 §9）。 */
  const updateTaskLayout = useCallback((patch: Partial<TaskWorkbenchLayout>) => {
    const current = taskLayoutRef.current;
    const next = { ...current, ...patch };
    if (
      next.open === current.open &&
      next.width === current.width &&
      next.tab === current.tab &&
      next.tabExplicit === current.tabExplicit
    ) {
      return; // 值没变就不写：clamp 是幂等的，到边界后必须彻底安静
    }
    taskLayoutRef.current = next;
    if (layoutReady) writeTaskWorkbenchLayout(activeId ?? "__draft__", next);
    setTaskLayout(next);
  }, [activeId, layoutReady]);

  /** 把布局装载进 state（迁移用），**不落盘**。 */
  const replaceTaskLayout = useCallback((next: TaskWorkbenchLayout) => {
    taskLayoutRef.current = next;
    setTaskLayout(next);
  }, []);

  // 旧版全局宽度只在第一个**真实任务**尚无记录时迁移一次（规格 §9）。渲染期只做
  // 纯读，把带写入的迁移留在 effect 里；迁移只影响宽度，不会动面板挂载时的标签。
  const legacyPendingRef = useRef(true);
  useEffect(() => {
    if (!layoutReady || !activeId || !legacyPendingRef.current) return;
    legacyPendingRef.current = false;
    const legacy = readLegacyLayout();
    if (legacy.width == null && legacy.open == null) return;
    replaceTaskLayout(readTaskWorkbenchLayout(activeId, legacy));
  }, [activeId, layoutReady, replaceTaskLayout]);

  // 切任务时收起窄断点覆盖层（规格 §7：选择任务后自动关闭侧栏，把会话交还用户）。
  useEffect(() => {
    setActiveOverlay(null);
  }, [activeId]);
  useEffect(() => {
    const syncViewport = () => {
      setViewportWidth(window.innerWidth);
      setViewportHeight(window.innerHeight);
    };
    window.addEventListener("resize", syncViewport);
    return () => window.removeEventListener("resize", syncViewport);
  }, []);

  // ── 布局模式派生（规格 §7 / §5.5.2）─────────────────────────────────────
  // 持久桌面偏好（sidebarOpen / workbenchOpen / workbenchWidth / workbenchTab）与
  // 当前断点下的临时呈现严格分离：进入窄断点只改 activeOverlay，绝不回写偏好。
  // 这样才能满足 §12.12「768–1179px 覆盖层运行，返回 ≥1180px 后恢复已保存的桌面状态」。
  const layoutMode = layoutModeFor(viewportWidth);
  const sideBySideCapable = availableWidthFor(viewportWidth, sidebarOpen, sidebarWidth);
  const workbenchMax = workbenchMaxFor(sideBySideCapable);
  /** 桌面偏好在该可用宽度下的呈现（§5.5：不够宽就降级为抽屉，而不是挤压会话）。 */
  const desktopWorkbenchPresentation = workbenchPresentationFor(layoutMode, workbenchOpen, sideBySideCapable);
  const workbenchSideBySide = desktopWorkbenchPresentation === "side";
  // 窄断点下工作台可见性只由 activeOverlay 决定；桌面下由（可能降级的）桌面偏好决定。
  const workbenchDrawer = layoutMode === "desktop"
    ? desktopWorkbenchPresentation === "drawer"
    : activeOverlay === "workbench";
  const workbenchVisible = workbenchSideBySide || workbenchDrawer;
  const sidebarMax = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - (workbenchSideBySide ? workbenchWidth : 0) - 436));
  const bottomPanelMax = Math.max(160, viewportHeight - 280);
  useEffect(() => {
    setSidebarWidth((value) => Math.min(value, sidebarMax));
  }, [sidebarMax]);
  // 视口/侧栏变化时把宽度压回该可用宽度下的合法区间（规格 §5.5.2 的 clamp；
  // 幂等——到边界后 updateTaskLayout 的等值判断让它彻底安静）。
  // 只在**真的可能并排**时才压：覆盖层/单视图断点与降级抽屉都不使用这个宽度，
  // 此时写回等于让平板或窄窗口改掉桌面偏好（规格 §7.1 / §13 明文禁止）。
  useEffect(() => {
    if (!canSplitSideBySide(sideBySideCapable)) return;
    const clamped = clampWorkbenchWidth(sideBySideCapable, taskLayout.width);
    if (clamped !== taskLayout.width) updateTaskLayout({ width: clamped });
  }, [sideBySideCapable, taskLayout.width, updateTaskLayout]);
  useEffect(() => {
    setBottomPanelHeight((value) => Math.min(value, bottomPanelMax));
  }, [bottomPanelMax]);

  // 覆盖层是「当前断点下的临时呈现」（规格 §7.1），离开窄断点即作废：桌面模式下
  // 它不参与渲染，但留着它会让下次重新进入 768–1179px 时凭空弹出一个覆盖层。
  useEffect(() => {
    if (layoutMode === "desktop") setActiveOverlay(null);
  }, [layoutMode]);

  // 投影快照的 rAF 批处理：同一帧内任意多条事件只触发一次渲染
  const flushProjection = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setChatData(projectorRef.current?.data() ?? EMPTY_CHAT_VIEW);
    });
  }, []);
  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  // 自治档位持久化（localStorage，纯前端语义）+ 权限自动执行配置（settings.json）
  useEffect(() => {
    const initialAuto = readPref("autoMode") === "1";
    setAutoMode(initialAuto);
    // 这里同步赋一次，避免首条授权请求早于下方镜像 effect 抵达时读到初始值
    autoModeRef.current = initialAuto;
    setSidebarOpen(readPref("sidebar") !== "0");
    setIsolateNew(readPref("isolateNew") === "1");
    void client.permissionsGet().then((permissions) => {
      setPermAuto(permissions);
      permAutoRef.current = permissions;
    }).catch(() => undefined);
  }, []);

  // 档位变更后同步镜像，让 SSE 订阅闭包读到最新值（从而不必重订阅）
  useEffect(() => {
    autoModeRef.current = autoMode;
  }, [autoMode]);

  const toggleAuto = useCallback(() => {
    setAutoMode((v) => {
      writePref("autoMode", v ? "0" : "1");
      return !v;
    });
  }, []);
  // 桌面偏好与临时呈现分离（规格 §7.1）：
  // - 窄断点下开合只写 activeOverlay，不碰 sidebarOpen / workbenchOpen，
  //   所以从窄窗口恢复到 ≥1180px 时桌面状态原样回来；
  // - 侧栏与工作台共用同一个 activeOverlay 槽位，天然互斥。
  const compactPanels = layoutMode !== "desktop";
  const toggleSidebar = useCallback(() => {
    if (compactPanels) {
      setActiveOverlay((value) => (value === "sidebar" ? null : "sidebar"));
      return;
    }
    setSidebarOpen((value) => {
      writePref("sidebar", value ? "0" : "1");
      return !value;
    });
  }, [compactPanels]);
  const toggleWorkbench = useCallback(() => {
    if (compactPanels) {
      setActiveOverlay((value) => (value === "workbench" ? null : "workbench"));
      return;
    }
    updateTaskLayout({ open: !taskLayoutRef.current.open });
  }, [compactPanels, updateTaskLayout]);
  /** 打开工作台并切到指定标签。规格 §4.2：这是**唯一**会展开工作台的路径——
   *  成果生成、状态变化都不能自动展开，因此只能由用户动作触发。
   *
   *  窄断点下：只写临时覆盖层与标签（标签是任务级偏好，不是「开合状态」），
   *  绝不写 `open`——否则平板上的临时开合会覆盖桌面持久偏好（§13）。 */
  const openWorkbench = useCallback((tab: WorkbenchTab) => {
    updateTaskLayout({ tab, tabExplicit: true });
    if (compactPanels) {
      setActiveOverlay("workbench");
      return;
    }
    updateTaskLayout({ open: true });
  }, [compactPanels, updateTaskLayout]);
  const openFileInWorkbench = useCallback((path: string, line?: number) => {
    setOpenFileReq({ path, ts: Date.now(), line });
    openWorkbench("files");
  }, [openWorkbench]);
  /** 工作台内切标签：标签与「是否显式选过」都是任务级偏好（规格 §7.1 / §9）。
   *  并排与抽屉共用同一个处理器，因此两条路径的偏好语义完全一致。 */
  const handleWorkbenchTabChange = useCallback((tab: WorkbenchTab, explicit: boolean) => {
    updateTaskLayout(explicit ? { tab, tabExplicit: true } : { tab });
  }, [updateTaskLayout]);
  const toggleBottomPanel = useCallback(() => {
    setBottomPanelOpen((value) => !value);
  }, []);
  // 桌面壳检测（Codex 基准 ③）：Electron 下标题栏红绿灯融入顶栏，左上常驻侧栏开关。
  const [inElectron, setInElectron] = useState(false);
  useEffect(() => {
    setInElectron(Boolean(window.lecternNative));
  }, []);
  // 会话级权限模式（Codex 基准 ④）：跟随所选会话的 permission 规则回显，点击循环。
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  useEffect(() => {
    if (!activeId) {
      setPermissionMode("default");
      return;
    }
    const active = sessions.find((s) => s.id === activeId);
    if (active) setPermissionMode(detectPermissionMode(active.permission));
    // 仅在切换会话时同步（sessions 刷新会迟到，避免覆盖本地乐观值）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);
  const cyclePermissionMode = useCallback(() => {
    if (!activeId) return;
    const next = PERMISSION_MODES[(PERMISSION_MODES.indexOf(permissionMode) + 1) % PERMISSION_MODES.length];
    setPermissionMode(next);
    void client.setPermissionMode(activeId, next).catch(() => undefined);
  }, [activeId, permissionMode]);
  // 任务完成前台 toast（N5）：前台盯着的用户也要有明确完成感知，而非只有状态点变色。
  const [doneToast, setDoneToast] = useState<string | null>(null);
  // N6 卡住检测：运行中最后事件时间（subscribe 回调每次事件到达时刷新），
  // 超过阈值仍无新事件 → 提示「可能卡住」。看门狗在 framework 层 300s 兜底，
  // 这里 60s 提前给用户一个主动感知（更早、可中止）。
  const lastEventAtRef = useRef<number>(Date.now());
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (status !== "running") {
      setStalled(false);
      return;
    }
    lastEventAtRef.current = Date.now();
    const t = setInterval(() => {
      setStalled(Date.now() - lastEventAtRef.current > 60_000);
    }, 5_000);
    return () => clearInterval(t);
  }, [status]);

  // P2-12 全局快捷键：⌘K 命令 / ⌘P 文件 / ⌘⇧F 全文搜索（输入类元素聚焦时不抢）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      // VS Code 对齐：终端/调试区始终可用，输入框聚焦时也不让浏览器吞掉。
      if (key === "j") {
        e.preventDefault();
        toggleBottomPanel();
        return;
      }
      if (key !== "k" && key !== "p" && !(key === "f" && e.shiftKey)) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      setPalette(key === "k" ? "commands" : key === "p" ? "files" : "search");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleBottomPanel]);

  // Electron 的 ⌘W 由主进程截获后从 preload 回送到这里。终端是当前唯一有
  // 多实例 tab 的区域：焦点在其任意部分时优先关闭活动 shell，而不是退出 App。
  useEffect(() => {
    const closeFocusedPane = () => {
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.closest("[data-terminal-pane]")) {
        window.dispatchEvent(new Event("lectern:close-active-terminal"));
      }
    };
    const remove = window.lecternNative?.onCloseFocusedPane?.(closeFocusedPane);
    return () => remove?.();
  }, []);

  // 后台动态检测（P2-15 续）：非激活会话 running→false 转换即登记（列表徽标 +
  // 隐藏窗口时通知/提示音）；激活会话的完成提示由 SSE session.status 链路负责。
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const ingestSessionList = useCallback((next: SessionListItem[]) => {
    const updates: BackgroundActivity = {};
    const nowHidden = document.hidden;
    let ended = 0;
    for (const s of next) {
      const was = prevRunningRef.current.get(s.id);
      prevRunningRef.current.set(s.id, !!s.running);
      if (was !== true || s.running) continue;
      if (s.id === activeIdRef.current) continue;
      updates[s.id] = { kind: s.lastOutcome ?? "completed", at: Date.now() };
      ended += 1;
    }
    if (ended === 0) {
      setSessions(next);
      return;
    }
    setBackgroundActivity((cur) => ({ ...cur, ...updates }));
    setSessions(next);
    if (nowHidden) {
      const ok = ended === 1 && (Object.values(updates)[0]?.kind ?? "completed") === "completed";
      const bridge = window.lecternNative;
      const body = ended === 1 ? `后台任务${ok ? "已完成" : "已结束"}，回来看看结果` : `${ended} 个后台任务已结束`;
      if (bridge?.notifyTaskDone) bridge.notifyTaskDone();
      else if ("Notification" in window && Notification.permission === "granted") new Notification("Lectern", { body });
      playDoneChime();
    }
  }, []);

  useEffect(() => {
    // 任务侧栏需要显示所有项目的后台结束态；API 只读聚合各项目 SQLite 库，
    // 不改变当前项目 runtime 的创建与事件订阅边界。
    // The conversation sidebar is project-scoped. Cross-project aggregation belongs
    // to the task center and must never leak into the active project's session list.
    void client.listSessions().then(ingestSessionList);
  }, [auth?.loggedIn, ingestSessionList]);

  // 仅恢复当前项目库中仍存在的上次会话。旧跨项目 pendingSession 不再参与恢复。
  const bootRestoredRef = useRef(false);
  useEffect(() => {
    if (bootRestoredRef.current || !auth?.loggedIn) return;
    // 会话列表至少拉到一版再做恢复判断（空列表 = 真没有会话，不再等）
    if (sessions.length === 0) {
      bootRestoredRef.current = true;
      return;
    }
    bootRestoredRef.current = true;
    clearPref("pendingSession");
    const last = readPref("lastSession");
    if (last && sessions.some((s) => s.id === last)) setActiveId(last);
  }, [auth?.loggedIn, sessions]);

  // lastSession 持久化：活跃会话变化即写（下次启动自动回到上次会话）
  useEffect(() => {
    if (activeId) writePref("lastSession", activeId);
  }, [activeId]);

  const selectSession = useCallback((id: string) => {
    // 打开后台有动态的会话即清除其徽标
    setBackgroundActivity((cur) => {
      if (!(id in cur)) return cur;
      const { [id]: _drop, ...rest } = cur;
      return rest;
    });
    if (id !== activeId) {
      // V2 DebugArea §4.6：切到一个「空闲且从未跑过」的任务时默认收起调试区，
      // 让 Composer 成为中央锚点；有活动进程（running）或有历史终态（lastOutcome）
      // 的任务保留用户/既有选择，不打断。
      const target = sessions.find((s) => s.id === id);
      if (target && !target.running && !target.lastOutcome) {
        setBottomPanelOpen(false);
      }
      setActiveId(id);
    }
    // 窄断点：选中任务后自动关闭覆盖层，把会话交还给用户（规格 §7）。
    if (layoutMode !== "desktop") setActiveOverlay(null);
  }, [activeId, sessions, viewportWidth]);

  useEffect(() => {
    const projector = projectorRef.current ?? (projectorRef.current = new ChatProjector());
    setHistoryState(EMPTY_HISTORY_STATE);
    if (!activeId) {
      projector.reset();
      setChatData(EMPTY_CHAT_VIEW);
      setStatus("idle");
      setPending(null);
      setEcho(null);
      setConnState("connected");
      return;
    }
    let cancelled = false;
    readingHistoryRef.current = false;
    let historyRevision = 1;
    let ignoredLiveSeq = 0;
    const cursorAt = (messageSeq: number) => btoa(JSON.stringify({ sessionId: activeId, messageSeq, historyRevision }));
    // 同水位快照装载完成后从 snapshotSeq 续订，补齐快照请求期间产生的事件。
    projector.reset();
    setChatData(EMPTY_CHAT_VIEW);
    setStatus("idle");
    setPending(null);
    setEcho(null);
    setConnState("connected");
    setActiveIsolation(null);
    setWtNotice(null);
    // 隔离副本状态以服务端为准（worktree 映射在 worktrees.db）
    client.worktreeStatus(activeId).then((st) => !cancelled && setActiveIsolation(st)).catch(() => undefined);
    let unsub = () => {};
    const handleLive = (ev: LecternEvent) => {
      if (cancelled) return;
      lastEventAtRef.current = Date.now();
      if (ev.type === "session.status") setStatus((ev.data as { status: string }).status);
      else if (ev.type === "permission.asked") {
        const req = (ev.data as { request: PermissionRequest }).request;
        // 侧边栏「待确认」即时反映（列表 API 10s 轮询只兜后台会话）
        setSessions((prev) => prev.map((s) => (s.id === activeId ? { ...s, awaitingPermission: true } : s)));
        // P1-7 自动档：全部「始终允许」；细粒度权限（设置 → 通用）：命中的域自动「始终允许」
        // 两者都读 ref 镜像，配置/档位变更不触发重订阅
        const domain = PERMISSION_DOMAIN_OF[req.permission];
        const isAuto = autoModeRef.current;
        const autoHit = isAuto || (domain && permAutoRef.current[domain] === "auto");
        if (autoHit) {
          void client
            .replyPermission(activeId, req.id, "always", undefined, {
              source: isAuto ? "auto" : "fine-grained",
              permission: req.permission,
              summary: req.metadata?.summary ?? req.metadata?.command ?? req.metadata?.filePath ?? "",
            })
            .catch(() => undefined);
        } else {
          setPending(req);
        }
      } else if (ev.type === "permission.replied") {
        setPending(null);
        setSessions((prev) => prev.map((s) => (s.id === activeId ? { ...s, awaitingPermission: false } : s)));
      }
      if (ev.type === "session.rewound") {
        void history.load("latest");
        return;
      }
      if (ev.type === "message.updated") {
        const message = (ev.data as { message: { id: string } }).message;
        if ((readingHistoryRef.current || history.hasNewer) && !projector.hasMessage(message.id)) {
          ignoredLiveSeq = Math.max(ignoredLiveSeq, ev.seq ?? 0);
          const last = projector.bounds().last;
          if (last !== undefined) history.setBoundary("after", cursorAt(last));
          return;
        }
      }
      projector.ingest(ev);
      if (projector.trimMessages("tail")) {
        const first = projector.bounds().first;
        if (first !== undefined) history.setBoundary("before", cursorAt(first));
      }
      flushProjection();
    };
    // 跨会话恢复：尾部分页拉取转录（首屏 50 条），逐条折叠进投影器
    const history = new SessionHistory({
      fetchPage: (cursor, signal, direction) => direction === "newer" && cursor ? client.getMessageContext(activeId, { after: cursor }, signal) : client.getMessagesPage(activeId, cursor, 50, signal),
      apply: (page, initial, direction) => {
        historyRevision = page.historyRevision;
        if (initial) {
          unsub();
          projector.reset();
          setPending(null);
          setStatus("idle");
          for (const ev of transcriptToEvents(page.messages)) projector.ingest(ev);
          for (const ev of page.stateEvents ?? []) {
            // Restoring an approval must not silently repeat an external reply.
            if (ev.type === "session.status") setStatus((ev.data as { status: string }).status);
            if (ev.type === "permission.asked") setPending((ev.data as { request: PermissionRequest }).request);
            projector.ingest(ev);
          }
          unsub = client.subscribe(activeId,handleLive,(state) => { if (!cancelled) setConnState(state); },page.snapshotSeq);
        } else {
          projector.ingestBatch(transcriptToEvents(page.messages.filter(message => !projector.hasMessage(message.info.id))), direction !== "newer");
        }
        const keep = direction === "older" && !initial ? "head" : "tail";
        if (projector.trimMessages(keep)) {
          const bounds = projector.bounds();
          const sequence = keep === "head" ? bounds.last : bounds.first;
          if (sequence !== undefined) history.setBoundary(keep === "head" ? "after" : "before", cursorAt(sequence));
        }
        if (!initial && ignoredLiveSeq > page.snapshotSeq) {
          const last = projector.bounds().last;
          if (last !== undefined) history.setBoundary("after", cursorAt(last));
        }
        flushProjection();
      },
      onState: setHistoryState,
    });
    historyRef.current = history;
    void history.load();
    return () => {
      cancelled = true;
      history.dispose();
      if (historyRef.current === history) historyRef.current = null;
      unsub();
    };
    // autoMode / permAuto 均经 ref 镜像读取，不列入依赖——否则切换档位或权限
    // 配置会整段重跑：断开重连 SSE、重置投影器、重拉历史转录。
  }, [activeId, flushProjection]);

  const loadHistory = useCallback(() => { void historyRef.current?.load(); }, []);
  const loadNewerHistory = useCallback(() => { void historyRef.current?.load("newer"); }, []);
  const loadLatestHistory = useCallback(() => { void historyRef.current?.load("latest"); }, []);
  const setReadingHistory = useCallback((reading: boolean) => { readingHistoryRef.current = reading; }, []);
  useEffect(() => {
    const update = (event: Event) => {
      const { sessionId, readState } = (event as CustomEvent<{ sessionId: string; readState: import("@/lib/types").ReadState }>).detail;
      setSessions(items => items.map(item => item.id === sessionId ? { ...item, readState } : item));
    };
    window.addEventListener("lectern:read-state", update);
    return () => window.removeEventListener("lectern:read-state", update);
  }, []);

  // P2-14 任务完成通知：running → idle 时——后台窗口弹系统通知；前台弹页内 toast
  // （不再只在隐藏时提示，盯着的用户也有明确「完成了」的落点）。两者都触发。
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (prev === "running" && status === "idle") {
      document.title = "✓ 任务完成 — Lectern";
      // 前台 toast：轻提示，4s 自动消退
      setDoneToast("任务已完成");
      setTimeout(() => setDoneToast(null), 4000);
      const bridge = window.lecternNative;
      if (document.hidden && bridge?.notifyTaskDone) {
        bridge.notifyTaskDone();
      } else if (document.hidden && "Notification" in window && Notification.permission === "granted") {
        new Notification("Lectern", { body: "任务已完成，回来看看结果" });
      }
      // N6 完成提示音：短促双音 beep，只在后台窗口时播放——前台已弹 toast，避免打扰。
      if (document.hidden) playDoneChime();
    } else if (status === "running") {
      document.title = "Lectern";
    }
  }, [status]);

  // P2-15 多会话并行状态：轮询刷新运行态点（兜底——运行态主链路是 SSE
  // session.status）。前台 10s，页面隐藏降到 60s 省电省请求。
  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    const refresh = () => {
      void client.listSessions().then(ingestSessionList).catch(() => undefined);
    };
    const start = () => {
      clearInterval(timer);
      timer = setInterval(refresh, document.hidden ? 60_000 : 10_000);
    };
    const onVis = () => start();
    document.addEventListener("visibilitychange", onVis);
    start();
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(timer);
    };
  }, [ingestSessionList]);

  const newSession = useCallback(async () => {
    if (!auth?.loggedIn) return;
    const s = await client.createSession(activeAgent, undefined, isolateNew);
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    // 全新空闲任务默认收起调试区（§4.6）：让 Composer 成为中央锚点，终端不抢戏。
    setBottomPanelOpen(false);
    setActiveIsolation(s.isolation ? { ...s.isolation } : { enabled: false });
    if (s.isolation && !s.isolation.enabled && s.isolation.reason) {
      setWtNotice({ kind: "error", text: "隔离副本未启用（当前项目不是 git 仓库），本次会话直接在主工作区进行。" });
    }
  }, [activeAgent, auth?.loggedIn, isolateNew]);

  // 全局快捷键：⌘/Ctrl+N 新建会话（侧栏主按钮同款提示）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void newSession();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession]);

  const send = useCallback(
    async (text: string, images?: { url: string; mediaType: string }[], effort?: ThinkingEffort, skill?: { id: string; name: string }, references?: string[], attachments?: { name: string; mediaType: string; data: string; size: number }[]) => {
      if (!text.trim() && !images?.length && !attachments?.length) return;
      // 无会话时自动建（composer 不再强制先选会话）
      let sid = activeId;
      if (!sid) {
        if (!auth?.loggedIn) throw new Error("请先登录后发送附件或消息");
        const fingerprint = JSON.stringify({ activeAgent,isolateNew,text,images,effort,skillId: skill?.id,references,attachments });
        const retained = sessionCreationIdentityRef.current;
        const requestId = retained?.fingerprint === fingerprint
          ? retained.requestId
          : globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        sessionCreationIdentityRef.current = { fingerprint,requestId };
        const s = await client.createSession(activeAgent, undefined, isolateNew,requestId);
        if (sessionCreationIdentityRef.current?.requestId === requestId) sessionCreationIdentityRef.current = null;
        setSessions((prev) => [s, ...prev]);
        setActiveId(s.id);
        setActiveIsolation(s.isolation ?? { enabled: false });
        sid = s.id;
      }
      // 乐观回显：发送瞬间显示用户气泡，真实 message.updated 到达后自动让位
      setEcho({ text, images: images ?? [], ...(skill ? { skill } : {}), ...(references?.length ? { references } : {}) });
      // P1-9 任务前自动快照（git 仓库且有变更时才落 commit；失败不阻塞发送）
      void client.checkpointCreate(`任务前快照 · ${text.trim().slice(0, 30) || "图片任务"}`, sid).catch(() => undefined);
      // per-prompt 模型/推理力度覆盖：composer 选了则随本条消息下发，否则跟随代理默认
      try {
        const fingerprint = JSON.stringify({ sid,text,activeAgent,model: selectedModel,images,effort,skillId: skill?.id,references,attachments });
        const retained = sendIdentityRef.current;
        const requestId = retained?.fingerprint === fingerprint
          ? retained.requestId
          : globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        sendIdentityRef.current = { fingerprint,requestId };
        await client.prompt(sid, text, activeAgent, selectedModel ?? undefined, images, effort, skill?.id, references, attachments, requestId);
        if (sendIdentityRef.current?.requestId === requestId) sendIdentityRef.current = null;
      } catch (error) {
        setEcho(null); // 发送失败：撤回乐观气泡，错误经其它途径提示
        throw error;
      }
      // prompt 可能排队返回，刷新标题等元数据；AI 摘要标题异步落库，延迟再刷一次
      void client.listSessions().then(setSessions);
      setTimeout(() => void client.listSessions().then(setSessions), 4000);
    },
    [activeId, activeAgent, auth?.loggedIn, selectedModel, isolateNew],
  );

  // worktree 隔离副本操作：合并回主工作区 / 丢弃副本（结果用横幅提示，冲突给引导）
  const handleWorktreeAction = useCallback(
    async (action: "merge" | "discard") => {
      if (!activeId) return;
      if (action === "merge" && !window.confirm("把隔离副本的提交合并回主工作区当前分支？合并成功后副本将删除。")) return;
      if (action === "discard" && !window.confirm("丢弃隔离副本？未合并的提交将一并删除，不可恢复。")) return;
      try {
        const result = await client.worktreeAction(activeId, action);
        if (result.ok) {
          setActiveIsolation({ enabled: false });
          setWtNotice({ kind: "ok", text: action === "merge" ? "已合并回主工作区，隔离副本已清理。" : "隔离副本已丢弃。" });
        } else {
          setWtNotice({ kind: "error", text: result.output ?? result.error ?? "操作失败" });
        }
      } catch (err) {
        setWtNotice({ kind: "error", text: err instanceof Error ? err.message : "操作失败" });
      }
    },
    [activeId],
  );

  // 回溯重发：ChatView 原位编辑保存后调用（确认弹窗在 ChatView 内）。
  // 服务端截断转录 + 落 session.rewound 事件 + 重跑；投影由 SSE 事件流驱动更新。
  const handleRewind = useCallback(
    async (messageId: string, text: string) => {
      if (!activeId) return;
      try {
        await client.rewind(activeId, messageId, text);
      } catch (err) {
        window.alert(err instanceof Error ? err.message : "回溯失败");
      }
    },
    [activeId],
  );

  const reply = useCallback(
    async (r: "once" | "always" | "reject", feedback?: string) => {
      if (!activeId || !pending) return;
      await client.replyPermission(activeId, pending.id, r, feedback, {
        source: "manual",
        permission: pending.permission,
        summary: pending.metadata?.summary ?? pending.metadata?.command ?? pending.metadata?.filePath ?? "",
      });
      setPending(null);
    },
    [activeId, pending],
  );

  const abort = useCallback(() => {
    if (activeId) void client.abort(activeId);
  }, [activeId]);

  const renameSession = useCallback(async (id: string, title: string) => {
    await client.renameSession(id, title);
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
  }, []);

  // N6 置顶/归档：更新服务端 + 本地列表即时反馈
  const togglePinned = useCallback(async (id: string) => {
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    await client.setSessionPinned(id, !target.pinned);
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, pinned: !s.pinned } : s)));
  }, [sessions]);

  const toggleArchived = useCallback(async (id: string) => {
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    await client.setSessionArchived(id, !target.archived);
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, archived: !s.archived } : s)));
    if (target.archived === false) {
      // 归档后若正选中则取消选中
      setActiveId((cur) => (cur === id ? null : cur));
    }
  }, [sessions]);

  const deleteSession = useCallback(async (id: string) => {
    await client.deleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
  }, []);

  // P2-12 命令面板命令表
  const commands: Command[] = [
    { id: "new-session", label: "新建会话", hint: `${modifier}N 不支持时用这里`, run: () => paletteActionsRef.current.newSession() },
    { id: "open-files", label: "搜索文件…", hint: `${modifier}P`, run: () => setPalette("files") },
    { id: "search-sessions", label: "搜索会话内容…", hint: `${modifier}${shift}F`, run: () => setPalette("search") },
    { id: "toggle-auto", label: autoMode ? "切到确认档（逐次授权）" : "切到自动档（自动授权）", hint: "档位", run: toggleAuto },
    { id: "open-settings", label: "打开设置", hint: "个人 key / relay / MCP / 插件", run: () => router.push("/settings") },
  ];

  // 模型标签：选中（含 Composer 默认推荐）展示之，否则 fallback
  const modelLabel = selectedModel
    ? `${selectedModel.providerId}/${selectedModel.modelId}`
    : "默认模型";

  // ── 任务呈现派生（state-driven spec §6 / visual spec §4.2）────────────────
  // 全局任务状态的唯一来源：TaskContextStrip 只渲染，不做任何判断。
  const previewablePaths = useMemo(
    () => previewableOf(chatData.editedPaths),
    [chatData.editedPaths],
  );

  const presentation = useMemo(
    () =>
      deriveTaskPresentation({
        sessionId: activeId,
        sessionStatus: toSessionStatus(status, chatData.summary?.kind),
        permissionRequest: pending
          ? { id: pending.id, permission: pending.permission }
          : null,
        editedPaths: chatData.editedPaths,
        previewablePaths,
        explicitWorkbenchTab: null,
        explicitDebugTab: null,
      }),
    [
      activeId,
      status,
      chatData.summary?.kind,
      chatData.editedPaths,
      previewablePaths,
      pending,
    ],
  );

  const taskTitle = useMemo(() => taskTitleOf(chatData), [chatData]);

  // 项目名由侧栏切换器上抛（§4.2：上下文条要能辨识当前项目）。用回调身份稳定引用，
  // 避免每次渲染都触发 ProjectSwitcher 的 effect。
  const [projectName, setProjectName] = useState<string | null>(null);
  const sidebarVisible = compactPanels ? activeOverlay === "sidebar" : sidebarOpen;

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <header className="lectern-titlebar flex h-12 shrink-0 items-stretch">
        <div className="lectern-window-controls flex shrink-0 items-center gap-2 px-3" style={{ width: !compactPanels && sidebarOpen ? sidebarWidth + 6 : inElectron && isMac ? 144 : 56 }}>
          <button type="button" onClick={toggleSidebar} title={sidebarVisible ? "收起会话栏" : "展开会话栏"} aria-label={sidebarVisible ? "收起会话栏" : "展开会话栏"} aria-expanded={sidebarVisible} className="titlebar-button">
            <PanelLeft size={16} strokeWidth={1.55} aria-hidden />
          </button>
        </div>
        <div className="lectern-titlebar-main flex min-w-0 flex-1 items-center border-b border-line">
          <TaskContextStrip
            presentation={presentation}
            title={taskTitle}
            projectName={projectName}
            summary={chatData.summary?.text ?? null}
            meta={modelLabel}
            actions={
              <>
              {(presentation.state === "review_ready" || presentation.state === "delivered") && (
                <button type="button" onClick={() => openWorkbench(presentation.state === "delivered" ? "preview" : "review")} className="inline-flex min-h-8 items-center rounded-md bg-surface-2 px-2.5 text-xs font-medium text-ink-2 transition-colors hover:bg-line hover:text-ink">
                  {presentation.state === "delivered" ? "打开成果" : "打开审查"}
                </button>
              )}
              <TaskBarActions
                connState={connState}
                isolation={activeIsolation}
                onWorktreeAction={handleWorktreeAction}
                locked={presentation.state === "running"}
                autoMode={autoMode}
                onToggleAuto={toggleAuto}
              />
            <button
              type="button"
              onClick={toggleBottomPanel}
              title={bottomPanelOpen ? "收起底部面板" : "展开底部面板"}
              aria-label={bottomPanelOpen ? "收起底部面板" : "展开底部面板"}
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-sm transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-strong",
                bottomPanelOpen ? "bg-surface-2 text-ink" : "text-ink-3",
              )}
            >
              <PanelBottom size={16} strokeWidth={1.55} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={toggleWorkbench}
              title={workbenchVisible ? "收起右侧工作区" : "展开右侧工作区"}
              aria-label={workbenchVisible ? "收起右侧工作区" : "展开右侧工作区"}
              aria-expanded={workbenchVisible}
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-strong",
                workbenchVisible ? "bg-surface-2 text-ink" : "text-ink-3",
              )}
            >
              <PanelRight size={16} strokeWidth={1.55} aria-hidden="true" />
            </button>
              </>
            }
          />
        </div>
      </header>
      {/* 命令面板的「新建会话」需要拿最新 newSession */}
      <PaletteBridge bridge={paletteActionsRef} action={newSession} />

      {/* 任务完成前台 toast（N5）：轻提示，自动消退，不打断操作 */}
      {doneToast && (
        <div className="pointer-events-none fixed left-1/2 top-14 z-50 -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3.5 py-2 text-[0.8125rem] font-medium text-ink shadow-md">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            {doneToast}
          </div>
        </div>
      )}

      {/* 四区工作台：会话栏 | 对话 | 右侧工作区，底部独立承载终端与后续调试工具。 */}
      <div className="flex min-h-0 flex-1">
        {!compactPanels && sidebarOpen && (
        <SessionList
          top={<ProjectSwitcher onActiveChange={setProjectName} />}
          bottom={<AccountBlock />}
          sessions={sessions}
          activeId={activeId}
          activity={backgroundActivity}
          onNewSession={() => void newSession()}
          canCreate={!!auth?.loggedIn}
          isolateNew={isolateNew}
          width={sidebarWidth}
          onToggleIsolateNew={toggleIsolateNew}
          onSelectSession={selectSession}
          onRenameSession={(id, title) => void renameSession(id, title)}
          onDeleteSession={(id) => void deleteSession(id)}
          onTogglePinned={(id) => void togglePinned(id)}
          onToggleArchived={(id) => void toggleArchived(id)}
          onAbortSession={(id) => void client.abort(id).then(() => client.listSessions().then(ingestSessionList))}
        />
        )}
        {!compactPanels && sidebarOpen && <VerticalSplitter label="调整会话栏宽度" value={sidebarWidth} min={200} max={sidebarMax} direction={1} onReset={() => setSidebarWidth(256)} onChange={setSidebarWidth} />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {/* 横向分栏的每一级都必须允许缩到自身内容宽度以下。否则右栏拖宽时，
              这一行会保留对话内容的 min-content 宽度，再被外层 overflow-hidden
              裁掉，看起来像消息没有随面板宽度重新换行。 */}
          <div className="flex min-h-0 min-w-0 w-full flex-1 overflow-hidden">
            <ChatView
              key={activeId ?? "empty"}
              data={chatData}
              historyState={historyState}
              onLoadMore={loadHistory}
              onLoadNewer={loadNewerHistory}
              onLoadLatest={loadLatestHistory}
              onReadingHistory={setReadingHistory}
              status={status}
              pending={pending}
              sessionId={activeId}
              connState={connState}
              selectedModel={selectedModel}
              onSelectModel={setSelectedModel}
              onSend={send}
              onReply={reply}
              onContinue={(ctx) => void send(ctx)}
              stalled={stalled}
              onAbort={abort}
              onOpenFile={openFileInWorkbench}
              onOpenArtifact={() => openWorkbench("preview")}
              echo={echo}
              wtNotice={wtNotice}
              onRewind={handleRewind}
              permissionMode={permissionMode}
              onCyclePermissionMode={activeId ? cyclePermissionMode : undefined}
            />
            {workbenchSideBySide && (
              <>
                <VerticalSplitter
                  label="调整右侧工作区宽度"
                  value={workbenchWidth}
                  min={WORKBENCH_MIN_WIDTH}
                  max={workbenchMax}
                  direction={-1}
                  onReset={() => updateTaskLayout({ width: WORKBENCH_DEFAULT_WIDTH })}
                  onChange={(width) => updateTaskLayout({ width })}
                  onDragChange={setWorkbenchDragging}
                />
                <div className="min-h-0 min-w-0 shrink-0 overflow-hidden" style={{ width: workbenchWidth }}>
                  <WorkbenchPanel key={activeId ?? "new-task"} sessionId={activeId} openRequest={openFileReq} editedPaths={chatData.editedPaths} summary={chatData.summary} initialTab={workbenchTab} initialTabExplicit={workbenchTabExplicit} onTabChange={handleWorkbenchTabChange} />
                </div>
              </>
            )}
          </div>
          {bottomPanelOpen && <>
            <HorizontalSplitter label="调整底部调试面板高度" value={bottomPanelHeight} min={160} max={bottomPanelMax} onReset={() => setBottomPanelHeight(260)} onChange={setBottomPanelHeight} />
            <div className="flex min-h-0 shrink-0 border-t border-line" style={{ height: bottomPanelHeight }}>
              <DebugArea key={activeId ?? "new-task"} sessionId={activeId} onCollapse={toggleBottomPanel} />
            </div>
          </>}
        </div>
      </div>

      {compactPanels && activeOverlay === "sidebar" && (
        <div className="panel-scrim" role="presentation" onMouseDown={() => setActiveOverlay(null)}>
          <div className="panel-overlay panel-overlay-left" onMouseDown={(event) => event.stopPropagation()}>
            <SessionList
              top={<ProjectSwitcher onActiveChange={setProjectName} />}
              bottom={<AccountBlock />}
              sessions={sessions}
              activeId={activeId}
              activity={backgroundActivity}
              onNewSession={() => void newSession()}
              canCreate={!!auth?.loggedIn}
              isolateNew={isolateNew}
              width={Math.min(320, viewportWidth)}
              onToggleIsolateNew={toggleIsolateNew}
              onSelectSession={selectSession}
              onRenameSession={(id, title) => void renameSession(id, title)}
              onDeleteSession={(id) => void deleteSession(id)}
              onTogglePinned={(id) => void togglePinned(id)}
              onToggleArchived={(id) => void toggleArchived(id)}
              onAbortSession={(id) => void client.abort(id).then(() => client.listSessions().then(ingestSessionList))}
            />
          </div>
        </div>
      )}
      {/* 覆盖式工作台（规格 §5.5）：窄断点下由 activeOverlay 驱动，桌面宽度不足以
          并排时由桌面偏好降级驱动——绝不以压缩会话可读宽度为代价并排。 */}
      {workbenchDrawer && (
        <div className="panel-scrim" role="presentation" onMouseDown={() => (compactPanels ? setActiveOverlay(null) : updateTaskLayout({ open: false }))}>
          <div className="panel-overlay panel-overlay-right" onMouseDown={(event) => event.stopPropagation()}>
            <WorkbenchPanel key={activeId ?? "new-task"} sessionId={activeId} openRequest={openFileReq} editedPaths={chatData.editedPaths} summary={chatData.summary} initialTab={workbenchTab} initialTabExplicit={workbenchTabExplicit} onTabChange={handleWorkbenchTabChange} />
          </div>
        </div>
      )}

      {/* 拖动分隔条期间的透明捕获层（规格 §5.5.2）：预览区里的 iframe 会把
          pointermove 吃在自己的 document 里，鼠标划过预览时拖动就断了。
          这一层盖住整个视口，让指针事件始终留在宿主页面，拖动结束即卸载。 */}
      {workbenchDragging && <div className="splitter-capture" aria-hidden="true" />}

      {/* P2-12 命令面板（⌘K 命令 / ⌘P 文件快开 / ⌘⇧F 全文搜索） */}
      {palette && (
        <CommandPalette
          mode={palette}
          commands={commands}
          onOpenFile={openFileInWorkbench}
          onSelectSession={selectSession}
          onClose={() => setPalette(null)}
          sessionId={activeId}
        />
      )}

      <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-line bg-surface px-4 text-xs text-ink-3">
        <button
          type="button"
          onClick={toggleBottomPanel}
          title={bottomPanelOpen ? "收起终端（⌘J / Ctrl+J）" : "打开终端（⌘J / Ctrl+J）"}
          aria-label={bottomPanelOpen ? "收起终端" : "打开终端"}
          aria-keyshortcuts="Meta+J Control+J"
          className="flex h-6 w-6 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-strong"
        >
          <PanelBottom size={14} strokeWidth={1.55} aria-hidden="true" />
        </button>
        <span>终端</span>
        <span className="ml-auto font-mono">⌘J / Ctrl+J</span>
      </footer>
    </div>
  );
}
