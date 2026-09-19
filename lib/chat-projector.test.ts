import { describe, expect, it } from "vitest";

import { ChatProjector, EMPTY_CHAT_VIEW, MESSAGE_CACHE_LIMIT, transcriptToEvents } from "./chat-projector";
import type { Artifact } from "./types";

it("bounds 10,000 streamed messages without evicting independent task snapshots", () => {
  const projector = new ChatProjector();
  projector.ingest({ type: "todo.updated", data: { todos: [{ content: "task", status: "pending" }] } });
  for (let n = 1; n <= 10000; n++) {
    projector.ingestBatch(transcriptToEvents([{ info: { id: `m${n}`, role: "assistant" }, messageSeq: n, parts: [{ id: `p${n}`, messageId: `m${n}`, sessionId: "s", type: "text", text: `${n}` }] }]));
    projector.trimMessages("tail");
  }
  expect(projector.data().messages).toHaveLength(MESSAGE_CACHE_LIMIT);
  expect(projector.bounds()).toEqual({ first: 9601, last: 10000 });
  expect(projector.data().todos).toHaveLength(1);
  projector.ingestBatch(transcriptToEvents(Array.from({ length: 50 }, (_, i) => ({ info: { id: `older${i}`, role: "user" }, messageSeq: 9551 + i, parts: [] }))), true);
  projector.trimMessages("head");
  expect(projector.bounds()).toEqual({ first: 9551, last: 9950 });
  expect(projector.hasMessage("m10000")).toBe(false);
  projector.ingest({ type: "message.part.delta", data: { messageId: "m10000", partId: "p10000", delta: "late" } });
  expect(projector.data().messages).toHaveLength(MESSAGE_CACHE_LIMIT);
});

/** 构造一个 artifact.created 事件。 */
function artifactEvent(id: string, path: string): { type: string; data: unknown } {
  return {
    type: "artifact.created",
    data: {
      artifactId: id,
      path,
      bytes: 1024,
      contentType: "text/html",
      downloadUrl: `file:///${path}`,
    },
  };
}

function summaryEvent(kind: "completed" | "aborted" | "error" = "completed"): { type: string; data: unknown } {
  return {
    type: "session.summary",
    data: { text: "本轮完成", kind, meta: { filesEdited: 1, toolCalls: 2, durationMs: 100 } },
  };
}

describe("ChatProjector 产物按 run 归集", () => {
  it("artifact.created 累积进当前 run 的 artifacts", () => {
    const p = new ChatProjector();
    p.ingest(artifactEvent("a1", "out/a.html") as never);
    p.ingest(artifactEvent("a2", "out/b.html") as never);
    const d = p.data();
    expect(d.artifacts).toHaveLength(2);
    expect(d.artifacts.map((a) => a.artifactId)).toEqual(["a2", "a1"]); // 最新在前
    expect(d.summaryArtifacts).toHaveLength(0); // 尚未封存
  });

  it("session.summary 到达时封存本轮产物、清空累积器", () => {
    const p = new ChatProjector();
    p.ingest(artifactEvent("a1", "out/a.html") as never);
    p.ingest(artifactEvent("a2", "out/b.html") as never);
    p.ingest(summaryEvent() as never);
    const d = p.data();
    // 封存进 summaryArtifacts（与 summary 一一对应），累积器清空
    expect(d.summaryArtifacts.map((a) => a.artifactId)).toEqual(["a2", "a1"]);
    expect(d.artifacts).toHaveLength(0);
  });

  it("多轮会话：每轮 summary 只挂自己的产物，不跨轮累积", () => {
    const p = new ChatProjector();
    // 第一轮：a1、a2 → summary1
    p.ingest(artifactEvent("a1", "out/a.html") as never);
    p.ingest(artifactEvent("a2", "out/b.html") as never);
    p.ingest(summaryEvent() as never);
    // 第二轮：只产生 b1 → summary2
    p.ingest(artifactEvent("b1", "out/c.html") as never);
    p.ingest(summaryEvent() as never);

    const d = p.data();
    // 最新 summary 只挂第二轮产物 b1，第一轮的 a1/a2 不再出现
    expect(d.summaryArtifacts.map((a) => a.artifactId)).toEqual(["b1"]);
    expect(d.summary).not.toBeNull();
  });

  it("同一 artifactId 去重（最新覆盖位置）", () => {
    const p = new ChatProjector();
    p.ingest(artifactEvent("a1", "out/a.html") as never);
    p.ingest(artifactEvent("a2", "out/b.html") as never);
    p.ingest(artifactEvent("a1", "out/a.html") as never); // 重复 a1
    const d = p.data();
    expect(d.artifacts.map((a) => a.artifactId)).toEqual(["a1", "a2"]); // 去重后 2 个，a1 提到最前
  });

  it("rewound 清空产物与封存集", () => {
    const p = new ChatProjector();
    p.ingest(artifactEvent("a1", "out/a.html") as never);
    p.ingest(summaryEvent() as never);
    // 重放到 rewound（fromMessageId 指向某条消息）
    p.ingest({ type: "message.updated", data: { message: { id: "m1", role: "user" } } } as never);
    p.ingest({ type: "session.rewound", data: { fromMessageId: "m1" } } as never);
    const d = p.data();
    expect(d.artifacts).toHaveLength(0);
    expect(d.summaryArtifacts).toHaveLength(0);
    expect(d.summary).toBeNull();
  });

  it("reset 后回到空态（EMPTY_CHAT_VIEW 形状）", () => {
    const p = new ChatProjector();
    p.ingest(artifactEvent("a1", "out/a.html") as never);
    p.ingest(summaryEvent() as never);
    p.reset();
    const d = p.data();
    expect(d.artifacts).toEqual([]);
    expect(d.summaryArtifacts).toEqual([]);
    expect(EMPTY_CHAT_VIEW.summaryArtifacts).toEqual([]);
    expect(EMPTY_CHAT_VIEW.artifacts).toEqual([]);
  });
});

/** 交付卡的数据来源（规格 §14.1 四问 / §18.4 完成判定依据）。
 *
 *  【为什么这几条重要】交付卡上「验收 x/y · 证据 n 条」是给用户核对「这句
 *  完成不必信」用的。此前这一行在**任何**任务上都显示 0/n：`task.started` 是
 *  唯一携带 acceptanceCriteria 的事件，而那一刻所有条件必然 pending、证据
 *  必然为 0，此后没有第二个事件带过它们。一个恒错的核对依据比没有更糟——
 *  它让一条真的交付了的任务看起来像什么都没验证。 */
describe("ChatProjector 交付卡的数据来源", () => {
  function started(): { type: string; data: unknown } {
    return {
      type: "task.started",
      data: {
        taskId: "t1",
        revision: 1,
        goal: "把 PDF 铺到网页",
        steps: [],
        acceptanceCriteria: [{ id: "crit_1", description: "页面可用", required: true, status: "pending" }],
      },
    };
  }

  function delivered(overrides: Record<string, unknown> = {}): { type: string; data: unknown } {
    return {
      type: "task.delivered",
      data: {
        taskId: "t1",
        revision: 2,
        result: "渲染文本（旧客户端用）",
        delivery: { outcome: "六步都做完了", changes: ["app/page.tsx"], verification: ["本地构建通过"], remaining: [] },
        criteria: [{ id: "crit_1", description: "页面可用", required: true, status: "passed" }],
        evidenceCount: 3,
        ...overrides,
      },
    };
  }

  it("四问读结构化 delivery，验收与证据读权威字段", () => {
    const p = new ChatProjector();
    p.ingest(started() as never);
    p.ingest(delivered() as never);
    const task = p.data().task!;
    // 关键点：`outcome` 是 delivery 里的那句话，而**不是**那段渲染文本
    expect(task.result).toEqual({
      outcome: "六步都做完了",
      changes: ["app/page.tsx"],
      verification: ["本地构建通过"],
      remaining: [],
    });
    expect(task.acceptanceCriteria[0]!.status).toBe("passed");
    expect(task.evidence?.count).toBe(3);
  });

  it("0.9.0 之前的旧帧（只有 result 文本）仍然落得出交付卡", () => {
    const p = new ChatProjector();
    p.ingest(started() as never);
    p.ingest({ type: "task.delivered", data: { taskId: "t1", revision: 2, result: "旧版渲染文本" } } as never);
    const task = p.data().task!;
    expect(task.result?.outcome).toBe("旧版渲染文本");
    expect(task.result?.remaining).toEqual([]);
    // 旧帧没有 criteria：条件保持原状，不许凭空编一个结论出来
    expect(task.acceptanceCriteria[0]!.status).toBe("pending");
  });

  it("对不上的 id、非法状态、脏元素都被丢掉，不污染现有条件", () => {
    const p = new ChatProjector();
    p.ingest(started() as never);
    p.ingest(
      delivered({
        criteria: [{ id: "crit_unknown", status: "passed" }, null, { id: "crit_1", status: "胡说" }],
        delivery: { outcome: "x", changes: ["a.ts", 42, null], verification: "不是数组", remaining: ["还有一条"] },
      }) as never,
    );
    const task = p.data().task!;
    expect(task.acceptanceCriteria).toHaveLength(1);
    expect(task.acceptanceCriteria[0]!.status).toBe("pending");
    expect(task.result?.changes).toEqual(["a.ts"]);
    expect(task.result?.verification).toEqual([]);
    expect(task.result?.remaining).toEqual(["还有一条"]);
  });

  it("没有 delivery 也没有 result 时不留一条空交付", () => {
    const p = new ChatProjector();
    p.ingest(started() as never);
    p.ingest({ type: "task.delivered", data: { taskId: "t1", revision: 2 } } as never);
    expect(p.data().task!.result).toBeUndefined();
  });
});
