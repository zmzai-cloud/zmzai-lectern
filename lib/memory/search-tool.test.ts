import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@zmzai/agent-framework";

const mocks = vi.hoisted(() => ({ search: vi.fn() }));

vi.mock("./service.js", () => ({ searchProjectMemory: mocks.search }));

import { createMemorySearchTool } from "./search-tool.js";

const project = { id: "p_1", name: "项目" };
const ctx = { sessionId: "ses_1" } as ToolContext;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("memory_search（Lectern）", () => {
  it("是只读工具且跳过审批", () => {
    const tool = createMemorySearchTool(project);
    expect(tool.id).toBe("memory_search");
    expect(tool.permission({ query: "x", limit: 8 })).toBeNull();
    expect(tool.contract).toMatchObject({ effect: [], retrySafety: "read_only" });
  });

  it("格式化命中条目并带 memoryId", async () => {
    mocks.search.mockResolvedValue({
      status: "hit",
      hits: [{ memoryId: "m1", text: "构建用 pnpm test", score: 0.9 }],
      deduped: 0,
      bankId: "lec_bank1",
    });
    const result = await createMemorySearchTool(project).execute({ query: "怎么跑测试", limit: 8 }, ctx);
    expect(result.output).toContain("[m1] 构建用 pnpm test (0.90)");
    expect(result.output).toContain("标注 [memoryId]");
    expect(result.metadata).toMatchObject({ status: "hit", count: 1, bankId: "lec_bank1" });
    expect(mocks.search).toHaveBeenCalledWith(project, "ses_1", "怎么跑测试", 8);
  });

  it("全部已注入时提示无需重复查询", async () => {
    mocks.search.mockResolvedValue({ status: "deduped", hits: [], deduped: 3, bankId: "lec_bank1" });
    const result = await createMemorySearchTool(project).execute({ query: "q", limit: 8 }, ctx);
    expect(result.output).toContain("已在本次任务的背景记忆中注入");
  });

  it("凭据失效与服务不可用都如实回报但不抛错", async () => {
    const tool = createMemorySearchTool(project);
    mocks.search.mockResolvedValueOnce({ status: "unauthenticated" });
    expect((await tool.execute({ query: "q", limit: 8 }, ctx)).output).toContain("未接通或登录状态已失效");

    mocks.search.mockResolvedValueOnce({ status: "unavailable" });
    expect((await tool.execute({ query: "q", limit: 8 }, ctx)).output).toContain("暂不可用");
  });
});
