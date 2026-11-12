import { describe, expect, it } from "vitest";

import type { UiMessage, UiPart } from "./chat-projector.js";
import { mergeOptimisticMessage, type OptimisticEcho } from "./chat-view-model.js";

// 旧 buildMessageSlots 分组器测试已随实现删除（2026-11-12 统一重构）：
// 分组语义的回归由 lib/chat-rounds.test.ts 覆盖（DSH 式全会话轮次树）。

function text(id: string, value = id): UiPart {
  return { part: { id, messageId: "m1", sessionId: "s1", type: "text", text: value } };
}

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
