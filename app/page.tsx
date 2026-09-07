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
import { readPref, writePref, clearPref } from "@/lib/prefs";
import { deriveTaskPresentation, previewableOf, type SessionStatus } from "@/lib/task-presentation";
import type { SessionInfo, SessionListItem, PermissionRequest, PermissionSettings, LecternEvent, ModelRef, ThinkingEffort, AuthStatus, SessionIsolation } from "@/lib/types";
import { PERMISSION_DOMAIN_OF } from "@/lib/types";

function statusLabel(status: string): string {
  switch (status) {
    case "running":
      return "运行中";
    case "waiting_permission":
      return "等待授权";
    case "waiting_input":
      return "等待输入";
    default:
      return "空闲";
  }
}

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

function VerticalSplitter({ label, value, min, max, direction, onReset, onChange }: { label: string; value: number; min: number; max: number; direction: 1 | -1; onReset?: () => void; onChange: (value: number) => void }) {
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
  }, [apply, direction]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { id: event.pointerId, x: event.clientX, value };
    setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  return <div role="separator" aria-orientation="vertical" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} tabIndex={0} data-dragging={dragging} title={onReset ? `${label}（双击复位）` : label} onPointerDown={onPointerDown} onDoubleClick={onReset} onKeyDown={(event) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); apply(value - direction * 16); }
    if (event.key === "ArrowRight") { event.preventDefault(); apply(value + direction * 16); }
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
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const [workbenchWidth, setWorkbenchWidth] = useState(384);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(1440);
  const [viewportHeight, setViewportHeight] = useState(900);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(260);
  const [bottomPanelOpen, setBottomPanelOpen] = useState(false);
  const [layoutReady, setLayoutReady] = useState(false);
  useEffect(() => {
    setSidebarWidth(readWidth("lectern:sidebar-width", 256, 200, 420));
    setWorkbenchWidth(readWidth("lectern:workbench-width", 384, 320, 720));
    setBottomPanelHeight(readWidth("lectern:bottom-panel-height", 260, 160, 640));
    setWorkbenchOpen(localStorage.getItem("lectern:workbench-open") === "1");
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
    localStorage.setItem("lectern:workbench-width", String(workbenchWidth));
    localStorage.setItem("lectern:workbench-open", workbenchOpen ? "1" : "0");
    localStorage.setItem("lectern:bottom-panel-height", String(bottomPanelHeight));
    localStorage.setItem("lectern:bottom-panel-open", bottomPanelOpen ? "1" : "0");
  }, [layoutReady, sidebarWidth, workbenchWidth, workbenchOpen, bottomPanelHeight, bottomPanelOpen]);
  useEffect(() => {
    const syncViewport = () => {
      setViewportWidth(window.innerWidth);
      setViewportHeight(window.innerHeight);
    };
    window.addEventListener("resize", syncViewport);
    return () => window.removeEventListener("resize", syncViewport);
  }, []);

  // 两侧宽度不会挤掉中间的可读对话区；窄屏由既有断点隐藏右栏。
  const sidebarMax = Math.max(200, Math.min(420, viewportWidth - (workbenchOpen ? workbenchWidth : 0) - 436));
  const workbenchMax = Math.max(320, Math.min(720, viewportWidth - (sidebarOpen ? sidebarWidth : 0) - 436));
  const bottomPanelMax = Math.max(160, viewportHeight - 280);
  useEffect(() => {
    setSidebarWidth((value) => Math.min(value, sidebarMax));
  }, [sidebarMax]);
  useEffect(() => {
    setWorkbenchWidth((value) => Math.min(value, workbenchMax));
  }, [workbenchMax]);
  useEffect(() => {
    setBottomPanelHeight((value) => Math.min(value, bottomPanelMax));
  }, [bottomPanelMax]);

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
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((value) => {
      writePref("sidebar", value ? "0" : "1");
      return !value;
    });
  }, []);
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
    void client.listSessions(true).then(ingestSessionList);
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
  }, [activeId, sessions]);

  useEffect(() => {
    const projector = projectorRef.current ?? (projectorRef.current = new ChatProjector());
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
    // 历史恢复与实时流的竞态防护（语义与旧 events 数组版一致）：
    // 订阅先建立（不丢事件），转录异步载入期间实时事件进 buffer；
    // 转录 ingest 完成后再合并 buffer——投影顺序仍是 历史→实时。
    let historyLoaded = false;
    const liveBuffer: LecternEvent[] = [];
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
    const unsub = client.subscribe(activeId, (ev) => {
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
      if (!historyLoaded) liveBuffer.push(ev);
      else {
        projector.ingest(ev);
        flushProjection();
      }
    }, setConnState);
    // 跨会话恢复：尾部分页拉取转录（首屏 50 条），逐条折叠进投影器
    client.getMessagesPage(activeId, 0).then((page) => {
      if (cancelled) return;
      loadedCountRef.current = page.messages.length;
      for (const ev of transcriptToEvents(page.messages)) projector.ingest(ev);
      historyLoaded = true;
      for (const ev of liveBuffer) projector.ingest(ev);
      setHasMore(page.hasMore);
      flushProjection();
    });
    return () => {
      cancelled = true;
      unsub();
    };
    // autoMode / permAuto 均经 ref 镜像读取，不列入依赖——否则切换档位或权限
    // 配置会整段重跑：断开重连 SSE、重置投影器、重拉历史转录。
  }, [activeId, flushProjection]);

  // 触顶加载更早历史：prepend 进投影器（不破坏已折叠的实时事件），视口锚定在 ChatView。
  // 投影按消息 id 幂等 upsert，SSE 重连的重放事件天然去重，无需额外标记。
  const [hasMore, setHasMore] = useState(false);
  const loadedCountRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const loadOlder = useCallback(async () => {
    const sid = activeId;
    if (!sid || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    try {
      const page = await client.getMessagesPage(sid, loadedCountRef.current);
      if (!page.messages.length) {
        setHasMore(false);
        return;
      }
      loadedCountRef.current += page.messages.length;
      projectorRef.current?.ingestBatch(transcriptToEvents(page.messages), true);
      setHasMore(page.hasMore);
      flushProjection();
    } catch {
      /* 拉取失败静默，下次触顶重试 */
    } finally {
      loadingOlderRef.current = false;
    }
  }, [activeId, flushProjection]);

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
      void client.listSessions(true).then(ingestSessionList).catch(() => undefined);
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
        const s = await client.createSession(activeAgent, undefined, isolateNew);
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
        await client.prompt(sid, text, activeAgent, selectedModel ?? undefined, images, effort, skill?.id, references, attachments);
      } catch (error) {
        setEcho(null); // 发送失败：撤回乐观气泡，错误经其它途径提示
        throw error;
      }
      // prompt 可能排队返回，刷新标题等元数据；AI 摘要标题异步落库，延迟再刷一次
      void client.listSessions(true).then(setSessions);
      setTimeout(() => void client.listSessions(true).then(setSessions), 4000);
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

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <header className="lectern-titlebar flex h-12 shrink-0 items-stretch">
        <div className="lectern-window-controls flex shrink-0 items-center gap-2 px-3" style={{ width: sidebarOpen ? sidebarWidth + 6 : inElectron && isMac ? 144 : 56 }}>
          <button type="button" onClick={toggleSidebar} title={sidebarOpen ? "收起会话栏" : "展开会话栏"} aria-label={sidebarOpen ? "收起会话栏" : "展开会话栏"} aria-expanded={sidebarOpen} className="titlebar-button">
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
              onClick={() => setWorkbenchOpen((value) => !value)}
              title={workbenchOpen ? "收起右侧工作区" : "展开右侧工作区"}
              aria-label={workbenchOpen ? "收起右侧工作区" : "展开右侧工作区"}
              className={cn(
                "hidden h-7 w-7 items-center justify-center rounded-sm transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-strong min-[1180px]:inline-flex",
                workbenchOpen ? "bg-surface-2 text-ink" : "text-ink-3",
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
        {sidebarOpen && (
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
          onAbortSession={(id) => void client.abort(id).then(() => client.listSessions(true).then(ingestSessionList))}
        />
        )}
        {sidebarOpen && <VerticalSplitter label="调整会话栏宽度" value={sidebarWidth} min={200} max={sidebarMax} direction={1} onReset={() => setSidebarWidth(256)} onChange={setSidebarWidth} />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1">
            <ChatView
              data={chatData}
              hasMore={hasMore}
              onLoadMore={() => void loadOlder()}
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
              onOpenFile={(path, line) => setOpenFileReq({ path, ts: Date.now(), line })}
              echo={echo}
              wtNotice={wtNotice}
              onRewind={handleRewind}
              permissionMode={permissionMode}
              onCyclePermissionMode={activeId ? cyclePermissionMode : undefined}
            />
            {workbenchOpen && (
              <div className="hidden min-[1180px]:contents">
                <VerticalSplitter label="调整右侧工作区宽度" value={workbenchWidth} min={320} max={workbenchMax} direction={-1} onReset={() => setWorkbenchWidth(384)} onChange={setWorkbenchWidth} />
                <div className="shrink-0" style={{ width: workbenchWidth }}>
                  <WorkbenchPanel key={activeId ?? "new-task"} sessionId={activeId} openRequest={openFileReq} editedPaths={chatData.editedPaths} summary={chatData.summary} />
                </div>
              </div>
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

      {/* P2-12 命令面板（⌘K 命令 / ⌘P 文件快开 / ⌘⇧F 全文搜索） */}
      {palette && (
        <CommandPalette
          mode={palette}
          commands={commands}
          onOpenFile={(path, line) => setOpenFileReq({ path, ts: Date.now(), line })}
          onSelectSession={selectSession}
          onClose={() => setPalette(null)}
          sessionId={activeId}
        />
      )}

      {/* 底部状态栏：低调一行 */}
      <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-line bg-surface px-4 text-[0.6875rem] text-ink-3">
        <span className={`h-1.5 w-1.5 rounded-full ${status === "running" ? "animate-pulse bg-live" : "bg-ink-3"}`} />
        <span>{statusLabel(status)}</span>
        <button
          type="button"
          onClick={toggleBottomPanel}
          title={bottomPanelOpen ? "收起终端（⌘J / Ctrl+J）" : "打开终端（⌘J / Ctrl+J）"}
          aria-label={bottomPanelOpen ? "收起终端" : "打开终端"}
          aria-keyshortcuts="Meta+J Control+J"
          className="flex h-5 w-5 items-center justify-center rounded-sm text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-strong"
        >
          <PanelBottom size={14} strokeWidth={1.55} aria-hidden="true" />
        </button>
        <span className="text-line-strong">·</span>
        <span className="font-mono">
          model: {modelLabel}
          {selectedModel ? "（本会话消息覆盖）" : ""}
        </span>
      </footer>
    </div>
  );
}
