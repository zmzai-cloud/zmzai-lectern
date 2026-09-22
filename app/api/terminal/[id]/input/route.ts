import { hostGateway } from "@/lib/host-gateway";
import { NextResponse, type NextRequest } from "next/server";

import { terminalManager } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/terminal/:id/input — 向运行中的会话写 stdin（如交互式确认 y、Ctrl+C "\u0003"） */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gateway = await hostGateway(request as unknown as Request);
  if (gateway) return gateway;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { data?: string } | null;
  if (!body?.data) return NextResponse.json({ error: "缺少 data" }, { status: 400 });
  const ok = terminalManager().write(id, body.data);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}
