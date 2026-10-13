import { describe, expect, it, vi } from "vitest";

import { createMemoryClient } from "./client.js";

const PAT = "zmk_testtoken000000000000000000";

function clientWith(overrides: { pat?: string | null } = {}) {
  const fetchImpl = vi.fn();
  const pat = "pat" in overrides ? overrides.pat : PAT;
  const client = createMemoryClient({
    patProvider: () => pat ?? null,
    baseUrl: "https://memory.example",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, fetchImpl };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("MemoryClient 鉴权与错误面", () => {
  it("无 PAT → unauthenticated，不发请求", async () => {
    const { client, fetchImpl } = clientWith({ pat: null });
    const result = await client.capabilities();
    expect(result).toEqual({ ok: false, kind: "unauthenticated", status: 401 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("请求带 Bearer PAT；401 → unauthenticated", async () => {
    const { client, fetchImpl } = clientWith();
    fetchImpl.mockResolvedValueOnce(jsonResponse(401, { error: "UNAUTHENTICATED" }));
    const result = await client.listBanks();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("unauthenticated");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://memory.example/api/banks");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${PAT}`);
  });

  it("非 2xx → server + 状态码；网络异常 → network", async () => {
    const { client, fetchImpl } = clientWith();
    fetchImpl.mockResolvedValueOnce(jsonResponse(502, { error: "UPSTREAM_ERROR" }));
    const server = await client.capabilities();
    expect(server).toMatchObject({ ok: false, kind: "server", status: 502 });

    fetchImpl.mockRejectedValueOnce(new Error("boom"));
    const network = await client.capabilities();
    expect(network).toMatchObject({ ok: false, kind: "network" });
  });
});

describe("MemoryClient.recall 结果映射", () => {
  it("hindsight 透传结构 → hits（text 修剪、memoryId、scores.final、type→kind、空行过滤）", async () => {
    const { client, fetchImpl } = clientWith();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          { id: "m1", text: "  构建用 pnpm test  ", type: "procedural", scores: { final: 0.82 } },
          { text: "   " },
          { id: "m2", text: "端口 3015", score: 0.5 },
        ],
      }),
    );
    const result = await client.recall("lec_x", "怎么跑测试");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hits).toEqual([
      { memoryId: "m1", text: "构建用 pnpm test", kind: "procedural", score: 0.82 },
      { memoryId: "m2", text: "端口 3015", score: 0.5 },
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://memory.example/api/banks/lec_x/recall");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ query: "怎么跑测试" });
  });

  it("maxTokens 透传", async () => {
    const { client, fetchImpl } = clientWith();
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    await client.recall("lec_x", "q", { maxTokens: 2000 });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ query: "q", maxTokens: 2000 });
  });
});

describe("MemoryClient.retain / operationStatus", () => {
  it("retain 携带 context/tags/idempotencyKey/async；operationStatus 走 GET", async () => {
    const { client, fetchImpl } = clientWith();
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const retained = await client.retain("lec_x", "候选事实", {
      context: '{"taskRevision":3}',
      tags: ["project"],
      idempotencyKey: "idem-1",
      async: true,
    });
    expect(retained.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://memory.example/api/banks/lec_x/memories");
    expect(JSON.parse(String(init.body))).toEqual({
      content: "候选事实",
      context: '{"taskRevision":3}',
      tags: ["project"],
      idempotencyKey: "idem-1",
      async: true,
    });

    fetchImpl.mockResolvedValueOnce(jsonResponse(200, { status: "processing" }));
    const op = await client.operationStatus("lec_x", "op-9");
    expect(op.ok && (op.data as { status: string }).status).toBe("processing");
    const [opUrl, opInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(opUrl).toBe("https://memory.example/api/banks/lec_x/operations/op-9");
    expect(opInit.method).toBe("GET");
  });
});
