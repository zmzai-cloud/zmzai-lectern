/**
 * 交付状态机（纯函数，无 IO）——对应设计文档「不可变尝试与状态机」一节。
 *
 * 唯一合法路径：running -> verifying -> ready_for_review | verification_failed | unverified。
 * - cancelled：可从 running / verifying 等非终态进入。
 * - accepted / discarded：终态，只能作用于 active attempt。
 *
 * 本模块只回答「转换是否合法」与「required/advisory 如何聚合」，
 * 不碰数据库 / git / 文件系统，保证可独立单测。
 */

import type {
  CommandRun,
  DeliveryStatus,
  UnverifiedReason,
  VerificationAggregate,
} from "./delivery-types.js";

/** 终态集合。 */
export const TERMINAL_STATUSES: ReadonlySet<DeliveryStatus> = new Set([
  "accepted",
  "discarded",
]);

/** 状态转换表：from -> 允许到达的 to 集合。 */
const TRANSITIONS: Record<DeliveryStatus, ReadonlySet<DeliveryStatus>> = {
  running: new Set(["verifying", "cancelled"]),
  verifying: new Set(["ready_for_review", "verification_failed", "unverified", "cancelled"]),
  ready_for_review: new Set(["accepted", "discarded", "unverified", "running"]),
  verification_failed: new Set(["discarded", "running", "unverified"]),
  unverified: new Set(["discarded", "running", "verifying", "accepted"]),
  cancelled: new Set(["discarded", "running"]),
  accepted: new Set([]),
  discarded: new Set([]),
};

/**
 * 判断一次状态转换是否合法。
 * @returns true 表示 from -> to 是允许的转换。
 */
export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  // 不允许任何状态转回已终态之外的自反 no-op；同状态转换一律非法（避免假动作）
  if (from === to) return false;
  const allowed = TRANSITIONS[from];
  return allowed !== undefined && allowed.has(to);
}

/**
 * 断言一次转换合法；非法则抛出带说明的错误。
 * 供 service 层在写库前调用，避免非法状态落盘。
 */
export function assertTransition(from: DeliveryStatus, to: DeliveryStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法状态转换：${from} -> ${to}`);
  }
}

/**
 * required/advisory 聚合（对应「验证必须是证据」与「required 优先」）：
 * - 存在任一 required 失败 -> verification_failed。
 * - 存在 required 且全部通过 -> ready_for_review。
 * - 零 required -> unverified（no_required_checks）。
 * advisory 结果绝不改变「通过/失败/未验证」三选一的结论。
 */
export function aggregateVerification(runs: CommandRun[]): VerificationAggregate {
  const agg: VerificationAggregate = {
    hasRequired: false,
    requiredPassed: false,
    requiredFailed: false,
    advisoryPassed: false,
    advisoryFailed: false,
  };
  for (const run of runs) {
    // 未完成（running/cancelled）的命令不参与终态判定
    if (run.status === "running") continue;
    if (run.requirement === "required") {
      agg.hasRequired = true;
      if (run.status === "passed") agg.requiredPassed = true;
      else if (run.status === "failed") agg.requiredFailed = true;
    } else {
      if (run.status === "passed") agg.advisoryPassed = true;
      else if (run.status === "failed") agg.advisoryFailed = true;
    }
  }
  return agg;
}

/**
 * 由聚合结果推导验证终态：
 * - 任一 required 失败 -> verification_failed
 * - 有 required 且全部通过 -> ready_for_review
 * - 零 required -> unverified（reason=no_required_checks）
 */
export function resolveVerificationStatus(
  runs: CommandRun[],
): { status: DeliveryStatus; unverifiedReason?: UnverifiedReason } {
  const agg = aggregateVerification(runs);
  if (agg.requiredFailed) return { status: "verification_failed" };
  if (agg.hasRequired && agg.requiredPassed) return { status: "ready_for_review" };
  // 有 required 但既无失败也无全部通过（理论不可达，因为 required 命令只有 passed/failed/cancelled，
  // cancelled 已被跳过；这里防御性处理为未验证）
  if (agg.hasRequired) return { status: "verification_failed" };
  return { status: "unverified", unverifiedReason: "no_required_checks" };
}

/** 判断一个 attempt 是否允许执行「接受并合并」。 */
export function canAccept(status: DeliveryStatus, unverifiedReason?: UnverifiedReason): boolean {
  // ready_for_review 可直接接受；unverified 仅在 no_required_checks 时允许二次确认接受
  if (status === "ready_for_review") return true;
  if (status === "unverified") return unverifiedReason === "no_required_checks";
  return false;
}

/** 判断一个 attempt 是否因快照失效而永远不可接受（snapshot_stale）。 */
export function isSnapshotStale(status: DeliveryStatus, unverifiedReason?: UnverifiedReason): boolean {
  return status === "unverified" && unverifiedReason === "snapshot_stale";
}
