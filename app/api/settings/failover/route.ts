import { NextResponse, type NextRequest } from "next/server";

import { getFailoverEndpoints, saveFailoverEndpoints, type FailoverEndpointInput } from "@/lib/settings";
import { failoverLog, providerEventLog } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 降级端点列表（apiKey 掩码回显，全量不出服务端）+ 最近降级日志。 */
export async function GET() {
  const endpoints = getFailoverEndpoints().map((ep) => ({
    baseUrl: ep.baseUrl,
    modelId: ep.modelId ?? null,
    apiKeyMasked: ep.apiKey ? `${ep.apiKey.slice(0, 4)}****${ep.apiKey.slice(-4)}` : null,
  }));
  // provider 原始流事件（错误类，有界）：排查 relay/上游流式问题
  return NextResponse.json({ endpoints, failover: failoverLog(), providerEvents: providerEventLog() });
}

/** 保存降级端点（整体替换）。apiKey 留空/缺省 = 不更新该端点的既有 key。 */
export async function PUT(request: NextRequest) {
  const body = (await request.json()) as { endpoints?: (FailoverEndpointInput & { apiKeyMasked?: string })[] | null };

  if (!body || !Array.isArray(body.endpoints)) {
    return NextResponse.json({ error: "endpoints 应为数组" }, { status: 400 });
  }

  // 掩码「****」表示保留原 key（UI 只回显掩码，用户未改动则不传明文）
  const existing = getFailoverEndpoints();
  const cleaned: FailoverEndpointInput[] = body.endpoints.map((ep, i) => {
    const baseUrl = ep.baseUrl?.trim();
    if (!baseUrl) return null as unknown as FailoverEndpointInput;
    let apiKey = ep.apiKey?.trim() || undefined;
    if (!apiKey && ep.apiKeyMasked && existing[i]?.baseUrl === baseUrl.replace(/\/$/, "")) {
      // 掩码回显且用户没改：沿用旧 key
      apiKey = existing[i]?.apiKey;
    }
    return { baseUrl, ...(apiKey ? { apiKey } : {}), ...(ep.modelId?.trim() ? { modelId: ep.modelId.trim() } : {}) };
  }).filter((ep) => ep && ep.baseUrl);

  const saved = saveFailoverEndpoints(cleaned);
  const masked = saved.map((ep) => ({
    baseUrl: ep.baseUrl,
    modelId: ep.modelId ?? null,
    apiKeyMasked: ep.apiKey ? `${ep.apiKey.slice(0, 4)}****${ep.apiKey.slice(-4)}` : null,
  }));
  return NextResponse.json({ endpoints: masked, failover: failoverLog() });
}
