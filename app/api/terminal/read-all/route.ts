import { hostGateway } from "@/lib/host-gateway";
import { NextResponse } from "next/server";

import { terminalManager } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/terminal/read-all?cursors={"tty_0001":576,...}
 *
 * 批量游标读：一次请求返回所有会话的增量输出 + 最新状态。
 * 替代前端「每会话一条 GET /api/terminal/:id/read」的 N 路轮询——
 * dev 模式下每请求一条日志，N 路轮询会把 dev 终端刷成瀑布并拖慢交互。
 */
export async function GET(request: Request) {
  const gateway = await hostGateway(request as unknown as Request);
  if (gateway) return gateway;
  const mgr = terminalManager();
  let cursors: Record<string, number> = {};
  try {
    cursors = JSON.parse(new URL(request.url).searchParams.get("cursors") ?? "{}") as Record<string, number>;
  } catch {
    /* 非法参数按空表处理 */
  }

  const results: Array<{
    id: string;
    output: string;
    cursor: number;
    status: string;
    exitCode: number | null;
    name?: string;
    backend: string;
    bytesTotal: number;
  }> = [];
  const missing: string[] = [];

  for (const [id, cursor] of Object.entries(cursors)) {
    const chunk = mgr.read(id, Number(cursor) || 0);
    if (!chunk) {
      missing.push(id);
      continue;
    }
    results.push({
      id,
      output: chunk.output,
      cursor: chunk.cursor,
      status: chunk.session.status,
      exitCode: chunk.session.exitCode ?? null,
      ...(chunk.session.name ? { name: chunk.session.name } : {}),
      backend: chunk.session.backend,
      bytesTotal: chunk.session.bytesTotal,
    });
  }

  // cursors 之外新出现的会话（另一端新建的 tab）也一并带回，前端自行合并
  const known = new Set(Object.keys(cursors));
  for (const info of mgr.list()) {
    if (!known.has(info.id)) {
      results.push({
        id: info.id,
        output: "",
        cursor: 0,
        status: info.status,
        exitCode: info.exitCode ?? null,
        ...(info.name ? { name: info.name } : {}),
        backend: info.backend,
        bytesTotal: info.bytesTotal,
      });
    }
  }

  return NextResponse.json({ sessions: results, missing });
}
