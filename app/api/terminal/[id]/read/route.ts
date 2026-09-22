import { hostGateway } from "@/lib/host-gateway";
import { NextResponse } from "next/server";

import { terminalManager } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/terminal/:id/read?cursor=N — 游标式增量读输出（前端 300ms 轮询） */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gateway = await hostGateway(request as unknown as Request);
  if (gateway) return gateway;
  const { id } = await params;
  const cursor = Number(new URL(request.url).searchParams.get("cursor") ?? "0") || 0;
  const chunk = terminalManager().read(id, cursor);
  if (!chunk) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  return NextResponse.json(chunk);
}
