import { NextResponse, type NextRequest } from "next/server";

import { isSessionActive, isSessionAwaitingPermission } from "@zmzai/agent-framework";

import { resolveModel, sessionCookieName } from "@/lib/relay";
import { cloudRuntime, runtimeFor } from "@/lib/runtime";
import { withWorkflowErrors, WorkflowError } from "@/lib/workflow-error";
import { getActiveProject, listProjects, projectStore } from "@/lib/projects";
import { createWorktree, worktreeForSession } from "@/lib/worktree";
import type { SessionListItem } from "@/lib/types";
import { createHash, randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
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
            merged.push({ ...s, readState: await store.getReadState?.(s.id), running: isSessionActive(s.id), awaitingPermission: isSessionAwaitingPermission(s.id), messageCount: counts.get(s.id) ?? 0, projectId: project.id, projectName: project.name });
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
  const withStatus = await Promise.all(sessions.map(async (s) => ({ ...s, readState: await runtime.store.getReadState?.(s.id), projectId: project.id, projectName: project.name, running: isSessionActive(s.id), awaitingPermission: isSessionAwaitingPermission(s.id), messageCount: counts.get(s.id) ?? 0 })));
  return NextResponse.json(withStatus);
}

async function handlePOST(request: NextRequest) {
  // Capture at request entry, including across asynchronous body parsing.
  const project = getActiveProject();
  const body = (await request.json().catch(() => null)) as
    { agent?: string; model?: { providerId: string; modelId: string }; isolate?: boolean; requestId?: string } | null;
  if (body?.requestId !== undefined && (typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId))) {
    throw new WorkflowError("INVALID_INPUT","非法 requestId",422);
  }
  const requestId = body?.requestId ?? randomUUID();
  const cookie = request.cookies.get(sessionCookieName)?.value;
  const cookieHeader = cookie ? `${sessionCookieName}=${cookie}` : null;

  // Capture the project before awaiting model resolution or session persistence.
  const runtime = runtimeFor(project.path);
  const sessionId = `ses_${createHash("sha256").update(`${project.id}:${requestId}`).digest("hex").slice(0,24)}`;
  const existing = await runtime.store.getSession(sessionId);
  const model = body?.model ?? existing?.model ?? (await resolveModel(body?.agent, cookieHeader));
  const effectiveModel = model ?? { providerId: "openai", modelId: process.env.OPENAI_MODEL ?? "deepseek-chat" };
  const creationPayloadHash = createHash("sha256").update(JSON.stringify({ agent: body?.agent ?? "default",model: effectiveModel,isolate: !!body?.isolate })).digest("hex");
  if (existing && existing.creationPayloadHash !== creationPayloadHash) {
    throw new WorkflowError("CONFLICT","requestId 已用于不同的会话参数",409);
  }
  const created = existing ?? await runtime.createSession({
    id: sessionId,
    userId: "local",
    workspaceId: "local",
    agent: body?.agent,
    // 兜底默认值与主链路一致（relay.ts resolveAgents 的 fallback），避免
    // 未设 OPENAI_MODEL 时会话模型落成 gpt-4o 而与 relay 实际模型对不上。
    model: effectiveModel,
    creationRequestId: requestId,
    creationPayloadHash,
  });
  const session = await runtime.store.getSession(sessionId) ?? created;

  // 会话级 worktree 隔离（robustness-plan §9）：仅显式勾选「隔离副本」的会话创建 worktree；
  // 非 git 项目 / git 失败时降级为普通会话并回传原因（渐进采用，不做一刀切）。
  const recorded = worktreeForSession(session.id);
  let isolation: { enabled: boolean; reason?: string; path?: string; branch?: string } = recorded
    ? { enabled: true,path: recorded.path,branch: recorded.branch }
    : { enabled: false };
  if (body?.isolate) {
    const result = await createWorktree(session.id, project.path);
    if (result.ok) {
      isolation = { enabled: true, path: result.record.path, branch: result.record.branch };
    } else {
      isolation = { enabled: false, reason: result.reason };
    }
  }
  return NextResponse.json({ ...session, isolation, projectId: project.id, projectName: project.name });
}

export const POST = withWorkflowErrors(handlePOST);
