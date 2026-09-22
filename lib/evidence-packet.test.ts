import { describe, expect, it } from "vitest";

import {
  buildEvidencePacket,
  commandTail,
  failureSummary,
  isDuplicateEvidence,
} from "./evidence-packet.js";
import type { CommandRun, DeliveryAttempt, DeliverySnapshot } from "./delivery-types.js";

const SNAPSHOT: DeliverySnapshot = {
  worktreeFingerprint: "fingerprint-1",
  deliveryCommitSha: "abc123",
  baseHeadSha: "base1",
  capturedAt: new Date().toISOString(),
};

function attempt(over: Partial<DeliveryAttempt> = {}): DeliveryAttempt {
  return {
    id: "att-1",
    deliveryId: "del-1",
    runId: "run-1",
    sequence: 1,
    status: "ready_for_review",
    changedPaths: ["a.ts", "b.ts"],
    risks: [],
    projectId: "default",
    sessionId: "sess-1",
    effectiveWorkspaceRoot: "/tmp/root",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function run(over: Partial<CommandRun> = {}): CommandRun {
  return {
    id: "run-1",
    deliveryAttemptId: "att-1",
    kind: "verification",
    requirement: "required",
    label: "test",
    command: "npm test",
    cwd: "/tmp/root",
    status: "failed",
    exitCode: 1,
    startedAt: new Date().toISOString(),
    output: "line1\nline2\nline3",
    outputTruncated: false,
    outputBytes: 17,
    ...over,
  };
}

describe("commandTail", () => {
  it("只取尾部 N 行", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const r = run({ output: lines });
    const tail = commandTail(r);
    expect(tail.split("\n").length).toBeLessThanOrEqual(20);
    expect(tail).toContain("line99");
    expect(tail).not.toContain("line0");
  });
});

describe("failureSummary", () => {
  it("只汇总失败命令", () => {
    const r1 = run({ id: "a", label: "unit", status: "failed", exitCode: 1 });
    const r2 = run({ id: "b", label: "lint", status: "passed", exitCode: 0 });
    const summary = failureSummary([r1, r2]);
    expect(summary).toContain("unit");
    expect(summary).not.toContain("lint");
    expect(summary).toContain("exit 1");
  });

  it("无失败时返回空串", () => {
    expect(failureSummary([run({ status: "passed" })])).toBe("");
  });
});

describe("buildEvidencePacket", () => {
  it("只含最小字段：任务意图 + attempt + 快照 + diff + 失败摘要 + 命令尾部", () => {
    const pkt = buildEvidencePacket({
      taskIntent: "实现 X 功能",
      attempt: attempt(),
      diff: "diff --git a/a.ts",
      commandRuns: [run()],
      snapshot: SNAPSHOT,
    });
    expect(pkt.taskIntent).toBe("实现 X 功能");
    expect(pkt.attemptId).toBe("att-1");
    expect(pkt.verificationSnapshot?.worktreeFingerprint).toBe("fingerprint-1");
    expect(pkt.diff).toContain("diff --git");
    expect(pkt.failureSummary).toContain("test");
    expect(pkt.commandTails.length).toBe(1);
    // 不含全量日志/文件树/截图二进制等字段
    expect(pkt).not.toHaveProperty("fullLogs");
    expect(pkt).not.toHaveProperty("sessionTranscript");
    expect(pkt).not.toHaveProperty("fileTree");
    expect(pkt).not.toHaveProperty("screenshots");
  });

  it("脱敏 diff 与命令尾部中的 secret", () => {
    const pkt = buildEvidencePacket({
      taskIntent: "t",
      attempt: attempt(),
      diff: "API_KEY=supersecret",
      commandRuns: [run({ output: "token: Bearer xyz" })],
      snapshot: SNAPSHOT,
    });
    expect(pkt.diff).not.toContain("supersecret");
    expect(pkt.commandTails[0].tail).not.toContain("xyz");
  });
});

describe("isDuplicateEvidence", () => {
  it("同一快照指纹 + 相同 diff 视为重复", () => {
    const a = buildEvidencePacket({ taskIntent: "t", attempt: attempt(), diff: "same", commandRuns: [], snapshot: SNAPSHOT });
    const b = buildEvidencePacket({ taskIntent: "t", attempt: attempt(), diff: "same", commandRuns: [], snapshot: SNAPSHOT });
    expect(isDuplicateEvidence(a, b)).toBe(true);
  });

  it("不同快照指纹不重复", () => {
    const a = buildEvidencePacket({ taskIntent: "t", attempt: attempt(), diff: "same", commandRuns: [], snapshot: SNAPSHOT });
    const b = buildEvidencePacket({
      taskIntent: "t",
      attempt: attempt(),
      diff: "same",
      commandRuns: [],
      snapshot: { ...SNAPSHOT, worktreeFingerprint: "other" },
    });
    expect(isDuplicateEvidence(a, b)).toBe(false);
  });
});
