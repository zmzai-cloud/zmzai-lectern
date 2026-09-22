import { hostGateway } from "@/lib/host-gateway";
import { NextResponse } from "next/server";

import { terminalManager } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 将 xterm 的实际网格同步回 PTY，供 vim、htop 等交互程序正确重绘。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gateway = await hostGateway(request as unknown as Request);
  if (gateway) return gateway;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { cols?: unknown; rows?: unknown } | null;
  const cols = typeof body?.cols === "number" ? Math.round(body.cols) : 0;
  const rows = typeof body?.rows === "number" ? Math.round(body.rows) : 0;
  if (cols < 20 || cols > 500 || rows < 5 || rows > 200) {
    return NextResponse.json({ error: "无效终端尺寸" }, { status: 400 });
  }
  const ok = terminalManager().resize(id, cols, rows);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}
