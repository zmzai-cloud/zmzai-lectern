import { NextResponse, type NextRequest } from "next/server";

import { getMemoryBinding, openMemoryDb } from "@/lib/memory/binding";
import { resolveSessionOwner } from "@/lib/session-owner";
import { listProjects } from "@/lib/projects";
import { withWorkflowErrors } from "@/lib/workflow-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type MemoryTraceEntry = {
  sessionId: string;
  goalDigest: string;
  hitCount: number;
  hits: Array<{ text: string; score?: number; memoryId?: string }> | null;
  at: string;
};

/**
 * GET /api/memory/recall-log?sessionId=…[&limit=5] 或 ?projectId=…[&limit=10]
 * 会话记忆行的数据源（sessionId）/ 项目设置「最近召回」（projectId）。
 */
export async function GET(request: NextRequest) {
  return withWorkflowErrors(async () => {
    const sp = request.nextUrl.searchParams;
    const limitRaw = Number(sp.get("limit") ?? "5");
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 20) : 5;

    let projectId = sp.get("projectId");
    let sessionId = sp.get("sessionId");
    if (!projectId && sessionId) {
      const owner = resolveSessionOwner(sessionId);
      projectId = owner.project.id;
    } else if (projectId) {
      const found = listProjects().find((p) => p.id === projectId);
      if (!found) throw Object.assign(new Error("项目不存在"), { status: 404 });
      sessionId = null; // 项目维度列出全部会话
    }
    if (!projectId) return NextResponse.json({ error: "sessionId 或 projectId 必填" }, { status: 400 });

    const rows = openMemoryDb(projectId)
      .prepare(
        sessionId
          ? "SELECT * FROM memory_recall_log WHERE sessionId = ? ORDER BY id DESC LIMIT ?"
          : "SELECT * FROM memory_recall_log ORDER BY id DESC LIMIT ?",
      )
      .all(...(sessionId ? [sessionId, limit] : [limit])) as Array<Record<string, unknown>>;

    const binding = getMemoryBinding(projectId);
    const entries: MemoryTraceEntry[] = rows.map((row) => ({
      sessionId: String(row.sessionId),
      goalDigest: String(row.goalDigest),
      hitCount: Number(row.hitCount),
      hits: row.hits ? (JSON.parse(String(row.hits)) as MemoryTraceEntry["hits"]) : null,
      at: String(row.at),
    }));

    return NextResponse.json({
      projectId,
      binding: binding
        ? { bankId: binding.bankId, bankName: binding.bankName, enabled: binding.enabled === 1, syncPolicy: binding.syncPolicy, source: binding.source }
        : null,
      entries,
    });
  });
}
