import type { SessionListItem } from "./types.js";

export type TaskActivity = Record<string, { kind: string; at: number }>;
export function unreadTaskCount(sessions: SessionListItem[], activity?: TaskActivity): number {
  if (!activity) return 0;
  const ids = new Set(sessions.filter((session) => !session.archived).map((session) => session.id));
  return Object.keys(activity).filter((id) => ids.has(id)).length;
}
export const TASK_GROUPS = ["awaiting_permission", "needs_attention", "running", "recent", "archived"] as const;
export type TaskGroup = typeof TASK_GROUPS[number];

export function taskGroup(session: SessionListItem, activity?: TaskActivity): TaskGroup {
  if (session.archived) return "archived";
  if (session.awaitingPermission) return "awaiting_permission";
  if (session.running) return "running";
  if (activity?.[session.id] || session.lastOutcome === "error" || session.lastOutcome === "aborted") return "needs_attention";
  return "recent";
}

export function groupTasks(sessions: SessionListItem[], activity?: TaskActivity) {
  const buckets = new Map<TaskGroup, SessionListItem[]>(TASK_GROUPS.map((key) => [key, []]));
  for (const session of sessions) buckets.get(taskGroup(session, activity))!.push(session);
  return TASK_GROUPS.map((key) => ({
    key,
    items: buckets.get(key)!.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)),
  })).filter((group) => group.items.length > 0);
}
