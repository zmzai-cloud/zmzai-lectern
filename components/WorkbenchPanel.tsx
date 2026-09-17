"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown, cn } from "@zmzai/theme";

import { client } from "@/lib/client";
import { isPreviewable } from "@/lib/task-presentation";
import type { WorkbenchTab } from "@/lib/task-layout";
import type { SessionSummary } from "@/lib/types";
import CanvasPane from "./CanvasPane";
import FileEditor from "./FileEditor";
import FileTree from "./FileTree";
import ReviewPane from "./ReviewPane";

/** 顶部 tab：终端不再单独占位，常驻底部面板。 */
type Tab = WorkbenchTab;

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  {
    key: "review",
    label: "审查",
    icon: (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M2.5 8s2-4 5.5-4 5.5 4 5.5 4-2 4-5.5 4S2.5 8 2.5 8z" strokeLinejoin="round" />
        <circle cx="8" cy="8" r="1.6" />
      </svg>
    ),
  },
  {
    key: "files",
    label: "文件",
    icon: (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M3 2.5h7l3 3v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" strokeLinejoin="round" />
        <path d="M10 2.5v3h3" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: "preview",
    label: "成果预览",
    icon: (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="1.5" y="2.5" width="13" height="10" rx="1.2" />
        <path d="M5.5 15h5M8 12.5V15" strokeLinecap="round" />
      </svg>
    ),
  },
];

/** 文件 Tab 栈的单个标签（F1：多文件并行查看，LRU 上限 8）。 */
type FileTab = { path: string; content: string; size: number };

const MAX_FILE_TABS = 8;

const FILE_TREE_WIDTH_KEY = "lectern:file-tree-width";

function isMarkdown(path: string): boolean {
  return /\.mdx?$/i.test(path);
}

/**
 * 产物侧工作台（VS Code 风格）：
 *  ┌──────────────────────────────────────────────┐
 *  │ 顶部 tab：[审查][文件][成果预览]（一级 tab）   │
 *  ├──────────┬───────────────────────────────────┤
 *  │ FileTree │   内容区（preview/review/files）   │
 *  └──────────┴───────────────────────────────────┘
 * 「预览打开」把文件 Tab 的 HTML 产物送进成果预览；openRequest 是外部联动
 * （消息内路径点击 / ⌘P 文件快开 / 工具卡路径）请求打开某个文件（可带行号）。
 */
export default function WorkbenchPanel({
  openRequest,
  editedPaths,
  sessionId,
  summary,
  initialTab = "review",
  initialTabExplicit = false,
  onTabChange,
}: {
  openRequest?: { path: string; ts: number; line?: number } | null;
  /** 本轮 Agent 触碰过的文件（file.edited 投影，最新在前）——文件 Tab 顶部 chips + Git 高亮。 */
  editedPaths?: string[];
  sessionId?: string | null;
  /** 任务终态小结（session.summary，N5）：透传给 ReviewPane 渲染任务内变更摘要（§V3-1）。 */
  summary?: SessionSummary | null;
  initialTab?: WorkbenchTab;
  initialTabExplicit?: boolean;
  onTabChange?: (tab: WorkbenchTab, explicit: boolean) => void;
}) {
  const [tab, setTabState] = useState<Tab>(initialTab);
  const [fileTabs, setFileTabs] = useState<FileTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [fileView, setFileView] = useState<"source" | "preview">("source");
  /** 未保存草稿留在 WorkbenchPanel：切 tab / 切 Markdown 预览都不丢。 */
  const [fileDrafts, setFileDrafts] = useState<Record<string, string>>({});
  const [canvasPath, setCanvasPath] = useState<string | null>(null);
  // 用户手动离开的那条 preview 产物路径（而非「永久锁定」）：只抑制同一条产物
  // 的重复推荐，新一轮 run 产生的新 HTML 产物仍可自动推荐。跨会话由组件 key 重置。
  const suppressedPreviewPath = useRef<string | null>(null);
  const canvasPathRef = useRef<string | null>(null);
  // 用户是否在本任务里显式选过 tab（automatic/user 契约）：显式选择后不再自动切换。
  // 与 suppressedPreviewPath 的区别：后者只抑制「同一条产物路径」的重复推荐，
  // 前者一旦为真，本任务内所有自动推荐都停手（§7.4 / §7.5「if the user has not
  // explicitly selected a workbench tab in this task」）。
  const userChoseTab = useRef(initialTabExplicit);
  const loadSeq = useRef(0);

  const setTab = useCallback((next: Tab, explicit = false) => {
    setTabState(next);
    onTabChange?.(next, explicit);
  }, [onTabChange]);

  // 同步 canvasPath 到 ref，供 openFile 回调读取最新值而不引入依赖
  useEffect(() => {
    canvasPathRef.current = canvasPath;
  }, [canvasPath]);

  // 文件树列宽（VSCode 默认 ~240）
  const [treeWidth, setTreeWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 200;
    try {
      const v = window.localStorage.getItem(FILE_TREE_WIDTH_KEY);
      const n = v ? parseInt(v, 10) : NaN;
      return Number.isFinite(n) && n >= 140 && n <= 480 ? n : 200;
    } catch {
      return 200;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(FILE_TREE_WIDTH_KEY, String(treeWidth));
    } catch {
      /* 忽略 */
    }
  }, [treeWidth]);

  const treeDragRef = useRef<{ x: number; w: number } | null>(null);
  const onTreeDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    treeDragRef.current = { x: e.clientX, w: treeWidth };
    const onMove = (e: MouseEvent) => {
      const start = treeDragRef.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      setTreeWidth(Math.min(480, Math.max(140, start.w + dx)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      treeDragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const activeFile = fileTabs.find((t) => t.path === activePath) ?? null;
  const activeContent = activeFile ? fileDrafts[activeFile.path] ?? activeFile.content : "";
  const activeDirty = activeFile ? activeContent !== activeFile.content : false;

  // 外部联动：打开指定文件（切到文件 Tab、LRU 入栈并激活；line 用于锚点滚动）
  const [anchorLine, setAnchorLine] = useState<number | undefined>(undefined);
  const openFile = useCallback((path: string, line?: number) => {
    const seq = ++loadSeq.current;
    // 用户主动打开文件（消息内路径点击 / 文件树 / ⌘P）→ 视为显式选择
    userChoseTab.current = true;
    setTab("files", true);
    setFileView(isMarkdown(path) && !line ? "preview" : "source");
    setAnchorLine(line);
    setActivePath(path);
    // 用户主动打开文件时，抑制当前 preview 产物再抢焦点（用户想看的是文件）
    if (canvasPathRef.current) suppressedPreviewPath.current = canvasPathRef.current;
    void client
      .fsFile(path, sessionId)
      .then((f) => {
        if (seq !== loadSeq.current) return;
        setFileTabs((prev) => {
          const idx = prev.findIndex((t) => t.path === f.path);
          const kept = prev.filter((t) => t.path !== f.path);
          kept.unshift({ path: f.path, content: f.content, size: f.size });
          const next = kept.slice(0, MAX_FILE_TABS);
          setActivePath((cur) => (next.some((t) => t.path === cur) ? cur : (next[Math.min(idx, next.length - 1)]?.path ?? null)));
          return next;
        });
        if (isPreviewable(f.path)) setCanvasPath(f.path);
      })
      .catch((err: Error) => {
        if (seq !== loadSeq.current) return;
        setFileTabs((prev) => {
          const next = prev.filter((t) => t.path !== path);
          next.unshift({ path, content: `无法预览：${err.message}`, size: 0 });
          return next.slice(0, MAX_FILE_TABS);
        });
      });
  }, [sessionId]);

  // 自动推荐（automatic 侧）：产物 → 成果预览（§7.5）；无可预览产物但有首个编辑 → 审查（§7.4）。
  // 用户已显式选过 tab 则完全停手；只抑制单条产物路径的场景由 suppressedPreviewPath 负责。
  useEffect(() => {
    const latestPreview = editedPaths?.find(isPreviewable);
    if (latestPreview) {
      // 用共享判定而非就地正则：此前这里写的是 `/\.html?$/i`，漏了 `.htm`，
      // 导致 .htm 产物不会被自动推荐（与「成果预览」的真实能力不一致）。
      setCanvasPath(latestPreview);
      if (!userChoseTab.current && suppressedPreviewPath.current !== latestPreview) {
        setTab("preview");
      }
      return;
    }
    if (!userChoseTab.current && editedPaths && editedPaths.length > 0) setTab("review");
  }, [editedPaths]);

  useEffect(() => {
    if (!openRequest) return;
    openFile(openRequest.path, openRequest.line);
  }, [openRequest, openFile]);

  const closeTab = (path: string) => {
    const tabToClose = fileTabs.find((t) => t.path === path);
    const draft = tabToClose ? fileDrafts[path] : undefined;
    if (tabToClose && draft != null && draft !== tabToClose.content && !window.confirm(`“${path.split("/").pop()}”有未保存的修改，仍要关闭吗？`)) return;
    setFileTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path);
      const next = prev.filter((t) => t.path !== path);
      if (path === activePath) setActivePath(next[Math.min(idx, next.length - 1)]?.path ?? null);
      return next;
    });
    setFileDrafts((prev) => {
      const { [path]: _discarded, ...next } = prev;
      return next;
    });
  };

  const select = (t: Tab) => {
    // 用户点击 tab = 显式选择，本任务内不再自动切换（automatic/user 契约）
    userChoseTab.current = true;
    // 用户切走 preview 时，记录当前 preview 路径以抑制其重复抢焦点
    if (t !== "preview" && tab === "preview" && canvasPath) {
      suppressedPreviewPath.current = canvasPath;
    }
    setTab(t, true);
  };

  const activeIsHtml = activeFile ? isPreviewable(activeFile.path) : false;
  const activeIsMarkdown = activeFile ? isMarkdown(activeFile.path) : false;

  const saveDraft = (path: string, content: string, size: number) => {
    setFileTabs((prev) => prev.map((file) => (file.path === path ? { ...file, content, size } : file)));
    setFileDrafts((prev) => {
      const { [path]: _saved, ...next } = prev;
      return next;
    });
  };

  // 预览/编辑区：根据 active tab 决定渲染内容
  const renderPreview = () => {
    switch (tab) {
        case "files":
          return activeFile ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-1.5">
                {fileTabs.map((t) => (
                  <button
                    key={t.path}
                    type="button"
                    onClick={() => {
                      setActivePath(t.path);
                      setFileView(isMarkdown(t.path) ? "preview" : "source");
                      setAnchorLine(undefined);
                    }}
                    title={t.path}
                    className={cn(
                      "group flex max-w-44 shrink-0 items-center gap-1 rounded-sm px-2 py-1 text-left font-mono text-[0.6875rem] transition-colors",
                      t.path === activePath ? "bg-selected text-ink" : "text-ink-3 hover:bg-surface-3 hover:text-ink",
                    )}
                  >
                    {fileDrafts[t.path] != null && fileDrafts[t.path] !== t.content && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-label="未保存" />
                    )}
                    <span className="truncate">{t.path.split("/").pop()}</span>
                    <span
                      role="button"
                      tabIndex={-1}
                      title="关闭"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(t.path);
                      }}
                      className="hidden shrink-0 text-ink-3 hover:text-danger group-hover:block"
                    >
                      ✕
                    </span>
                  </button>
                ))}
              </div>
              <div className="wb-bar-sm">
                <span className="truncate font-mono text-[0.6875rem] text-ink-2" title={activeFile.path}>
                  {activeFile.path}
                </span>
                <span className="ml-auto shrink-0 text-[0.625rem] text-ink-3">
                  {activeFile.size < 1024 ? `${activeFile.size}B` : `${Math.round(activeFile.size / 1024)}KB`}
                </span>
                {activeIsMarkdown && (
                  <div className="ml-1 flex shrink-0 items-center gap-0.5 border-l border-line pl-1">
                    <button
                      type="button"
                      aria-pressed={fileView === "preview"}
                      onClick={() => setFileView("preview")}
                      className={cn(
                        "rounded-[3px] px-1.5 py-0.5 text-[0.625rem] font-medium transition-colors",
                        fileView === "preview" ? "bg-selected text-ink" : "text-ink-3 hover:bg-surface-2 hover:text-ink",
                      )}
                    >
                      预览
                    </button>
                    <button
                      type="button"
                      aria-pressed={fileView === "source"}
                      onClick={() => setFileView("source")}
                      className={cn(
                        "rounded-[3px] px-1.5 py-0.5 text-[0.625rem] font-medium transition-colors",
                        fileView === "source" ? "bg-selected text-ink" : "text-ink-3 hover:bg-surface-2 hover:text-ink",
                      )}
                    >
                      源代码
                    </button>
                  </div>
                )}
                {activeIsHtml && (
                  <button
                    type="button"
                    onClick={() => {
                      setCanvasPath(activeFile.path);
                      select("preview");
                    }}
                    className="shrink-0 rounded-[3px] bg-surface-2 px-2 py-0.5 text-[0.625rem] font-medium text-ink-2 transition-colors hover:text-ink"
                  >
                    预览打开
                  </button>
                )}
              </div>
              {activeIsMarkdown && fileView === "preview" ? (
                <div className="min-h-0 flex-1 overflow-y-auto bg-bg px-5 py-4">
                  <div className="mx-auto max-w-3xl pb-8">
                    <Markdown text={activeContent} />
                  </div>
                </div>
              ) : (
                <FileEditor
                  key={activeFile.path}
                  path={activeFile.path}
                  anchorLine={anchorLine}
                  value={activeContent}
                  savedContent={activeFile.content}
                  sessionId={sessionId}
                  onChange={(content) => setFileDrafts((prev) => ({ ...prev, [activeFile.path]: content }))}
                  onSaved={(content, size) => saveDraft(activeFile.path, content, size)}
                  onDiscard={() => setFileDrafts((prev) => {
                    const { [activeFile.path]: _discarded, ...next } = prev;
                    return next;
                  })}
                />
              )}
            </div>
          ) : (
            /* 无激活文件：显示本轮改动 chips（预览区中央） */
            <div className="wb-empty">
              {editedPaths && editedPaths.length > 0 ? (
                <div className="flex max-w-md flex-col items-center gap-3 text-center">
                  <span className="text-[0.6875rem] uppercase tracking-wider text-ink-3">
                    本轮改动 {editedPaths.length}
                  </span>
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {editedPaths.slice(0, 8).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => openFile(p)}
                        title={p}
                        className="max-w-44 truncate rounded-pill bg-live-tint px-2.5 py-1 font-mono text-xs text-live transition-colors hover:bg-live/20"
                      >
                        {p.split("/").pop()}
                      </button>
                    ))}
                  </div>
                  <span className="text-[0.625rem] text-ink-3">从左侧文件树选择，或点击上面任一文件打开预览</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 text-ink-3">
                  <svg width="40" height="40" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.4">
                    <path d="M14 10h16l8 8v22a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2z" strokeLinejoin="round" />
                    <path d="M30 10v8h8M18 24h12M18 30h12M18 36h8" strokeLinecap="round" />
                  </svg>
                  <span className="text-sm">从左侧文件树选择文件预览</span>
                </div>
              )}
            </div>
          );
        case "review":
          return (
            <ReviewPane
              editedPaths={editedPaths ?? []}
              sessionId={sessionId}
              summary={summary}
              onOpenFiles={() => select("files")}
            />
          );
        case "preview":
          return (
            <CanvasPane
              path={canvasPath}
              onPathChange={setCanvasPath}
              sessionId={sessionId}
              onOpenFiles={() => select("files")}
            />
          );
      }
  };

  return (
    <div className="workbench-shell wb-region wb-region-edge-l h-full flex-col">
      {/* 一级 tab 行：underline 风格（accent 内嵌下划线），不再是反色胶囊。
          spec §3.2「不得把常规工具按钮做成胶囊」+ §5 WorkbenchPanel 责任。
          终端不在此行占位，常驻底部 Debug Area。 */}
      <div className="wb-bar" role="tablist" aria-label="工作区面板">
        {TABS.map((t) => (
          <button
            key={t.key}
            id={`wb-tab-${t.key}`}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => select(t.key)}
            className="wb-tab"
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* 面板区：与 tablist 配对，aria-labelledby 指向当前选中 tab */}
      <div className="flex min-h-0 min-w-0 flex-1" role="tabpanel" aria-labelledby={`wb-tab-${tab}`}>
          {/* 文件树只在 Files 视图可见，但不卸载：切到审查/预览后再回来时，展开目录、
              已选文件与滚动位置都保持。切换会话仍由 WorkbenchPanel 的 key 重建隔离。 */}
          <div className={cn("wb-region wb-region-edge-r shrink-0 flex-col", tab !== "files" && "hidden")} style={{ width: treeWidth }}>
            {/* 树头部：32px（§3.4「文件/终端 tab 行 30--32px」，原 28px 偏矮） */}
            <div className="wb-bar-sm gap-1.5 px-2 text-[0.6875rem] font-medium uppercase tracking-wider text-ink-3">
              <span>资源管理器</span>
              <span className="ml-auto text-[0.625rem] normal-case tracking-normal text-ink-3">↻</span>
            </div>
            <FileTree onOpenFile={(path) => openFile(path)} sessionId={sessionId} />
          </div>
          {/* 文件树 ↔ 预览拖拽条 */}
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={onTreeDragStart}
            className={cn("w-1 shrink-0 cursor-col-resize border-x border-line transition-colors hover:bg-selected-strong", tab !== "files" && "hidden")}
          />
          {/* 右侧预览区 */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {renderPreview()}
          </div>
      </div>
    </div>
  );
}
