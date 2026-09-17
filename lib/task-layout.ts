export type WorkbenchTab = "review" | "files" | "preview";

export type TaskWorkbenchLayout = {
  open: boolean;
  width: number;
  tab: WorkbenchTab;
  tabExplicit: boolean;
};

const DEFAULT_LAYOUT: TaskWorkbenchLayout = {
  open: false,
  width: 384,
  tab: "review",
  tabExplicit: false,
};

const MIN_WORKBENCH_WIDTH = 320;
const MAX_WORKBENCH_WIDTH = 720;

function storage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function keyOf(taskId: string): string {
  return `lectern:task-layout:${taskId || "__draft__"}`;
}

function validTab(value: unknown): WorkbenchTab {
  return value === "files" || value === "preview" ? value : "review";
}

export function readTaskWorkbenchLayout(taskId: string): TaskWorkbenchLayout {
  const target = storage();
  if (!target) return { ...DEFAULT_LAYOUT };
  try {
    const raw = target.getItem(keyOf(taskId));
    if (!raw) return { ...DEFAULT_LAYOUT };
    const value = JSON.parse(raw) as Partial<TaskWorkbenchLayout>;
    const width = typeof value.width === "number" && Number.isFinite(value.width)
      ? value.width
      : DEFAULT_LAYOUT.width;
    return {
      open: typeof value.open === "boolean" ? value.open : false,
      width: Math.min(MAX_WORKBENCH_WIDTH, Math.max(MIN_WORKBENCH_WIDTH, width)),
      tab: validTab(value.tab),
      tabExplicit: typeof value.tabExplicit === "boolean" ? value.tabExplicit : false,
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function writeTaskWorkbenchLayout(taskId: string, layout: TaskWorkbenchLayout): void {
  const target = storage();
  if (!target) return;
  try {
    target.setItem(keyOf(taskId), JSON.stringify({
      open: layout.open,
      width: Math.min(MAX_WORKBENCH_WIDTH, Math.max(MIN_WORKBENCH_WIDTH, layout.width)),
      tab: validTab(layout.tab),
      tabExplicit: layout.tabExplicit,
    }));
  } catch {
    // Layout preferences are optional and must never block the workspace.
  }
}
