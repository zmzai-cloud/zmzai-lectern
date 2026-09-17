import { beforeEach, describe, expect, it, vi } from "vitest";

import { readTaskWorkbenchLayout, writeTaskWorkbenchLayout } from "./task-layout";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

describe("task workbench layout", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  it("keeps workbench layout isolated per task", () => {
    writeTaskWorkbenchLayout("a", { open: true, width: 520, tab: "preview" });
    writeTaskWorkbenchLayout("b", { open: false, width: 384, tab: "review" });

    expect(readTaskWorkbenchLayout("a")).toEqual({ open: true, width: 520, tab: "preview" });
    expect(readTaskWorkbenchLayout("b")).toEqual({ open: false, width: 384, tab: "review" });
  });

  it("falls back and clamps malformed preferences", () => {
    localStorage.setItem("lectern:task-layout:bad", JSON.stringify({ open: "yes", width: 9999, tab: "terminal" }));

    expect(readTaskWorkbenchLayout("bad")).toEqual({ open: false, width: 720, tab: "review" });
  });

  it("uses a closed default when storage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);

    expect(readTaskWorkbenchLayout("missing")).toEqual({ open: false, width: 384, tab: "review" });
  });
});
