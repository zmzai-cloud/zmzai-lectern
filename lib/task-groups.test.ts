import { describe, expect, it } from "vitest";
import { groupTasks, taskGroup, unreadTaskCount } from "./task-groups.js";
import type { SessionListItem } from "./types.js";

const task = (id: string, extra: Partial<SessionListItem> = {}): SessionListItem => ({
  id, title: id, agent: "default", model: { providerId: "openai", modelId: "test" },
  time: { created: "2026-09-07T00:00:00Z" }, ...extra,
});

describe("task grouping", () => {
  it("counts only existing non-archived unread activity", () => {
    expect(unreadTaskCount([task("a"), task("b", { archived: true })], { a: { kind: "completed", at: 1 }, b: { kind: "error", at: 2 }, missing: { kind: "completed", at: 3 } })).toBe(1);
  });
  it("gives permission waits their own group even while the runner is active", () => {
    expect(taskGroup(task("a", { awaitingPermission: true, running: true }))).toBe("awaiting_permission");
  });
  it("keeps archived tasks archived regardless of stale status or unread flags", () => {
    expect(taskGroup(task("a", { archived: true, awaitingPermission: true, running: true }), { a: { kind: "error", at: 1 } })).toBe("archived");
  });
  it("running takes priority over an old failure or unread result", () => {
    expect(taskGroup(task("a", { running: true, lastOutcome: "error" }), { a: { kind: "error", at: 1 } })).toBe("running");
  });
  it.each(["error", "aborted"] as const)("places %s outcomes in attention", (lastOutcome) => {
    expect(taskGroup(task("a", { lastOutcome }))).toBe("needs_attention");
  });
  it("moves a completed unread task to recent when read", () => {
    const session = task("a", { lastOutcome: "completed" });
    expect(taskGroup(session, { a: { kind: "completed", at: 1 } })).toBe("needs_attention");
    expect(taskGroup(session, {})).toBe("recent");
  });
  it("sorts groups by urgency, pins within groups, preserves input and stable ordering", () => {
    const sessions = [task("recent"), task("pinned", { pinned: true }), task("other"), task("run", { running: true }), task("wait", { awaitingPermission: true }), task("error", { lastOutcome: "error" })];
    const before = structuredClone(sessions);
    const groups = groupTasks(sessions);
    expect(groups.map((g) => g.key)).toEqual(["awaiting_permission", "needs_attention", "running", "recent"]);
    expect(groups[3].items.map((s) => s.id)).toEqual(["pinned", "recent", "other"]);
    expect(sessions).toEqual(before);
  });
  it("omits empty groups", () => expect(groupTasks([])).toEqual([]));
});
