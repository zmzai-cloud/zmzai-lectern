import { NextResponse, type NextRequest } from "next/server";

import { actCandidate, listCandidates, type MemoryCandidateStatus } from "@/lib/memory/candidates";
import { getActiveProject, listProjects } from "@/lib/projects";
import { withWorkflowErrors } from "@/lib/workflow-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * K1 候选待审（T19a；完整 UI 在 T19c）：
 * - GET  ?projectId=&status=pending|approved|discarded → 候选列表
 * - POST {projectId?, id, action: approve|discard, statement?} → 审阅动作（可顺带改写语句）
 * approved 由 T19b 的 outbox 入队消费；discard 永不写入云端。
 */
export async function GET(request: NextRequest) {
  return withWorkflowErrors(async () => {
    const project = resolveProject(request.nextUrl.searchParams.get("projectId"));
    const statusRaw = request.nextUrl.searchParams.get("status");
    const status = statusRaw === "pending" || statusRaw === "approved" || statusRaw === "discarded" ? statusRaw : undefined;
    return NextResponse.json({ projectId: project.id, candidates: listCandidates(project.id, status) });
  });
}

export async function POST(request: NextRequest) {
  return withWorkflowErrors(async () => {
    const body = (await request.json().catch(() => ({}))) as {
      projectId?: string;
      id?: number;
      action?: string;
      statement?: string;
    };
    const project = resolveProject(body.projectId ?? null);
    if (!Number.isInteger(body.id) || (body.action !== "approve" && body.action !== "discard")) {
      return NextResponse.json({ error: "VALIDATION", message: "需要 id 与 action(approve|discard)" }, { status: 400 });
    }
    const row = actCandidate(project.id, Number(body.id), body.action, body.statement);
    if (!row) {
      return NextResponse.json({ error: "NOT_FOUND", message: "候选不存在或语句不合法" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, candidate: row });
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
