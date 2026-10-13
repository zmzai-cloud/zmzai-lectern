import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Vite's builtin enumeration omits node:sqlite on some Node versions.
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

import { invalidateMemoryForSession, recallSection, resetMemoryCacheForTest } from "./service.js";
import type { EnsureBindingResult, MemoryBinding } from "./binding.js";
import type { MemoryResult, MemoryRecallHit } from "./client.js";

const project = { id: "p_s", name: "服务测试" };

function binding(overrides: Partial<MemoryBinding> = {}): MemoryBinding {
  return {
    projectId: project.id,
    origin: "https://memory.example",
    bankId: "lec_bank1",
    bankName: "服务测试",
    accountUserId: null,
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

// 不标返回类型：保留 vi.fn 的 Mock 类型（调用处要用 mockReturnValue）；
// 推断形状对 RecallSectionDeps 结构可分配，作为 deps 传入 recallSection 合法。
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
  };
}

beforeEach(() => {
  resetMemoryCacheForTest();
});

describe("recallSection 降级与门控", () => {
  it("子代理会话不注入（父归并语义）", async () => {
    const d = deps();
    const section = await recallSection(project, "ses_sub_abc", "目标", d);
    expect(section).toBeUndefined();
    expect(d.recall).not.toHaveBeenCalled();
  });

  it("无 binding 且无 PAT → 不建库直接降级", async () => {
    const d = deps();
    d.getBinding.mockReturnValue(null);
    d.pat.mockReturnValue(null);
    expect(await recallSection(project, "ses_1", "目标", d)).toBeUndefined();
    expect(d.ensureBinding).not.toHaveBeenCalled();
  });

  it("无 binding 但有 PAT → 自动建库后召回（首个根目标触发）", async () => {
    const d = deps();
    d.getBinding.mockReturnValue(null);
    const section = await recallSection(project, "ses_1", "怎么跑测试", d);
    expect(d.ensureBinding).toHaveBeenCalledWith(project, expect.anything());
    expect(section).toContain("项目记忆");
    expect(section).toContain("- 构建用 pnpm test");
  });

  it("建库失败 → 无记忆继续", async () => {
    const d = deps();
    d.getBinding.mockReturnValue(null);
    d.ensureBinding.mockResolvedValue({ ok: false as const, reason: "bank-create-failed" });
    expect(await recallSection(project, "ses_1", "目标", d)).toBeUndefined();
  });

  it("enabled=0 → 跳过", async () => {
    const d = deps();
    d.getBinding.mockReturnValue(binding({ enabled: 0 }));
    expect(await recallSection(project, "ses_1", "目标", d)).toBeUndefined();
    expect(d.recall).not.toHaveBeenCalled();
  });

  it("召回失败（超时/401/网络）→ undefined 且不缓存失败", async () => {
    const d = deps();
    d.recall.mockResolvedValue({ ok: false, kind: "network" });
    expect(await recallSection(project, "ses_1", "目标", d)).toBeUndefined();
    // 失败不缓存：下次仍会尝试
    d.recall.mockResolvedValue({ ok: true, data: { hits: [{ text: "x" }] } });
    const section = await recallSection(project, "ses_1", "目标", d);
    expect(section).toContain("- x");
  });

  it("空命中 → undefined（无内容注入）", async () => {
    const d = deps();
    d.recall.mockResolvedValue({ ok: true, data: { hits: [] } });
    expect(await recallSection(project, "ses_1", "目标", d)).toBeUndefined();
  });
});

describe("recallSection 根目标级缓存", () => {
  it("同 session 复用（recall 只打一次）；invalidate 后重召", async () => {
    const d = deps();
    await recallSection(project, "ses_1", "第一次目标", d);
    await recallSection(project, "ses_1", "内部续跑", d);
    expect(d.recall).toHaveBeenCalledTimes(1);
    expect(d.record).toHaveBeenCalledTimes(1);

    invalidateMemoryForSession("ses_1");
    await recallSection(project, "ses_1", "重召", d);
    expect(d.recall).toHaveBeenCalledTimes(2);
  });

  it("不同 session 各自召回", async () => {
    const d = deps();
    await recallSection(project, "ses_1", "a", d);
    await recallSection(project, "ses_2", "b", d);
    expect(d.recall).toHaveBeenCalledTimes(2);
  });

  it("换绑（bankId 变化）后缓存条目失效，重新召回", async () => {
    const d = deps();
    await recallSection(project, "ses_1", "a", d);
    d.getBinding.mockReturnValue(binding({ bankId: "ws_newbank", bankName: "新库" }));
    await recallSection(project, "ses_1", "b", d);
    expect(d.recall).toHaveBeenCalledTimes(2);
    expect(d.recall).toHaveBeenLastCalledWith("ws_newbank", expect.any(String), expect.anything());
  });
});

describe("section 格式与记录", () => {
  it("背景块带来源声明与逐条 id；recordRecall 落 goalDigest 与命中数", async () => {
    const d = deps();
    const section = await recallSection(project, "ses_9", "目标文本", d);
    expect(section).toContain("## 项目记忆");
    expect(section).toContain("可能过期");
    expect(section).toContain("[id:m1]");
    expect(d.record).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({ sessionId: "ses_9", hitCount: 2, hits: expect.any(Array) }),
    );
    const digest = (d.record as ReturnType<typeof vi.fn>).mock.calls[0][1] as { goalDigest: string };
    expect(digest.goalDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("查询文本截断到 400 字符（query 不超发）", async () => {
    const d = deps();
    await recallSection(project, "ses_1", "长".repeat(1000), d);
    const arg = (d.recall as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, string];
    expect(arg[1].length).toBeLessThanOrEqual(400);
  });
});
