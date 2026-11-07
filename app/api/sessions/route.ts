import { handleSessionCreate } from "@/lib/session-create-service";
import { hostGateway } from "@/lib/host-gateway";
import { NextResponse, type NextRequest } from "next/server";

import { isSessionActive, isSessionAwaitingPermission } from "@zmzai/agent-framework";

import { cloudRuntime } from "@/lib/runtime";
import { getActiveProject, listProjects, projectStore } from "@/lib/projects";
import { worktreeForSession } from "@/lib/worktree";
import type { SessionListItem } from "@/lib/types";
import { toTaskView } from "@/lib/task-presentation";

/** 列表条目的任务态（规格 3 §15.2：会话列表从 task lifecycle 显示运行、等待、
 *  阻塞与完成，而不是从 summary 反推）。
 *
 *  活跃任务优先，没有则取最近一个终态任务——后者是「这条会话上次做到哪了」，
 *  用户扫列表时最需要的信息。取不到（旧库 / 未启用任务层）时返回 null，列表
 *  退回原来的运行态点，不会因此少画一行。 */
async function taskViewFor(store: { task?: { getActiveTask(id: string): Promise<unknown>; getLatestTask(id: string): Promise<unknown> } }, sessionId: string) {
  if (!store.task) return null;
  const record = ((await store.task.getActiveTask(sessionId).catch(() => null)) ?? (await store.task.getLatestTask(sessionId).catch(() => null))) as Parameters<typeof toTaskView>[0] | null;
  return record ? toTaskView(record) : null;
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const gateway = await hostGateway(request as unknown as Request);
  if (gateway) return gateway;
  const project = getActiveProject();
  const runtime = cloudRuntime();
  // 跨项目聚合（P1 会话稳定性：重启后找回任意项目的历史会话）：?all=1 时
  // 逐项目库列会话并附归属；active 项目直接用 runtime.store，其余项目用
  // 轻量 projectStore（只开 SQLite 读连接，不装配 MCP/runtime）。
  if (request.nextUrl.searchParams.get("all") === "1") {
    const projects = listProjects();
    const active = getActiveProject();
    const merged: SessionListItem[] = [];
    await Promise.all(
      projects.map(async (project) => {
        try {
          const store = project.id === active.id ? runtime.store : projectStore(project.id);
          const sessions = await store.listSessions({ userId: "local", workspaceId: "local" });
          // N6 消息计数：批量 GROUP BY 拿本项目全量，避免逐会话 N+1
          const counts = typeof (store as unknown as { countMessagesBySession?: () => Promise<Map<string, number>> }).countMessagesBySession === "function"
            ? await (store as unknown as { countMessagesBySession: () => Promise<Map<string, number>> }).countMessagesBySession()
            : new Map<string, number>();
          for (const s of sessions) {
            merged.push({ ...s, readState: await store.getReadState?.(s.id), running: isSessionActive(s.id), awaitingPermission: isSessionAwaitingPermission(s.id), messageCount: counts.get(s.id) ?? 0, task: await taskViewFor(store, s.id), projectId: project.id, projectName: project.name });
          }
        } catch {
          /* 单项目库异常不影响整体列表 */
        }
      }),
    );
    merged.sort((a, b) => (b.time.updated ?? b.time.created).localeCompare(a.time.updated ?? a.time.created));
    return NextResponse.json(merged);
  }
  const sessions = await runtime.store.listSessions({ userId: "local", workspaceId: "local" });
  // N6 消息计数：批量 GROUP BY 拿全量，避免逐会话 N+1
  const counts = typeof (runtime.store as unknown as { countMessagesBySession?: () => Promise<Map<string, number>> }).countMessagesBySession === "function"
    ? await (runtime.store as unknown as { countMessagesBySession: () => Promise<Map<string, number>> }).countMessagesBySession()
    : new Map<string, number>();
  // 附带运行态（P2-15 多会话并行状态点）：runner 的 activeRuns 内存表
  const withStatus = await Promise.all(sessions.map(async (s) => ({ ...s, readState: await runtime.store.getReadState?.(s.id), projectId: project.id, projectName: project.name, running: isSessionActive(s.id), awaitingPermission: isSessionAwaitingPermission(s.id), messageCount: counts.get(s.id) ?? 0, task: await taskViewFor(runtime.store, s.id) })));
  return NextResponse.json(withStatus);
}

export async function POST(request: NextRequest) {
  const response = await hostGateway(request);
  return response ?? handleSessionCreate(request);
}
