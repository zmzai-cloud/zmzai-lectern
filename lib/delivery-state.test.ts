import { describe, expect, it } from "vitest";

import {
  aggregateVerification,
  canAccept,
  canTransition,
  isSnapshotStale,
  resolveVerificationStatus,
} from "./delivery-state.js";
import type { CommandRun } from "./delivery-types.js";

function run(over: Partial<CommandRun> & { requirement: "required" | "advisory"; status: CommandRun["status"] }): CommandRun {
  return {
    id: `run-${Math.random()}`,
    deliveryAttemptId: "att",
    kind: "verification",
    label: "test",
    command: "echo hi",
    cwd: "/tmp",
    startedAt: new Date().toISOString(),
    output: "",
    outputTruncated: false,
    outputBytes: 0,
    ...over,
  };
}

describe("delivery 状态机转换", () => {
  it("允许合法转换 running -> verifying", () => {
    expect(canTransition("running", "verifying")).toBe(true);
  });

  it("允许 verifying -> ready_for_review / verification_failed / unverified / cancelled", () => {
    expect(canTransition("verifying", "ready_for_review")).toBe(true);
    expect(canTransition("verifying", "verification_failed")).toBe(true);
    expect(canTransition("verifying", "unverified")).toBe(true);
    expect(canTransition("verifying", "cancelled")).toBe(true);
  });

  it("拒绝终态之间的转换与自反转换", () => {
    expect(canTransition("accepted", "discarded")).toBe(false);
    expect(canTransition("discarded", "accepted")).toBe(false);
    expect(canTransition("running", "running")).toBe(false);
    expect(canTransition("ready_for_review", "ready_for_review")).toBe(false);
  });

  it("拒绝非法的越级转换", () => {
    // running 不能直接到 ready_for_review / verification_failed / unverified
    expect(canTransition("running", "ready_for_review")).toBe(false);
    expect(canTransition("running", "verification_failed")).toBe(false);
    expect(canTransition("running", "unverified")).toBe(false);
    // verification_failed 不能直接被 Agent 文案改回 completed
    expect(canTransition("verification_failed", "ready_for_review")).toBe(false);
    // accepted/discarded 是终态，无出边
    expect(canTransition("accepted", "running")).toBe(false);
    expect(canTransition("discarded", "running")).toBe(false);
  });

  it("cancelled 可从 running / verifying 进入", () => {
    expect(canTransition("running", "cancelled")).toBe(true);
    expect(canTransition("verifying", "cancelled")).toBe(true);
  });

  it("快照失效可退回 unverified（从 ready_for_review / verification_failed）", () => {
    expect(canTransition("ready_for_review", "unverified")).toBe(true);
    expect(canTransition("verification_failed", "unverified")).toBe(true);
  });
});

describe("required/advisory 聚合", () => {
  it("零 required -> unverified(no_required_checks)，advisory 通过不能伪装成通过", () => {
    const runs = [
      run({ requirement: "advisory", status: "passed" }),
      run({ requirement: "advisory", status: "passed" }),
    ];
    const agg = aggregateVerification(runs);
    expect(agg.hasRequired).toBe(false);
    expect(resolveVerificationStatus(runs)).toEqual({ status: "unverified", unverifiedReason: "no_required_checks" });
  });

  it("所有 required 通过 -> ready_for_review", () => {
    const runs = [
      run({ requirement: "required", status: "passed" }),
      run({ requirement: "required", status: "passed" }),
      run({ requirement: "advisory", status: "failed" }), // advisory 失败不影响 required 结论
    ];
    expect(resolveVerificationStatus(runs)).toEqual({ status: "ready_for_review" });
  });

  it("任一 required 失败 -> verification_failed，即使另一个 required 通过", () => {
    const runs = [
      run({ requirement: "required", status: "passed" }),
      run({ requirement: "required", status: "failed" }),
    ];
    expect(resolveVerificationStatus(runs)).toEqual({ status: "verification_failed" });
  });

  it("running / cancelled 命令不参与终态判定", () => {
    const runs = [
      run({ requirement: "required", status: "passed" }),
      run({ requirement: "required", status: "cancelled" }),
    ];
    // 只有一条 required passed，cancelled 不计 -> 仍 ready_for_review
    expect(resolveVerificationStatus(runs)).toEqual({ status: "ready_for_review" });
  });
});

describe("接受/快照失效判定", () => {
  it("ready_for_review 可接受", () => {
    expect(canAccept("ready_for_review")).toBe(true);
  });

  it("unverified(no_required_checks) 可二次确认接受", () => {
    expect(canAccept("unverified", "no_required_checks")).toBe(true);
  });

  it("unverified(snapshot_stale) 永不可接受", () => {
    expect(canAccept("unverified", "snapshot_stale")).toBe(false);
    expect(isSnapshotStale("unverified", "snapshot_stale")).toBe(true);
  });

  it("verification_failed / running / verifying 不可接受", () => {
    expect(canAccept("verification_failed")).toBe(false);
    expect(canAccept("running")).toBe(false);
    expect(canAccept("verifying")).toBe(false);
  });
});
