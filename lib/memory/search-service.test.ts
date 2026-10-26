import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
vi.mock("../settings", () => ({ memoryPat: () => "zmk_test", memoryAccountUserId: () => "u_test" }));

import { recallSection, resetMemoryCacheForTest, searchProjectMemory } from "./service.js";
import type { EnsureBindingResult, MemoryBinding } from "./binding.js";
import type { MemoryResult, MemoryRecallHit } from "./client.js";

const project = { id: "p_s", name: "服务测试" };

function binding(overrides: Partial<MemoryBinding> = {}): MemoryBinding {
  return {
    projectId: project.id,
    origin: "https://memory.example",
    bankId: "lec_bank1",
    bankName: "服务测试",
    accountUserId: "u_test",
    bindingVersion: 1,
    enabled: 1,
    syncPolicy: "manual",
    source: "auto",
    permission: "write",
    lastRecallAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function deps() {
  return {
    getBinding: vi.fn((): MemoryBinding | null => binding()),
    ensureBinding: vi.fn(async (): Promise<EnsureBindingResult> => ({ ok: true, binding: binding(), created: true })),
    recall: vi.fn(
      async (): Promise<MemoryResult<{ hits: MemoryRecallHit[] }>> => ({
        ok: true,
        data: { hits: [{ memoryId: "m1", text: "构建用 pnpm test", score: 0.9 }, { memoryId: "m2", text: "端口 3015" }] },
      }),
    ),
    record: vi.fn(),
    pat: vi.fn((): string | null => "zmk_x"),
    accountUserId: vi.fn((): string | null => "u_test"),
  };
}

beforeEach(() => {
  resetMemoryCacheForTest();
});

describe("searchProjectMemory 主动检索", () => {
  it("用独立预算检索并记录 source=tool", async () => {
    const d = deps();
    const result = await searchProjectMemory(project, "ses_1", "怎么跑测试", 8, d);
    expect(result).toMatchObject({ status: "hit", deduped: 0, bankId: "lec_bank1" });
    expect(d.recall).toHaveBeenCalledWith("lec_bank1", "怎么跑测试", {
      maxTokens: 2000,
      timeoutMs: 1500,
      source: "tool",
    });
    expect(d.record).toHaveBeenCalledWith(project.id, expect.objectContaining({ sessionId: "ses_1", source: "tool", hitCount: 2 }));
  });

  it("剔除本次任务开头已注入的 memoryId", async () => {
    const d = deps();
    await recallSection(project, "ses_1", "怎么跑测试", d);
    const result = await searchProjectMemory(project, "ses_1", "怎么跑测试", 8, d);
    expect(result).toMatchObject({ status: "deduped", deduped: 2, hits: [] });
  });

  it("未登录账号 → unauthenticated 且不检索", async () => {
    const d = deps();
    d.accountUserId.mockReturnValue(null);
    const result = await searchProjectMemory(project, "ses_1", "q", 8, d);
    expect(result).toEqual({ status: "unauthenticated" });
    expect(d.recall).not.toHaveBeenCalled();
  });

  it("上游 401 → unauthenticated；其他失败 → unavailable", async () => {
    const d = deps();
    d.recall.mockResolvedValueOnce({ ok: false, kind: "unauthenticated", status: 401 });
    expect(await searchProjectMemory(project, "ses_1", "q", 8, d)).toEqual({ status: "unauthenticated" });

    d.recall.mockResolvedValueOnce({ ok: false, kind: "network" });
    expect(await searchProjectMemory(project, "ses_1", "q", 8, d)).toEqual({ status: "unavailable" });
  });
});
