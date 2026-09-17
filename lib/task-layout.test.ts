import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_MIN_WIDTH,
  DESKTOP_MIN_WIDTH,
  LEGACY_WORKBENCH_OPEN_KEY,
  LEGACY_WORKBENCH_WIDTH_KEY,
  MAX_STORED_TASK_LAYOUTS,
  OVERLAY_MIN_WIDTH,
  SPLITTER_STEP,
  SPLITTER_STEP_LARGE,
  SPLITTER_WIDTH,
  TASK_LAYOUT_KEY,
  WORKBENCH_DEFAULT_WIDTH,
  WORKBENCH_MIN_WIDTH,
  WORKBENCH_SOFT_MAX,
  availableWidthFor,
  canSplitSideBySide,
  clampWorkbenchWidth,
  defaultTaskWorkbenchLayout,
  isWorkbenchTab,
  layoutModeFor,
  mobileViewFor,
  normalizeWorkbenchWidth,
  parseLayoutStore,
  pruneLayoutStore,
  readLegacyLayout,
  readTaskWorkbenchLayout,
  serializeLayoutStore,
  workbenchMaxFor,
  workbenchPresentationFor,
  writeTaskWorkbenchLayout,
} from "./task-layout";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

describe("断点三档（规格 §7）", () => {
  it("≥1180 桌面并排", () => {
    expect(layoutModeFor(1600)).toBe("desktop");
    expect(layoutModeFor(DESKTOP_MIN_WIDTH)).toBe("desktop");
  });

  it("1179 与 1180 必须落在不同模式（临界值）", () => {
    expect(layoutModeFor(1179)).toBe("overlay");
    expect(layoutModeFor(1180)).toBe("desktop");
  });

  it("768–1179 是互斥覆盖层，<768 是单视图", () => {
    expect(layoutModeFor(768)).toBe("overlay");
    expect(layoutModeFor(960)).toBe("overlay");
    expect(layoutModeFor(767)).toBe("single");
    expect(layoutModeFor(390)).toBe("single");
  });

  it("非法尺寸回落到桌面而不是抛错", () => {
    expect(layoutModeFor(Number.NaN)).toBe("desktop");
  });

  it("单视图下同一时刻只有一个视图", () => {
    expect(mobileViewFor(null)).toBe("conversation");
    expect(mobileViewFor("sidebar")).toBe("sidebar");
    expect(mobileViewFor("workbench")).toBe("workbench");
  });

  it("断点常量与规格一致", () => {
    expect(OVERLAY_MIN_WIDTH).toBe(768);
    expect(DESKTOP_MIN_WIDTH).toBe(1180);
  });
});

describe("拖动边界（规格 §5.5.2）", () => {
  it("上限 = min(760, available * 0.58)", () => {
    expect(workbenchMaxFor(2000)).toBe(WORKBENCH_SOFT_MAX);
    expect(workbenchMaxFor(1000)).toBe(580);
  });

  it("低于最小宽度抬到 360，超过比例上限压回", () => {
    expect(clampWorkbenchWidth(1200, 100)).toBe(WORKBENCH_MIN_WIDTH);
    expect(clampWorkbenchWidth(1000, 900)).toBe(580);
  });

  it("clamp 幂等：到边界后不回弹", () => {
    const once = clampWorkbenchWidth(1000, 900);
    expect(clampWorkbenchWidth(1000, once)).toBe(once);
  });

  it("非法输入回落到推荐宽度且不越界", () => {
    expect(clampWorkbenchWidth(1400, Number.NaN)).toBe(WORKBENCH_DEFAULT_WIDTH);
    expect(clampWorkbenchWidth(800, Number.NaN)).toBeLessThanOrEqual(workbenchMaxFor(800));
  });

  it("可用宽度极小时区间不反转", () => {
    expect(workbenchMaxFor(100)).toBe(WORKBENCH_MIN_WIDTH);
  });

  it("键盘步长 16 / Shift 48", () => {
    expect(SPLITTER_STEP).toBe(16);
    expect(SPLITTER_STEP_LARGE).toBe(48);
  });

  it("normalizeWorkbenchWidth 归一化历史脏值", () => {
    expect(normalizeWorkbenchWidth(99999)).toBe(WORKBENCH_SOFT_MAX);
    expect(normalizeWorkbenchWidth(1)).toBe(WORKBENCH_MIN_WIDTH);
    expect(normalizeWorkbenchWidth(undefined)).toBe(WORKBENCH_DEFAULT_WIDTH);
  });
});

describe("并排前提与覆盖式切换（规格 §5.5.2 / §5.5）", () => {
  const threshold = CONVERSATION_MIN_WIDTH + WORKBENCH_MIN_WIDTH + SPLITTER_WIDTH;

  it("恰好等于阈值允许并排，少 1px 就不允许", () => {
    expect(canSplitSideBySide(threshold)).toBe(true);
    expect(canSplitSideBySide(threshold - 1)).toBe(false);
  });

  it("扣掉侧栏后才判断并排能力", () => {
    expect(canSplitSideBySide(availableWidthFor(1490, true, 256))).toBe(true);
    expect(canSplitSideBySide(availableWidthFor(1100, true, 256))).toBe(false);
  });

  it("未打开时始终隐藏", () => {
    expect(workbenchPresentationFor("desktop", false, 1400)).toBe("hidden");
    expect(workbenchPresentationFor("overlay", false, 900)).toBe("hidden");
  });

  it("桌面且够宽 → 并排；不够宽 → 覆盖式抽屉", () => {
    expect(workbenchPresentationFor("desktop", true, 1400)).toBe("side");
    expect(workbenchPresentationFor("desktop", true, 800)).toBe("drawer");
  });

  it("覆盖层与单视图下总是抽屉", () => {
    expect(workbenchPresentationFor("overlay", true, 900)).toBe("drawer");
    expect(workbenchPresentationFor("single", true, 390)).toBe("drawer");
  });
});

describe("默认偏好（规格 §4.2 / §12.1）", () => {
  it("工作台默认收起、tab 为审查", () => {
    expect(defaultTaskWorkbenchLayout()).toEqual({
      open: false,
      width: WORKBENCH_DEFAULT_WIDTH,
      tab: "review",
      tabExplicit: false,
    });
  });

  it("旧版「已打开」不改变新任务的默认开合，仅宽度有迁移价值", () => {
    const layout = defaultTaskWorkbenchLayout(520);
    expect(layout.open).toBe(false);
    expect(layout.width).toBe(520);
  });
});

describe("存储解析安全回退（规格 §9）", () => {
  it("空值与坏 JSON → 空表", () => {
    expect(parseLayoutStore(null)).toEqual({ version: 1, byTaskId: {} });
    expect(parseLayoutStore("{not json")).toEqual({ version: 1, byTaskId: {} });
  });

  it("版本不匹配 → 弃用整表", () => {
    expect(parseLayoutStore(JSON.stringify({ byTaskId: { a: {} } }))).toEqual({
      version: 1,
      byTaskId: {},
    });
    expect(parseLayoutStore(JSON.stringify({ version: 2, byTaskId: { a: {} } }))).toEqual({
      version: 1,
      byTaskId: {},
    });
  });

  it("越界宽度被归一化、非法 tab 回落 review", () => {
    const parsed = parseLayoutStore(
      JSON.stringify({
        version: 1,
        byTaskId: { t1: { open: "yes", width: 9999, tab: "terminal" } },
      }),
    );
    expect(parsed.byTaskId.t1).toMatchObject({
      open: false,
      width: WORKBENCH_SOFT_MAX,
      tab: "review",
      tabExplicit: false,
    });
  });

  it("非对象条目被跳过而不是污染结果", () => {
    const parsed = parseLayoutStore(
      JSON.stringify({ version: 1, byTaskId: { bad: 42, ok: { width: 400 } } }),
    );
    expect(Object.keys(parsed.byTaskId)).toEqual(["ok"]);
  });

  it("序列化往返稳定", () => {
    writeTaskWorkbenchLayout("t1", { open: true, width: 500, tab: "files", tabExplicit: true }, 1);
    const raw = localStorage.getItem(TASK_LAYOUT_KEY);
    expect(parseLayoutStore(raw)).toEqual(parseLayoutStore(serializeLayoutStore(parseLayoutStore(raw))));
  });
});

describe("按任务隔离（规格 §7.1 / §9）", () => {
  it("两个任务的开合、宽度、tab 相互独立", () => {
    writeTaskWorkbenchLayout("a", { open: true, width: 520, tab: "preview", tabExplicit: true });
    writeTaskWorkbenchLayout("b", { open: false, width: 384, tab: "review", tabExplicit: false });

    expect(readTaskWorkbenchLayout("a")).toEqual({
      open: true,
      width: 520,
      tab: "preview",
      tabExplicit: true,
    });
    expect(readTaskWorkbenchLayout("b")).toEqual({
      open: false,
      width: 384,
      tab: "review",
      tabExplicit: false,
    });
  });

  it("无记录的任务拿到默认（收起）", () => {
    expect(readTaskWorkbenchLayout("missing")).toEqual(defaultTaskWorkbenchLayout());
  });

  it("写入越界宽度会被归一化", () => {
    writeTaskWorkbenchLayout("a", { open: false, width: 100000, tab: "review", tabExplicit: false });
    expect(readTaskWorkbenchLayout("a").width).toBe(WORKBENCH_SOFT_MAX);
  });

  it("存储不可用时退回默认且不抛错", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readTaskWorkbenchLayout("missing")).toEqual(defaultTaskWorkbenchLayout());
    expect(() =>
      writeTaskWorkbenchLayout("missing", defaultTaskWorkbenchLayout()),
    ).not.toThrow();
  });
});

describe("旧版全局布局迁移（规格 §9 只迁一次）", () => {
  it("目标任务无偏好时迁移出宽度，但不迁移「已打开」", () => {
    localStorage.setItem(LEGACY_WORKBENCH_WIDTH_KEY, "520");
    localStorage.setItem(LEGACY_WORKBENCH_OPEN_KEY, "1");

    expect(readLegacyLayout()).toEqual({ open: true, width: 520 });
    const migrated = readTaskWorkbenchLayout("t1", readLegacyLayout(), 10);
    expect(migrated).toMatchObject({ width: 520, open: false });
  });

  it("迁移后清掉旧键，后续任务不再被污染", () => {
    localStorage.setItem(LEGACY_WORKBENCH_WIDTH_KEY, "520");
    readTaskWorkbenchLayout("t1", readLegacyLayout(), 10);

    expect(localStorage.getItem(LEGACY_WORKBENCH_WIDTH_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_WORKBENCH_OPEN_KEY)).toBeNull();
    expect(readLegacyLayout()).toEqual({ open: null, width: null });
    // 第二个任务拿默认宽度，不会被 520 二次污染
    expect(readTaskWorkbenchLayout("t2", readLegacyLayout(), 11).width).toBe(
      WORKBENCH_DEFAULT_WIDTH,
    );
  });

  it("已有偏好时不被旧值覆盖", () => {
    writeTaskWorkbenchLayout("t1", { open: true, width: 400, tab: "files", tabExplicit: true }, 5);
    localStorage.setItem(LEGACY_WORKBENCH_WIDTH_KEY, "520");

    expect(readTaskWorkbenchLayout("t1", readLegacyLayout(), 10)).toMatchObject({
      width: 400,
      tab: "files",
    });
    expect(localStorage.getItem(LEGACY_WORKBENCH_WIDTH_KEY)).toBe("520");
  });

  it("没有旧值时不做任何事", () => {
    expect(readTaskWorkbenchLayout("t1", readLegacyLayout(), 10)).toEqual(
      defaultTaskWorkbenchLayout(),
    );
    expect(localStorage.getItem(TASK_LAYOUT_KEY)).toBeNull();
  });
});

describe("上限清理（规格 §9）", () => {
  it("超出上限时淘汰最旧条目", () => {
    const table: Parameters<typeof pruneLayoutStore>[0] = {};
    for (let i = 0; i < MAX_STORED_TASK_LAYOUTS + 5; i += 1) {
      table[`t${i}`] = { ...defaultTaskWorkbenchLayout(), updatedAt: i };
    }
    const pruned = pruneLayoutStore(table);
    expect(Object.keys(pruned)).toHaveLength(MAX_STORED_TASK_LAYOUTS);
    expect(pruned.t0).toBeUndefined();
    expect(pruned[`t${MAX_STORED_TASK_LAYOUTS + 4}`]).toBeDefined();
  });

  it("未超限时原样返回（同一引用）", () => {
    const table = { a: { ...defaultTaskWorkbenchLayout(), updatedAt: 1 } };
    expect(pruneLayoutStore(table)).toBe(table);
  });

  it("写入走 prune，落盘不会无限增长", () => {
    for (let i = 0; i < MAX_STORED_TASK_LAYOUTS + 5; i += 1) {
      writeTaskWorkbenchLayout(`t${i}`, defaultTaskWorkbenchLayout(), 1000 + i);
    }
    const stored = parseLayoutStore(localStorage.getItem(TASK_LAYOUT_KEY));
    expect(Object.keys(stored.byTaskId)).toHaveLength(MAX_STORED_TASK_LAYOUTS);
  });
});

describe("isWorkbenchTab", () => {
  it("只放行三个已知标签", () => {
    expect(isWorkbenchTab("review")).toBe(true);
    expect(isWorkbenchTab("files")).toBe(true);
    expect(isWorkbenchTab("preview")).toBe(true);
    expect(isWorkbenchTab("terminal")).toBe(false);
    expect(isWorkbenchTab(undefined)).toBe(false);
  });
});
