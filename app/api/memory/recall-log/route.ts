import { NextResponse, type NextRequest } from "next/server";

import { getMemoryBinding, openMemoryDb } from "@/lib/memory/binding";
import { resolveSessionOwner } from "@/lib/session-owner";
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
 * GET /api/memory/recall-log?sessionId=…[&limit=5]
 * 会话记忆行的数据源：最近召回记录 + 当前绑定概要（弱化展示，非管理面）。
 */
export async function GET(request: NextRequest) {
  return withWorkflowErrors(async () => {
    const sessionId = request.nextUrl.searchParams.get("sessionId");
    if (!sessionId) return NextResponse.json({ error: "sessionId 必填" }, { status: 400 });

    const owner = resolveSessionOwner(sessionId);
    const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "5");
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 20) : 5;

    const rows = openMemoryDb(owner.project.id)
      .prepare("SELECT * FROM memory_recall_log WHERE sessionId = ? ORDER BY id DESC LIMIT ?")
      .all(sessionId, limit) as Array<Record<string, unknown>>;

    const binding = getMemoryBinding(owner.project.id);
    const entries: MemoryTraceEntry[] = rows.map((row) => ({
      sessionId: String(row.sessionId),
      goalDigest: String(row.goalDigest),
      hitCount: Number(row.hitCount),
      hits: row.hits ? (JSON.parse(String(row.hits)) as MemoryTraceEntry["hits"]) : null,
      at: String(row.at),
    }));

    return NextResponse.json({
      projectId: owner.project.id,
      binding: binding
        ? { bankId: binding.bankId, bankName: binding.bankName, enabled: binding.enabled === 1, syncPolicy: binding.syncPolicy, source: binding.source }
        : null,
      entries,
    });
  });
}
