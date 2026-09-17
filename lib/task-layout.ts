/**
 * 布局状态模型（对话优先视觉改版规格 §5.5.2 / §7.1 / §9）。
 *
 * 本文件的定位：把「持久桌面偏好」和「当前断点下的临时呈现」分开的单一来源。
 * page.tsx 只负责喂进 window 尺寸与 localStorage，把结果渲染出去；所有阈值、
 * clamp、断点与持久化解析都在这里，除存储读写外都是可单测的纯函数。
 *
 * 规格明文要求，逐条对应：
 * - §5.5.2 拖动边界：min 360 / max `min(760, available * 0.58)`；且
 *   `available < 480 + 360 + 12` 时禁止继续并排压缩，转覆盖式抽屉。
 * - §7 三档断点：≥1180 桌面并排、768–1179 互斥覆盖层、<768 单视图。
 * - §7.1 进入窄断点只能改 ResponsivePresentation，不能覆盖桌面偏好。
 * - §9 按任务保存、旧版全局宽度只迁移一次、带版本号、上限清理、损坏值安全回退。
 */

export type WorkbenchTab = "review" | "files" | "preview";

/** 当前断点下的布局模式（规格 §7）。 */
export type LayoutMode = "desktop" | "overlay" | "single";

export type ActiveOverlay = "sidebar" | "workbench" | null;
export type MobileView = "conversation" | "sidebar" | "workbench";

/** 工作台在桌面上的真实呈现方式（规格 §5.5）。 */
export type WorkbenchPresentation = "hidden" | "side" | "drawer";

/** 按任务保存的桌面偏好（规格 §7.1）。 */
export type TaskWorkbenchLayout = {
  open: boolean;
  width: number;
  tab: WorkbenchTab;
  /** 用户是否在本任务内显式选过 tab（automatic/user 契约：显式后停止自动推荐）。 */
  tabExplicit: boolean;
};

/** 旧版全局状态（仅用于一次性迁移，规格 §9）。 */
export type LegacyLayoutState = {
  open: boolean | null;
  width: number | null;
};

/** 落盘结构（规格 §9：持久化 key 需要版本号）。 */
export type StoredTaskLayoutV1 = {
  version: 1;
  byTaskId: Record<string, TaskWorkbenchLayout & { updatedAt: number }>;
};

// ── 阈值常量（规格 §5.5.2 / §7）─────────────────────────────────────────
export const DESKTOP_MIN_WIDTH = 1180;
export const OVERLAY_MIN_WIDTH = 768;
/** 会话区最小可读宽度。 */
export const CONVERSATION_MIN_WIDTH = 480;
export const WORKBENCH_MIN_WIDTH = 360;
/** 工作台宽度硬上限。 */
export const WORKBENCH_SOFT_MAX = 760;
/** 工作台可占可用宽度比例上限。 */
export const WORKBENCH_MAX_RATIO = 0.58;
/** 分隔条热区，须与 globals.css `.wb-splitter-v` 的 12px 一致。 */
export const SPLITTER_WIDTH = 12;
/** 双击复位的推荐宽度。 */
export const WORKBENCH_DEFAULT_WIDTH = 384;
/** 键盘步长（规格 §5.5.2：方向键 16px，Shift 48px）。 */
export const SPLITTER_STEP = 16;
export const SPLITTER_STEP_LARGE = 48;
/** 会话内容列最大宽度（规格 §7.2：建议 760–840px）。 */
export const CONVERSATION_CONTENT_MAX = 800;
/** 侧栏宽度边界（沿用既有实现，集中到此处便于单点调整）。 */
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 256;
/** 按任务记录上限，超出按 updatedAt 淘汰最旧（规格 §9）。 */
export const MAX_STORED_TASK_LAYOUTS = 40;

export const TASK_LAYOUT_KEY = "lectern.task-layout";
export const TASK_LAYOUT_VERSION = 1;
/** 旧版全局键，只在迁移窗口内读取（规格 §9）。 */
export const LEGACY_WORKBENCH_OPEN_KEY = "lectern:workbench-open";
export const LEGACY_WORKBENCH_WIDTH_KEY = "lectern:workbench-width";

const TABS: readonly WorkbenchTab[] = ["review", "files", "preview"];

export function isWorkbenchTab(value: unknown): value is WorkbenchTab {
  return typeof value === "string" && (TABS as readonly string[]).includes(value);
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

// ── 断点与呈现（规格 §7 / §7.1 / §5.5）─────────────────────────────────

export function layoutModeFor(viewportWidth: number): LayoutMode {
  if (!Number.isFinite(viewportWidth) || viewportWidth >= DESKTOP_MIN_WIDTH) return "desktop";
  if (viewportWidth >= OVERLAY_MIN_WIDTH) return "overlay";
  return "single";
}

export function mobileViewFor(activeOverlay: ActiveOverlay): MobileView {
  if (activeOverlay === "sidebar") return "sidebar";
  if (activeOverlay === "workbench") return "workbench";
  return "conversation";
}

/** 桌面模式下，会话区 + 工作台可共同支配的宽度（侧栏收起时整窗可用）。 */
export function availableWidthFor(
  viewportWidth: number,
  sidebarOpen: boolean,
  sidebarWidth: number,
): number {
  return Math.max(0, viewportWidth - (sidebarOpen ? sidebarWidth : 0));
}

/** 工作台在该可用宽度下的理论上限：`min(760, available * 0.58)`。 */
export function workbenchMaxFor(availableWidth: number): number {
  return Math.max(
    WORKBENCH_MIN_WIDTH,
    Math.min(WORKBENCH_SOFT_MAX, Math.floor(availableWidth * WORKBENCH_MAX_RATIO)),
  );
}

/** 规格 §5.5.2 的 `clamp(pointerRightDistance, workbenchMin, workbenchMax)`。 */
export function clampWorkbenchWidth(availableWidth: number, desired: number): number {
  const max = workbenchMaxFor(availableWidth);
  if (!Number.isFinite(desired)) return clamp(WORKBENCH_DEFAULT_WIDTH, WORKBENCH_MIN_WIDTH, max);
  return clamp(Math.round(desired), WORKBENCH_MIN_WIDTH, max);
}

/**
 * 规格 §5.5.2：`availableWidth < conversationMin + workbenchMin + dividerWidth`
 * 时禁止继续并排压缩，立即切换到覆盖式工作台。
 */
export function canSplitSideBySide(availableWidth: number): boolean {
  return availableWidth >= CONVERSATION_MIN_WIDTH + WORKBENCH_MIN_WIDTH + SPLITTER_WIDTH;
}

/**
 * 桌面模式下工作台怎么呈现：用户想并排但宽度不够时不挤压会话，
 * 改用覆盖式抽屉（规格 §5.5「工作台改为覆盖式抽屉」）。
 */
export function workbenchPresentationFor(
  mode: LayoutMode,
  open: boolean,
  availableWidth: number,
): WorkbenchPresentation {
  if (!open) return "hidden";
  if (mode === "desktop" && canSplitSideBySide(availableWidth)) return "side";
  return "drawer";
}

/** 把任意历史宽度归一化到与视口无关的合法区间（首屏解析用）。 */
export function normalizeWorkbenchWidth(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return WORKBENCH_DEFAULT_WIDTH;
  return clamp(Math.round(value), WORKBENCH_MIN_WIDTH, WORKBENCH_SOFT_MAX);
}

// ── 持久化（规格 §9）────────────────────────────────────────────────────

function storage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function emptyStore(): StoredTaskLayoutV1 {
  return { version: TASK_LAYOUT_VERSION, byTaskId: {} };
}

function coerceLayout(raw: unknown, fallback: TaskWorkbenchLayout): TaskWorkbenchLayout | null {
  if (raw == null || typeof raw !== "object") return null;
  const value = raw as Partial<TaskWorkbenchLayout>;
  return {
    open: typeof value.open === "boolean" ? value.open : fallback.open,
    width: typeof value.width === "number" ? normalizeWorkbenchWidth(value.width) : fallback.width,
    tab: isWorkbenchTab(value.tab) ? value.tab : fallback.tab,
    tabExplicit: typeof value.tabExplicit === "boolean" ? value.tabExplicit : fallback.tabExplicit,
  };
}

/**
 * 解析落盘字符串。规格 §9：解析失败 / 版本不匹配 / 值越界一律回到安全默认值，
 * 永不抛错、永不返回 null。
 */
export function parseLayoutStore(raw: string | null | undefined): StoredTaskLayoutV1 {
  if (typeof raw !== "string" || raw.length === 0) return emptyStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyStore();
  }
  if (parsed == null || typeof parsed !== "object") return emptyStore();
  const candidate = parsed as { version?: unknown; byTaskId?: unknown };
  if (candidate.version !== TASK_LAYOUT_VERSION) return emptyStore();
  if (candidate.byTaskId == null || typeof candidate.byTaskId !== "object") return emptyStore();

  const fallback = defaultTaskWorkbenchLayout();
  const byTaskId: StoredTaskLayoutV1["byTaskId"] = {};
  for (const [taskId, value] of Object.entries(candidate.byTaskId as Record<string, unknown>)) {
    if (!taskId) continue;
    const coerced = coerceLayout(value, fallback);
    if (!coerced) continue;
    const updatedAt = (value as { updatedAt?: unknown })?.updatedAt;
    byTaskId[taskId] = {
      ...coerced,
      updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : 0,
    };
  }
  return { version: TASK_LAYOUT_VERSION, byTaskId };
}

export function serializeLayoutStore(store: StoredTaskLayoutV1): string {
  return JSON.stringify(store);
}

/**
 * 默认偏好：**工作台默认收起**（规格 §4.2 / §12.1）。旧版全局「已打开」刻意不
 * 迁移——否则老用户升级后第一次打开就被一个常驻面板迎面撞上；只有宽度有迁移价值。
 */
export function defaultTaskWorkbenchLayout(legacyWidth?: number | null): TaskWorkbenchLayout {
  return {
    open: false,
    width: normalizeWorkbenchWidth(legacyWidth),
    tab: "review",
    tabExplicit: false,
  };
}

/** 保留最近更新的 MAX_STORED_TASK_LAYOUTS 条（规格 §9：避免长期使用后无限增长）。 */
export function pruneLayoutStore(
  byTaskId: StoredTaskLayoutV1["byTaskId"],
): StoredTaskLayoutV1["byTaskId"] {
  const entries = Object.entries(byTaskId);
  if (entries.length <= MAX_STORED_TASK_LAYOUTS) return byTaskId;
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, MAX_STORED_TASK_LAYOUTS));
}

/** 读取旧版全局键（只读；是否清理由迁移分支决定）。 */
export function readLegacyLayout(): LegacyLayoutState {
  const target = storage();
  if (!target) return { open: null, width: null };
  const openRaw = target.getItem(LEGACY_WORKBENCH_OPEN_KEY);
  const widthRaw = target.getItem(LEGACY_WORKBENCH_WIDTH_KEY);
  const width = widthRaw != null && widthRaw.length > 0 ? Number(widthRaw) : null;
  return {
    open: openRaw === "1" ? true : openRaw === "0" ? false : null,
    width: width != null && Number.isFinite(width) ? width : null,
  };
}

/** 迁移完成后清掉旧键，保证「只迁移一次」（规格 §9）。 */
export function clearLegacyLayoutKeys(): void {
  const target = storage();
  if (!target) return;
  try {
    target.removeItem(LEGACY_WORKBENCH_OPEN_KEY);
    target.removeItem(LEGACY_WORKBENCH_WIDTH_KEY);
  } catch {
    /* 忽略：偏好清理失败不应影响启动 */
  }
}

function loadStore(): StoredTaskLayoutV1 {
  const target = storage();
  if (!target) return emptyStore();
  try {
    return parseLayoutStore(target.getItem(TASK_LAYOUT_KEY));
  } catch {
    return emptyStore();
  }
}

function saveStore(store: StoredTaskLayoutV1): void {
  const target = storage();
  if (!target) return;
  try {
    target.setItem(
      TASK_LAYOUT_KEY,
      serializeLayoutStore({
        version: TASK_LAYOUT_VERSION,
        byTaskId: pruneLayoutStore(store.byTaskId),
      }),
    );
  } catch {
    /* 布局偏好是可选的，写不进去也绝不能阻塞工作区 */
  }
}

/**
 * 读某任务的工作台布局。
 *
 * `legacy` 传入时，若该任务**尚无记录**，把旧版全局宽度迁移为它的初值并落盘
 * （规格 §9「旧版全局工作台宽度仅在目标任务没有偏好时迁移一次」），随后清掉旧键。
 */
export function readTaskWorkbenchLayout(
  taskId: string,
  legacy?: LegacyLayoutState | null,
  now: number = Date.now(),
): TaskWorkbenchLayout {
  const store = loadStore();
  const owned = store.byTaskId[taskId];
  if (owned) {
    const { updatedAt: _updatedAt, ...layout } = owned;
    return layout;
  }
  const hasLegacy = legacy != null && (legacy.width != null || legacy.open != null);
  if (!hasLegacy) return defaultTaskWorkbenchLayout();
  const migrated = defaultTaskWorkbenchLayout(legacy.width);
  saveStore({
    version: TASK_LAYOUT_VERSION,
    byTaskId: { ...store.byTaskId, [taskId]: { ...migrated, updatedAt: now } },
  });
  clearLegacyLayoutKeys();
  return migrated;
}

export function writeTaskWorkbenchLayout(
  taskId: string,
  layout: TaskWorkbenchLayout,
  now: number = Date.now(),
): void {
  const store = loadStore();
  const normalized =
    coerceLayout(layout, defaultTaskWorkbenchLayout()) ?? defaultTaskWorkbenchLayout();
  saveStore({
    version: TASK_LAYOUT_VERSION,
    byTaskId: { ...store.byTaskId, [taskId]: { ...normalized, updatedAt: now } },
  });
}
