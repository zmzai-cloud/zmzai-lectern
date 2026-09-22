/**
 * EvidencePacket：为自动修复 / 后续 Agent 注入的最小脱敏证据包。
 *
 * 对应设计文档「默认模型上下文采用最小证据包」与「Token 成本是可观测的产品约束」：
 * 只含任务意图、当前 attempt、验证快照、相关 diff、脱敏失败摘要与有限命令尾部；
 * 禁止注入全量日志、完整会话、全文件树、截图二进制或重复工具结果。
 *
 * 去重：同一验证快照下的重复工具结果、未变化 Git 状态、同一 artifact 不得重复注入。
 */

import { fingerprintOf, REDACTED, redact, truncateToBytes } from "./sanitize.js";
import type {
  CommandRun,
  DeliveryAttempt,
  DeliverySnapshot,
} from "./delivery-types.js";

/** 命令尾部输出最多保留行数。 */
export const COMMAND_TAIL_LINES = 20;
/** 命令尾部输出字节上限。 */
export const COMMAND_TAIL_BYTES = 4 * 1024;
/** diff 字节上限。 */
export const DIFF_BYTES = 64 * 1024;

export type EvidenceCommandTail = {
  label: string;
  requirement: "required" | "advisory";
  status: string;
  exitCode?: number;
  tail: string;
};

export type EvidencePacket = {
  schemaVersion: 1;
  taskIntent: string;
  attemptId: string;
  deliveryId: string;
  sequence: number;
  status: string;
  unverifiedReason?: string;
  verificationSnapshot?: {
    baseHeadSha?: string;
    worktreeHeadSha?: string;
    worktreeFingerprint: string;
    deliveryCommitSha?: string;
  };
  changedPaths: string[];
  diff: string;
  failureSummary: string;
  commandTails: EvidenceCommandTail[];
  risks: string[];
  /** 本证据包内已包含的 diff/命令尾部指纹，供去重。 */
  _dedup: string[];
};

/** 取命令输出的尾部 N 行并限额（先脱敏，再按行取尾，再按字节截断）。 */
export function commandTail(run: CommandRun, lines = COMMAND_TAIL_LINES, bytes = COMMAND_TAIL_BYTES): string {
  const cleaned = redact(run.output);
  const lineList = cleaned.split("\n");
  const tailLines = lineList.slice(-lines);
  return truncateToBytes(tailLines.join("\n"), bytes);
}

/** 生成失败摘要：只含失败命令的 label + 状态 + 退出码，脱敏。 */
export function failureSummary(runs: CommandRun[]): string {
  const failed = runs.filter((r) => r.status === "failed");
  if (failed.length === 0) return "";
  const parts = failed.map((r) => {
    const base = `[${r.requirement}] ${r.label} failed`;
    return r.exitCode != null ? `${base} (exit ${r.exitCode})` : base;
  });
  return redact(parts.join("; "));
}

/**
 * 构造最小证据包。dedupeKey 由调用方传入（通常 = snapshot fingerprint + diff 指纹），
 * 用于在服务层做「同一 snapshot 的重复工具结果不得重复注入」的去重。
 */
export function buildEvidencePacket(input: {
  taskIntent: string;
  attempt: DeliveryAttempt;
  diff: string;
  commandRuns: CommandRun[];
  snapshot: DeliverySnapshot | undefined;
}): EvidencePacket {
  const { taskIntent, attempt, diff, commandRuns, snapshot } = input;
  const diffLimited = truncateToBytes(redact(diff), DIFF_BYTES);
  const tails = commandRuns.map((r) => ({
    label: r.label,
    requirement: r.requirement,
    status: r.status,
    ...(r.exitCode != null ? { exitCode: r.exitCode } : {}),
    tail: commandTail(r),
  }));

  const dedup = [
    snapshot?.worktreeFingerprint ?? "",
    fingerprintOf(diffLimited),
    ...commandRuns.map((r) => fingerprintOf(`${r.id}:${r.output}`)),
  ].filter(Boolean);

  return {
    schemaVersion: 1,
    taskIntent,
    attemptId: attempt.id,
    deliveryId: attempt.deliveryId,
    sequence: attempt.sequence,
    status: attempt.status,
    ...(attempt.unverifiedReason ? { unverifiedReason: attempt.unverifiedReason } : {}),
    verificationSnapshot: snapshot
      ? {
          ...(snapshot.baseHeadSha ? { baseHeadSha: snapshot.baseHeadSha } : {}),
          ...(snapshot.worktreeHeadSha ? { worktreeHeadSha: snapshot.worktreeHeadSha } : {}),
          worktreeFingerprint: snapshot.worktreeFingerprint,
          ...(snapshot.deliveryCommitSha ? { deliveryCommitSha: snapshot.deliveryCommitSha } : {}),
        }
      : undefined,
    changedPaths: attempt.changedPaths.slice(),
    diff: diffLimited,
    failureSummary: failureSummary(commandRuns),
    commandTails: tails,
    risks: attempt.risks.slice(),
    _dedup: dedup,
  };
}

/** 判断两个证据包是否指向同一验证快照下的相同证据（去重命中）。 */
export function isDuplicateEvidence(a: EvidencePacket, b: EvidencePacket): boolean {
  const keyA = a.verificationSnapshot?.worktreeFingerprint ?? "";
  const keyB = b.verificationSnapshot?.worktreeFingerprint ?? "";
  if (!keyA || !keyB || keyA !== keyB) return false;
  return fingerprintOf(a.diff) === fingerprintOf(b.diff);
}

export { REDACTED };
