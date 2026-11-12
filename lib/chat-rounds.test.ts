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

  // ── 流式防震荡（2026-11-12 统一重构的核心回归）──
  // 模型边说边做时，尾部 text 无法预知后续是否还有工具。若按静止规则判成
  // reply 并 closeProcess，工具一到 text 被重新归类 → 新组节点 → React key
  // 变化 → WorkflowGroup 重挂载（用户手动收起状态丢失、反复展开收起）。
  // 规则：running 时尾部 text 是 streaming reply 且不终结过程组；工具到达时
  // 被吸收进**同一个**组（组 id 全程不变）；run 结束后 text 落为最终回复。
  it("流式三阶段：组 id 全程稳定，text 最终落为回复", () => {
    const base = [
      msgs("user", "u1", [text("t0", "u1")]),
    ];
    // 阶段 1：run 进行中，工具完成 + 尾部 text 正在流式
    const stage1 = buildRounds([...base, msgs("assistant", "a1", [tool("c1", "a1"), text("n1", "a1", "我先看看目录")])], { running: true });
    const g1 = stage1[0]!.nodes[0]!;
    expect(g1.kind).toBe("process");
    if (g1.kind !== "process") throw new Error("unreachable");
    const groupId = g1.id;
    expect(stage1[0]!.nodes[1]).toMatchObject({ kind: "reply", id: "n1", streaming: true });
    // 组未被尾部 text 终结：后续工具可加入同一组
    // 阶段 2：后续工具到达（同消息追加），text 重新归类为中途叙述
    const stage2 = buildRounds([...base, msgs("assistant", "a1", [tool("c1", "a1"), text("n1", "a1", "我先看看目录"), tool("c2", "a1", "grep")])], { running: true });
    const g2 = stage2[0]!.nodes[0]!;
    expect(g2.kind).toBe("process");
    if (g2.kind !== "process") throw new Error("unreachable");
    expect(g2.id).toBe(groupId); // ← React key 不变：无重挂载，展开态/手动收起不丢
    expect(g2.items.map((i) => i.part.id)).toEqual(["c1", "n1", "c2"]);
    expect(stage2[0]!.nodes).toHaveLength(1); // text 被吸收，无游离 reply
    // 阶段 3：run 结束，末尾结论落为最终回复并收组
    const stage3 = buildRounds([...base, msgs("assistant", "a1", [tool("c1", "a1"), text("n1", "a1", "我先看看目录"), tool("c2", "a1"), text("ans", "a1", "结论")])], { running: false });
    const g3 = stage3[0]!.nodes[0]!;
    expect(g3.kind).toBe("process");
    if (g3.kind !== "process") throw new Error("unreachable");
    expect(g3.id).toBe(groupId); // ← 收尾重算也不换 id：组平滑收起而非重挂载
    expect(g3.items.map((i) => i.part.id)).toEqual(["c1", "n1", "c2"]);
    expect(stage3[0]!.nodes[1]).toMatchObject({ kind: "reply", id: "ans", final: true });
  });

  it("running 时纯文本回复也是 streaming reply（run 结束才转 final）", () => {
    const running = buildRounds([
      msgs("user", "u1", [text("t0", "u1")]),
      msgs("assistant", "a1", [text("ans", "a1", "纯回答")]),
    ], { running: true });
    expect(running[0]!.nodes[0]).toMatchObject({ kind: "reply", id: "ans", streaming: true });
    const idle = buildRounds([
      msgs("user", "u1", [text("t0", "u1")]),
      msgs("assistant", "a1", [text("ans", "a1", "纯回答")]),
    ], { running: false });
    expect(idle[0]!.nodes[0]).toMatchObject({ kind: "reply", id: "ans", final: true });
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
