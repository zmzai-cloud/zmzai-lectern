import { hostGateway } from "@/lib/host-gateway";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getActiveProject } from "@/lib/projects";
import { mcpRescan, mcpStatusFor } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type McpStatusResponse = {
  statuses: { name: string; state: string; transport: string; tools: string[]; error?: string }[];
  configErrors: string[];
  sources: string[];
};

/** MCP server 连接态（设置弹窗透出）。 */
export async function GET(request: Request) {
  const gateway = await hostGateway(request as unknown as Request);
  if (gateway) return gateway;
  const state = mcpStatusFor(getActiveProject().path);
  return NextResponse.json({
    statuses: state.statuses,
    configErrors: state.configErrors,
    sources: state.sources,
  } satisfies McpStatusResponse);
}

/** 重新扫描 MCP 配置（修改 mcp.json 后触发重建）。 */
export async function POST(request: NextRequest) {
  const gateway = await hostGateway(request as unknown as Request);
  if (gateway) return gateway;
  try {
    const state = await mcpRescan(getActiveProject().path);
    return NextResponse.json({
      statuses: state.statuses,
      configErrors: state.configErrors,
      sources: state.sources,
    } satisfies McpStatusResponse);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "rescan 失败" }, { status: 500 });
  }
}
