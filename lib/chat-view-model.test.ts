import { describe, expect, it } from "vitest";

import type { UiMessage, UiPart } from "./chat-projector.js";
import { buildMessageSlots, mergeOptimisticMessage, type OptimisticEcho } from "./chat-view-model.js";

function text(id: string, value = id): UiPart {
  return { part: { id, messageId: "m1", sessionId: "s1", type: "text", text: value } };
}

function tool(id: string): UiPart {
  return { part: { id, callId: `${id}-call`, messageId: "m1", sessionId: "s1", type: "tool", tool: "read", state: { status: "completed", input: {}, output: "", title: id, time: { start: "2026-10-26T00:00:00Z", end: "2026-10-26T00:00:01Z" } } } };
}

describe("buildMessageSlots", () => {
  // 2026-11-10 语义变更（对齐 dsh/Codex 连续过程块）：工具间还有后续工具的
  // text 叙述并入过程块——过程是连续一块，不再切成 [过程组][text][过程组] 碎片；
  // 末尾结论（后面没有工具）保持独立正文段。
  it("工具间的叙述并入过程块，末尾结论保持独立", () => {
    const slots = buildMessageSlots([
      text("intro"),
      tool("read-1"),
      { part: { id: "reason-1", messageId: "m1", sessionId: "s1", type: "reasoning", text: "checking" } },
      text("middle"),
      tool("read-2"),
      text("answer"),
    ]);

    expect(slots.map((slot) => slot.kind === "flow" ? `flow:${slot.items.map((item) => item.part.id).join(",")}` : `part:${slot.id}`)).toEqual([
      "flow:intro,read-1,reason-1,middle,read-2",
      "part:answer",
    ]);
  });

  it("没有后续工具的正文不被并入（开头叙述+结论都保持正文）", () => {
    const slots = buildMessageSlots([
      text("opening"),
      text("answer"),
    ]);
    expect(slots.every((slot) => slot.kind === "part")).toBe(true);
  });
});

describe("mergeOptimisticMessage", () => {
  const history: UiMessage[] = [{
    id: "old-user",
    role: "user",
    parts: [text("old-text", "重复内容")],
  }];
  const echo: OptimisticEcho = {
    text: "重复内容",
    images: [],
    requestId: "request-1",
  };

  it("does not mistake identical history for the new message before acceptance", () => {
    const visible = mergeOptimisticMessage(history, echo);
    expect(visible.map((message) => message.id)).toEqual(["old-user", "__echo__"]);
  });

  it("replaces only the acknowledged message id", () => {
    const visible = mergeOptimisticMessage(history, { ...echo, userMessageId: "new-user" });
    expect(visible.map((message) => message.id)).toEqual(["old-user", "__echo__"]);

    const arrived = [...history, { id: "new-user", role: "user", parts: [text("new-text", "重复内容")] }];
    expect(mergeOptimisticMessage(arrived, { ...echo, userMessageId: "new-user" })).toBe(arrived);
  });
});
