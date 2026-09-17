"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SquareTerminal } from "lucide-react";
import { cn } from "@zmzai/theme";

import { client } from "@/lib/client";
import type { ShellCandidate, TerminalReadAllResult } from "@/lib/types";
import "@xterm/xterm/css/xterm.css";

/** VSCode Dark+ 终端配色。 */
const VSC_THEME = {
  background: "#1e1e22",
  foreground: "#cccccc",
  cursor: "#cccccc",
  cursorAccent: "#1d1d1d",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e513",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
} as const;

type XTerm = InstanceType<Awaited<ReturnType<typeof loadXterm>>["Terminal"]>;
type FitAddonInstance = InstanceType<Awaited<ReturnType<typeof loadXterm>>["FitAddon"]>;

async function loadXterm() {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);
  return { Terminal, FitAddon };
}

/**
 * 单个会话的本地镜像：buffer 与 cursor 维持着 xterm 内容的真实副本，
 * 切 tab 时切换 buffer 来重建——单 xterm 实例 + 多会话历史快照。
 */
type Sess = {
  id: string;
  name: string;
  /** 底层 shell 名（zsh/bash/fish/pwsh），用于同 shell 多开时的序号编排。 */
  shell: string;
  /** shell 可执行文件绝对路径，tab 悬停时展示，便于确认用的是哪一个。 */
  shellFile?: string;
  status: "running" | "exited" | "killed" | "boot";
  /** 累计输出（含 ANSI 颜色），与 xterm 实际显示始终同步。 */
  buffer: string;
  /** 服务端 read 游标。 */
  cursor: number;
};

/**
 * 终端面板（VSCode 式 + 多 shell tab）：
 * - 单 xterm 实例承载当前激活会话；其他会话用 buffer 快照缓存，切换时回放。
 * - 头部 "N 个终端 [+ ⌄]" —— 对齐 VSCode；tab 行每个会话一个 chip：图标 + 名 + ×。
 * - 起的是**系统默认 shell**（$SHELL → /etc/passwd → 常见路径兜底），不写死 zsh：
 *   用户装了 zsh 就是 zsh，只有 bash 就是 bash，Windows 退到 pwsh/PowerShell/cmd。
 *   shell 解析在服务端 lib/shell.ts，面板只拿到探测结果。
 * - pty 后端：交互 shell 常驻；pipe 后端（无 node-pty）降级为「输入一行跑一条命令」。
 */
export default function TerminalPane({
  sessionId,
  trailing,
}: {
  sessionId?: string | null;
  /** tab 行右侧追加动作（DebugArea 注入 collapse 按钮等）。 */
  trailing?: ReactNode;
}) {
  const [backend, setBackend] = useState<"pty" | "pipe">("pty");
  const [sessions, setSessions] = useState<Sess[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [shells, setShells] = useState<ShellCandidate[]>([]);
  const [defaultShell, setDefaultShell] = useState<ShellCandidate | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shellMenuPosition, setShellMenuPosition] = useState<{ left: number; top: number } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddonInstance | null>(null);
  const sessionsRef = useRef<Sess[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const defaultShellRef = useRef<ShellCandidate | null>(null);
  const backendRef = useRef<"pty" | "pipe">("pty");
  const streamRef = useRef<EventSource | null>(null);
  /** 关流句柄（重连 timer 清理等）；startStream 赋值，stopStream 调用。 */
  const streamStopRef = useRef<(() => void) | null>(null);
  const obsRef = useRef<ResizeObserver | null>(null);
  const lineBufRef = useRef(""); // pipe 模式输入缓冲
  const shellMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuedResizeRef = useRef<{ id: string; cols: number; rows: number } | null>(null);
  const appliedResizeRef = useRef(new Map<string, string>());
  /** 容器上一次的真实像素尺寸：只有跨越取整阈值（cols/rows 变化）才值得 fit + 同步。 */
  const lastBoxRef = useRef<{ w: number; h: number } | null>(null);
  /** 上一次 fit 得到的网格：onResize 只在网格真的变化时才入队（防浮点取整抖动）。 */
  const lastFitRef = useRef<{ cols: number; rows: number } | null>(null);

  useEffect(() => {
    defaultShellRef.current = defaultShell;
  }, [defaultShell]);
  // onData 回调只在挂载时注册一次，backend 必须走 ref 才能读到探测结果
  useEffect(() => {
    backendRef.current = backend;
  }, [backend]);

  // 把 React state 同步到 ref（轮询循环只读 ref，避免闭包陈旧）
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // Shell 菜单走 portal，不能挂在可横向滚动的 tab 容器内：后者会裁掉浮层，且
  // 原先叠在「+」上的 12px 绝对定位热区也很难准确点击。
  const toggleShellMenu = useCallback(() => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const rect = shellMenuTriggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setShellMenuPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 208)),
      top: rect.bottom + 4,
    });
    setMenuOpen(true);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const reposition = () => setMenuOpen(false);
    window.addEventListener("keydown", close);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [menuOpen]);

  const stopStream = useCallback(() => {
    streamStopRef.current?.();
    streamStopRef.current = null;
  }, []);

  /**
   * xterm 在隐藏、展开和拖动布局的中间帧会短暂报告 0 行/列，并可能连续触发多次。
   * 只同步有效的 PTY 网格，按最终尺寸合并，避免把布局噪声变成服务端请求。
   * 去重以「已确认同步到服务端」的尺寸为准：相同尺寸绝不重发；抖动期间靠
   * 较长的 debounce 只收敛到最后一次稳定尺寸。
   */
  const queueResize = useCallback((id: string, cols: number, rows: number) => {
    if (backendRef.current !== "pty" || cols < 20 || cols > 500 || rows < 5 || rows > 200) return;
    const size = `${cols}x${rows}`;
    if (appliedResizeRef.current.get(id) === size) return;
    const queued = queuedResizeRef.current;
    if (queued?.id === id && queued.cols === cols && queued.rows === rows) return;
    queuedResizeRef.current = { id, cols, rows };
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      resizeTimerRef.current = null;
      const next = queuedResizeRef.current;
      queuedResizeRef.current = null;
      if (!next) return;
      const nextSize = `${next.cols}x${next.rows}`;
      if (appliedResizeRef.current.get(next.id) === nextSize) return;
      void client.terminalResize(next.id, next.cols, next.rows)
        .then(({ ok }) => {
          if (ok) appliedResizeRef.current.set(next.id, nextSize);
        })
        .catch(() => undefined);
    }, 250);
  }, []);

  /**
   * 起一条交互式 shell 会话并加入列表。
   * 不传 shell 时服务端用系统默认 shell；tab 名 = 「shell 名 + 同名序号」，
   * 同名多开时读作 zsh 1 / zsh 2，混开时读作 zsh 1 / bash 1。
   */
  const newSession = useCallback(async (shellFile?: string) => {
    try {
      const s = await client.terminalStartShell(shellFile, sessionId, {
        cols: termRef.current?.cols ?? 120,
        rows: termRef.current?.rows ?? 30,
      });
      const label = (s.name?.trim().replace(/^lectern:[^:]+:/, "")) || defaultShellRef.current?.label || "shell";
      const file = shellFile ?? defaultShellRef.current?.file;
      const seq = sessionsRef.current.filter((x) => x.shell === label).length + 1;
      const sess: Sess = {
        id: s.id,
        name: `${label} ${seq}`,
        shell: label,
        ...(file ? { shellFile: file } : {}),
        status: (s.status as Sess["status"]) ?? "running",
        buffer: "",
        cursor: 0,
      };
      setSessions((prev) => [...prev, sess]);
      setActiveId(s.id);
      return sess.id;
    } catch (err) {
      termRef.current?.write(
        `\r\n\x1b[31m[启动失败：${err instanceof Error ? err.message : "未知错误"}]\x1b[0m\r\n`,
      );
      return null;
    }
  }, [sessionId]);

  /** 关闭会话：发 DELETE 回收子进程，从列表移除；若是当前激活会话则切到邻居。 */
  const killSession = useCallback(async (id: string) => {
    const list = sessionsRef.current;
    const idx = list.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const s = list[idx];
    void client.terminalKill(id).catch(() => undefined);
    setSessions((prev) => prev.filter((x) => x.id !== id));
    if (activeIdRef.current === id) {
      const next = list[idx + 1] ?? list[idx - 1] ?? null;
      setActiveId(next ? next.id : null);
    }
  }, []);

  // ⌘W 的区域级语义：只回收当前活跃 PTY；绝不触及 Electron 主窗口。
  useEffect(() => {
    const closeActiveTerminal = () => {
      const id = activeIdRef.current;
      if (id) void killSession(id);
    };
    window.addEventListener("lectern:close-active-terminal", closeActiveTerminal);
    return () => window.removeEventListener("lectern:close-active-terminal", closeActiveTerminal);
  }, [killSession]);

  /** 切换激活会话：xterm.reset() 清屏并写入新会话 buffer。 */
  const switchSession = useCallback((id: string) => {
    if (id === activeIdRef.current) return;
    const target = sessionsRef.current.find((s) => s.id === id);
    if (!target) return;
    termRef.current?.reset();
    if (target.buffer) termRef.current?.write(target.buffer);
    setActiveId(id);
    const term = termRef.current;
    if (term) queueResize(id, term.cols, term.rows);
  }, [queueResize]);

  // SSE 流替代 HTTP 轮询（治本）：一条 EventSource 长连接，服务端进程内自适应
  // 检查增量并推送（无请求日志、无 JSON 开销）。断线手动重连——EventSource 的
  // 自动重连会复用连接时的旧游标导致重复输出，重连必须带最新游标。
  const startStream = useCallback(() => {
    stopStream();
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed) return;
      const cursors: Record<string, number> = {};
      for (const s of sessionsRef.current) cursors[s.id] = s.cursor;
      const es = new EventSource(`/api/terminal/stream?cursors=${encodeURIComponent(JSON.stringify(cursors))}`);
      streamRef.current = es;

      es.onmessage = (ev) => {
        let batch: TerminalReadAllResult;
        try {
          batch = JSON.parse(ev.data) as TerminalReadAllResult;
        } catch {
          return;
        }
        const active = activeIdRef.current;
        let statusChanged = false;

        for (const chunk of batch.sessions) {
          const s = sessionsRef.current.find((e) => e.id === chunk.id);
          if (!s) {
            // 流里出现未知会话（另一端新建 / 与 newSession 竞态）：拉历史后补进列表
            const label = (chunk.name ?? chunk.id).replace(/^lectern:[^:]+:/, "");
            void client
              .terminalRead(chunk.id, 0)
              .catch(() => ({ output: "", cursor: 0 }))
              .then((c) => {
                if (sessionsRef.current.some((e) => e.id === chunk.id)) return; // 已被 newSession 等路径加入
                const seen = new Map<string, number>();
                for (const e of sessionsRef.current) seen.set(e.shell, (seen.get(e.shell) ?? 0) + 1);
                const n = (seen.get(label) ?? 0) + 1;
                const next: Sess = {
                  id: chunk.id,
                  name: `${label} ${n}`,
                  shell: label,
                  status: (chunk.status as Sess["status"]) ?? "running",
                  buffer: c.output,
                  cursor: c.cursor,
                };
                sessionsRef.current = [...sessionsRef.current, next];
                setSessions((prev) => [...prev, next]);
              });
            continue;
          }
          s.cursor = chunk.cursor;
          if (chunk.output) {
            s.buffer += chunk.output;
            if (s.id === active) termRef.current?.write(chunk.output);
          }
          const next = chunk.status as Sess["status"];
          if (next !== s.status) {
            s.status = next;
            statusChanged = true;
            if (next !== "running" && s.id === active) {
              termRef.current?.write("\r\n\x1b[90m[进程已退出]\x1b[0m\r\n");
            }
          }
        }

        // 会话在服务端消失（达到上限被回收等）：同步移除 tab
        if (batch.missing.length > 0) {
          sessionsRef.current = sessionsRef.current.filter((e) => !batch.missing.includes(e.id));
          statusChanged = true;
          if (batch.missing.includes(active ?? "")) {
            const fallback = sessionsRef.current[sessionsRef.current.length - 1] ?? null;
            setActiveId(fallback ? fallback.id : null);
          }
        }

        // 只有状态点/tab 列表变化才需要 re-render（buffer/cursor 不影响列表 UI）
        if (statusChanged) setSessions((prev) => prev.slice());
      };

      es.onerror = () => {
        es.close();
        streamRef.current = null;
        if (disposed) return;
        retryTimer = setTimeout(connect, 1000); // 带最新游标重连，无缺口续传
      };
    };

    connect();
    streamStopRef.current = () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      streamRef.current?.close();
      streamRef.current = null;
      streamStopRef.current = null;
    };
  }, [stopStream]);

  // 挂载：建 xterm + 输入接线 + 自适应 + 拉取/补建会话 + 启动轮询
  useEffect(() => {
    let disposed = false;
    (async () => {
      const { Terminal, FitAddon } = await loadXterm();
      if (disposed || !containerRef.current) return;
      const term = new Terminal({
        fontSize: 13,
        fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Code", monospace',
        lineHeight: 1.3,
        cursorBlink: true,
        convertEol: false,
        scrollback: 5000,
        theme: VSC_THEME,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      fit.fit();
      termRef.current = term;
      fitRef.current = fit;

      // 键盘输入：pipe 降级为「逐行缓冲 + Enter 提交」——降级态本来就没有常驻
      // 会话，所以 pipe 分支不要求活跃会话，首条命令也能直接提交；
      // pty 把按键透传给激活会话。backend 走 ref（回调只在挂载注册一次）。
      term.onData((d) => {
        if (backendRef.current === "pipe") {
          if (d === "\r") {
            const cmd = lineBufRef.current.trim();
            lineBufRef.current = "";
            if (!cmd) {
              term.write("\r\n\x1b[90m$\x1b[0m ");
              return;
            }
            term.write("\r\n");
            (async () => {
              try {
                const s = await client.terminalStart(cmd);
                const next: Sess = {
                  id: s.id,
                  name: cmd.slice(0, 30),
                  shell: defaultShellRef.current?.label ?? "shell",
                  status: "running",
                  buffer: "",
                  cursor: 0,
                };
                setSessions((prev) => [...prev, next]);
                setActiveId(s.id);
                sessionsRef.current = [...sessionsRef.current, next];
              } catch (err) {
                term.write(
                  `\r\n\x1b[31m[启动失败：${err instanceof Error ? err.message : "未知错误"}]\x1b[0m\r\n`,
                );
              }
            })();
          } else if (d === "\x7f") {
            if (lineBufRef.current.length > 0) {
              lineBufRef.current = lineBufRef.current.slice(0, -1);
              term.write("\b \b");
            }
          } else if (d >= " ") {
            lineBufRef.current += d;
            term.write(d);
          }
          return;
        }
        // pty：需要活跃会话才透传
        const active = activeIdRef.current;
        const list = sessionsRef.current;
        const sess = list.find((s) => s.id === active) ?? null;
        if (!sess || sess.status !== "running") {
          if (d === "\r") term.write("\r\n");
          return;
        }
        void client.terminalInput(sess.id, d).catch(() => undefined);
      });

      // 自适应尺寸：只在容器像素尺寸真的变化时才 fit。xterm 的 fit 会改 cols/rows，
      // 触发 onResize；若每次 ResizeObserver fire（内容回流、滚动条、300ms 轮询的
      // re-render）都无脑 fit，就会在取整边界抖动出不同 cols/rows，突破去重 → resize 请求刷屏。
      const obs = new ResizeObserver(() => {
        const el = containerRef.current;
        if (!el) return;
        const box = el.getBoundingClientRect();
        const prev = lastBoxRef.current;
        // 首次（尚无基准）或尺寸变化超过 1px 才 fit；微小抖动直接忽略
        if (prev && Math.abs(prev.w - box.width) < 1 && Math.abs(prev.h - box.height) < 1) return;
        lastBoxRef.current = { w: box.width, h: box.height };
        try {
          fit.fit();
        } catch {
          /* 容器不可见时 fit 会抛 */
        }
      });
      obs.observe(containerRef.current);
      obsRef.current = obs;
      term.onResize(({ cols, rows }) => {
        // fit 的浮点取整可能在相邻整数间抖动（如 86↔87 行）：网格没真变就不入队
        const lastFit = lastFitRef.current;
        if (lastFit && lastFit.cols === cols && lastFit.rows === rows) return;
        lastFitRef.current = { cols, rows };
        const active = activeIdRef.current;
        if (active) queueResize(active, cols, rows);
      });

      // 探测后端 + 系统 shell，然后补建/同步会话（重载时拉历史输出，避免黑屏）
      try {
        const probe = await client.terminalList(sessionId);
        if (disposed) return;
        setBackend(probe.backendKind);
        backendRef.current = probe.backendKind;
        setShells(probe.shells ?? []);
        setDefaultShell(probe.defaultShell ?? null);
        defaultShellRef.current = probe.defaultShell ?? null;

        // pipe 后端没有 TTY，交互 shell 没法用（无回显/无行编辑），
        // 降级成「输入一行跑一条命令」，不给用户开一个看不见的 shell。
        if (probe.backendKind === "pipe") {
          term.write(
            `\x1b[90m Lectern 终端（管道模式）：无 PTY，交互 shell 不可用，每行回车即执行一条命令\x1b[0m\r\n\x1b[32m$\x1b[0m `,
          );
          startStream();
          return;
        }

        const live = probe.sessions.filter((e) => e.status === "running");
        if (live.length === 0) {
          await newSession();
        } else {
          // 并行回放历史：每个会话从 cursor=0 拉一遍把 buffer 填上，再激活首个
          const mirrored: Sess[] = await Promise.all(
            live.map(async (e) => {
              const label = e.name?.trim() || probe.defaultShell?.label || "shell";
              try {
                const c = await client.terminalRead(e.id, 0);
                return {
                  id: e.id,
                  name: label.replace(/^lectern:[^:]+:/, ""),
                  shell: label,
                  status: "running" as const,
                  buffer: c.output,
                  cursor: c.cursor,
                };
              } catch {
                return {
                  id: e.id,
                  name: label,
                  shell: label,
                  status: "running" as const,
                  buffer: "",
                  cursor: 0,
                };
              }
            }),
          );
          if (disposed) return;
          // 同名会话按出现顺序编号（zsh 1 / zsh 2），否则重载回来全叫 zsh
          const seen = new Map<string, number>();
          const numbered = mirrored.map((m) => {
            const n = (seen.get(m.shell) ?? 0) + 1;
            seen.set(m.shell, n);
            return { ...m, name: `${m.shell} ${n}` };
          });
          setSessions(numbered);
          setActiveId(numbered[0]?.id ?? null);
          // 立刻把首个会话的 buffer 写到 xterm（switchSession 只处理非激活态变更）
          if (numbered[0]?.buffer) term.write(numbered[0]?.buffer);
        }
      } catch {
        term.write("\x1b[31m[终端服务不可达]\x1b[0m\r\n");
        return;
      }

      startStream();
    })();
    return () => {
      disposed = true;
      obsRef.current?.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
      queuedResizeRef.current = null;
      lastBoxRef.current = null;
      lastFitRef.current = null;
      // 终端属于当前任务而非 React 组件；右栏收起、会话切换或重载都不应杀掉
      // 用户正在运行的 shell。显式关闭 tab 才会结束对应进程。
      stopStream();
      termRef.current?.dispose();
      termRef.current = null;
    };
    // The terminal owner session is intentionally the remount boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const activeSess = sessions.find((s) => s.id === activeId) ?? null;

  const iconBtn =
    "flex h-7 w-7 items-center justify-center rounded-md text-[#b8b8bd] transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7797e8]";

  return (
    <div data-terminal-pane className="flex min-h-0 flex-1 flex-col bg-[#1e1e22] text-[#d4d4d4]">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-white/10 px-2">
        <span className="px-2 text-xs font-semibold tracking-wide text-[#b8b8bd]">终端</span>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="终端">
          {sessions.map((s) => {
            const isActive = s.id === activeId;
            return (
              <div
                key={s.id}
                className={cn(
                  "group inline-flex h-6.5 shrink-0 items-center rounded-[5px] text-xs transition-colors",
                  isActive ? "bg-[#2d2d32] text-white" : "text-[#aaaab0] hover:bg-white/5 hover:text-[#e7e7e7]",
                )}
                title={s.shellFile ? `${s.name} · ${s.shellFile}` : s.id}
              >
                <button type="button" role="tab" aria-selected={isActive} onClick={() => switchSession(s.id)} className="inline-flex h-full items-center gap-1.5 pl-2 focus-visible:outline-none">
                  <span className={cn("h-1 w-1 shrink-0 rounded-full", s.status === "running" ? "bg-[#23d18b]" : "bg-[#717178]")} />
                  <SquareTerminal size={13} strokeWidth={1.55} aria-hidden="true" className="shrink-0" />
                  <span className="max-w-36 truncate">{s.name}</span>
                </button>
                <button type="button" title={`关闭 ${s.name}`} onClick={() => void killSession(s.id)} className="mr-1 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-[3px] text-[#aaaab0] opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" /></svg>
                </button>
              </div>
            );
          })}
          {backend === "pty" && (
            <div className="flex shrink-0 items-center rounded-[4px] focus-within:ring-2 focus-within:ring-[#7797e8]">
              <button type="button" title={`新建终端（${defaultShell?.label ?? "系统 shell"}）`} onClick={() => void newSession()} className={iconBtn}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M8 2.5v11M2.5 8h11" strokeLinecap="round" /></svg>
              </button>
              {shells.length > 1 && (
                <button
                  ref={shellMenuTriggerRef}
                  type="button"
                  title="选择 shell 新建终端"
                  aria-label="选择 shell 新建终端"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={toggleShellMenu}
                  className="flex h-6.5 w-5 items-center justify-center rounded-[4px] text-[#aaaab0] transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none"
                >
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              )}
            </div>
          )}
        </div>
        <div className="ml-1 flex shrink-0 items-center border-l border-white/10 pl-1">
          {backend === "pipe" && <span className="px-1 text-[0.625rem] text-[#8f8f95]">管道模式</span>}
          <button type="button" title="清屏" onClick={() => termRef.current?.clear()} className={iconBtn}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M3 4h10M5.5 4V2.5h5V4M5 6l.6 7h4.8l.6-7" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
          <button type="button" title="重启当前终端" onClick={() => void (async () => { if (!activeSess) return; await killSession(activeSess.id); await newSession(); })()} className={iconBtn}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M13 8a5 5 0 1 1-1.5-3.55M13 2.5v3h-3" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
          {trailing}
        </div>
      </div>

      <div ref={containerRef} className="min-h-0 flex-1 px-3 py-2" />
      {menuOpen && shellMenuPosition && createPortal(
        <>
          <div className="fixed inset-0 z-[70]" aria-hidden="true" onPointerDown={() => setMenuOpen(false)} />
          <div
            role="menu"
            aria-label="选择 shell"
            className="fixed z-[71] w-52 overflow-hidden rounded-[5px] border border-white/10 bg-[#252526] py-1 shadow-xl"
            style={shellMenuPosition}
          >
            {shells.map((sh) => (
              <button
                key={sh.file}
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  void newSession(sh.file);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[#d4d4d4] hover:bg-[#094771] focus:bg-[#094771] focus:outline-none"
              >
                <span>{sh.label}</span>
                <span className="ml-auto max-w-28 truncate text-[#999]">{sh.file}</span>
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
