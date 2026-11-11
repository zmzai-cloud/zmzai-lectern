import { describe, expect, it } from "vitest";

import { buildRounds, categoryOfTool, summarizeGroups } from "./chat-rounds.js";
import type { UiMessage, UiPart } from "./chat-projector.js";

/** DSH 式分组（docs/dsh-ui-reference/RULES.md）回归：
 *  过程按相邻聚组、回复（后无工具的正文）终结组、用户消息开新轮、
 *  换工具类型不分组。 */

function text(id: string, msg: string, value = id): UiPart {
  return { part: { id, messageId: msg, sessionId: "s", type: "text", text: value } };
}
function think(id: string, msg: string): UiPart {
  return { part: { id, messageId: msg, sessionId: "s", type: "reasoning", text: "..." } };
}
function tool(id: string, msg: string, name = "bash", status: "completed" | "running" = "completed"): UiPart {
  return { part: { id, messageId: msg, sessionId: "s", type: "tool", callId: id, tool: name,
    state: status === "completed"
      ? { status, input: {}, output: "", title: id, time: { start: "2026-11-11T00:00:00Z", end: "2026-11-11T00:00:01Z" } }
      : { status, input: {}, time: { start: "2026-11-11T00:00:00Z" } },
  } as never };
}

const msgs = (role: string, id: string, parts: UiPart[]): UiMessage & { role: string; parts: UiPart[] } =>
  ({ id, role, parts } as never);

describe("buildRounds：DSH 分组规则", () => {
  it("过程聚一组、回复独立、多轮分离", () => {
    const rounds = buildRounds([
      msgs("user", "u1", [text("t0", "u1", "问")]),
      msgs("assistant", "a1", [think("r1", "a1"), tool("c1", "a1", "read"), text("n1", "a1", "我来看看")]),
      msgs("assistant", "a2", [think("r2", "a2"), tool("c2", "a2", "bash")]),
      msgs("assistant", "a3", [text("ans", "a3", "结论")]),
      msgs("user", "u2", [text("t1", "u2", "再问")]),
      msgs("assistant", "a4", [text("ans2", "a4", "答2")]),
    ]);
    expect(rounds).toHaveLength(2);
    const r1 = rounds[0]!;
    // 一个过程组（跨 3 条消息）+ 一个回复
    expect(r1.nodes).toHaveLength(2);
    expect(r1.nodes[0]!.kind).toBe("process");
    if (r1.nodes[0]!.kind !== "process") throw new Error("unreachable");
    expect(r1.nodes[0]!.items.map((i) => i.part.id)).toEqual(["r1", "c1", "n1", "r2", "c2"]);
    expect(r1.nodes[0]!.tools).toEqual(["read", "bash"]);
    expect(r1.nodes[1]).toMatchObject({ kind: "reply", id: "ans" });
    const r2 = rounds[1]!;
    expect(r2.user?.[0]?.part.id).toBe("t1");
    expect(r2.nodes[0]).toMatchObject({ kind: "reply", id: "ans2" });
  });

  it("中途叙述归组；末尾正文=回复", () => {
    const rounds = buildRounds([
      msgs("user", "u1", [text("t0", "u1")]),
      msgs("assistant", "a1", [text("n1", "a1", "先看"), tool("c1", "a1"), text("ans", "a1", "结论")]),
    ]);
    const nodes = rounds[0]!.nodes;
    expect(nodes[0]!.kind).toBe("process");
    if (nodes[0]!.kind !== "process") throw new Error("unreachable");
    expect(nodes[0]!.items.map((i) => i.part.id)).toEqual(["n1", "c1"]);
    expect(nodes[1]).toMatchObject({ kind: "reply", id: "ans" });
  });

  it("运行中工具把组标记 running", () => {
    const rounds = buildRounds([
      msgs("user", "u1", [text("t0", "u1")]),
      msgs("assistant", "a1", [tool("c1", "a1", "bash", "running")]),
    ]);
    const node = rounds[0]!.nodes[0]!;
    expect(node.kind === "process" && node.running).toBe(true);
  });
});

describe("分类与摘要", () => {
  it("分类表：grep/glob=搜索、bash/terminal_*=命令、agent_*=子代理", () => {
    expect(categoryOfTool("grep")).toBe("search");
    expect(categoryOfTool("terminal_write")).toBe("commands");
    expect(categoryOfTool("agent_spawn")).toBe("subagents");
    expect(categoryOfTool("repo_map")).toBe("tools");
  });

  it("摘要：前三分类连接，超过三类加等", () => {
    expect(summarizeGroups(["read", "read", "bash"]).label).toBe("读取文件、运行命令");
    expect(summarizeGroups(["read", "bash", "grep", "edit"]).label).toBe("读取文件、运行命令、搜索代码等");
    expect(summarizeGroups([]).label).toBe("分析请求");
  });
});
