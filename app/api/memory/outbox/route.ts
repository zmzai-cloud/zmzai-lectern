import { NextResponse, type NextRequest } from "next/server";

import { drainOutbox, listOutbox, retryOutboxRow } from "@/lib/memory/outbox";
import { getActiveProject, listProjects } from "@/lib/projects";
import { withWorkflowErrors } from "@/lib/workflow-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * K1 outbox 状态面（T19b；完整 UI 在 T19c）：
 * - GET  ?projectId= → 队列（含 payload 摘要/状态/attempts/operationId）
 * - POST {projectId?, id, action: "retry"} → failed/unknown 手动重试（清退避，
 *   同幂等键重发由服务端去重表兜住不重复写入）
 * - POST {projectId?, action: "drain"} → 手动触发一轮 drain（联调/自愈用）
 */
export async function GET(request: NextRequest) {
  return withWorkflowErrors(async () => {
    const project = resolveProject(request.nextUrl.searchParams.get("projectId"));
    return NextResponse.json({ projectId: project.id, rows: listOutbox(project.id) });
  });
}

export async function POST(request: NextRequest) {
  return withWorkflowErrors(async () => {
    const body = (await request.json().catch(() => ({}))) as { projectId?: string; id?: number; action?: string };
    const project = resolveProject(body.projectId ?? null);

    if (body.action === "drain") {
      const report = await drainOutbox(project.id);
      return NextResponse.json({ ok: true, report });
    }
    if (!Number.isInteger(body.id) || body.action !== "retry") {
      return NextResponse.json({ error: "VALIDATION", message: "需要 {id, action:retry} 或 {action:drain}" }, { status: 400 });
    }
    const ok = retryOutboxRow(project.id, Number(body.id));
    if (!ok) return NextResponse.json({ error: "NOT_FOUND", message: "仅 failed/unknown 可重试" }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}

function resolveProject(projectId: string | null) {
  if (projectId) {
    const found = listProjects().find((p) => p.id === projectId);
    if (!found) throw Object.assign(new Error("项目不存在"), { status: 404 });
    return found;
  }
  return getActiveProject();
}
