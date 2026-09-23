/**
 * Lectern「本地可信交付」核心类型（P0）。
 *
 * 设计来源：docs/superpowers/specs/2026-09-02-trusted-delivery-browser-qa-design.md
 *
 * 关键不变量：
 * - DeliveryOwner 由服务端从认证 session 推导，绝不信任客户端提交的 projectId /
 *   sessionId / root / artifact path / 父子资源关系。
 * - DeliveryAttempt 不可变：进入 verifying 时捕获验证快照，之后任何证据展示、
 *   合并前都必须重新计算并完全比对该快照。
 * - 状态机唯一合法路径 running -> verifying -> ready_for_review | verification_failed
 *   | unverified；cancelled 可从非终态进入；只有 active attempt 可 accepted/discarded。
 */

/** 交付边界：任务在某个 session/worktree 内的归属。 */
export type DeliveryOwner = {
  projectId: string;
  sessionId: string;
  /** 该 session 的有效工作区根（worktree 若启用隔离，否则项目根）。 */
  effectiveWorkspaceRoot: string;
};

/** 交付状态机（8 态）。 */
export type DeliveryStatus =
  | "running"
  | "verifying"
  | "ready_for_review"
  | "verification_failed"
  | "unverified"
  | "cancelled"
  | "accepted"
  | "discarded";

/** 未验证原因：零 required 检查，或原验证快照已失效。 */
export type UnverifiedReason = "no_required_checks" | "snapshot_stale";

/** 验证快照：进入 verifying 的原子转换时捕获的不可变指纹。 */
export type DeliverySnapshot = {
  /** 验证时的 base ref HEAD（若在 git 仓库且非隔离，通常等于 worktreeHeadSha）。 */
  baseHeadSha?: string;
  /** 验证时的 worktree HEAD。 */
  worktreeHeadSha?: string;
  /** W1-S27：验证时整合目标 ref（workspace.targetRef）的 HEAD——
   *  隔离会话接受时的目标 CAS 锚点（目标推进 → 拒绝重新验证）。 */
  targetHeadSha?: string;
  /** V1-S2：捕获时从 setup manifest 冻结的可写缓存目录排除集（spec §11.2
   *  末段「预先声明」——核对用快照里的冻结值，事后改 manifest 扩大排除无效）。 */
  cacheExcludes?: string[];
  /** 由 tracked + untracked 变更共同计算的工作区指纹。 */
  worktreeFingerprint: string;
  /** 实际使用的执行计划 hash（P0 未上线 plan 时为 null/undefined）。 */
  executionPlanHash?: string;
  /** 以临时 Git index 物化出的 immutable delivery commit。 */
  deliveryCommitSha?: string;
  /** immutable delivery commit 的 tree。 */
  deliveryTreeSha?: string;
  capturedAt: string;
};

/** 命令记录：结构化、脱敏、限额。 */
export type CommandRunStatus = "running" | "passed" | "failed" | "cancelled";

export type CommandRun = {
  id: string;
  deliveryAttemptId: string;
  /** agent / verification / service / browser_qa。P0 只实现 agent 与 verification。 */
  kind: "agent" | "verification" | "service" | "browser_qa" | "computer_use";
  /** required 命令只能来自用户批准的 plan；advisory 为 Agent 其它命令。 */
  requirement: "required" | "advisory";
  label: string;
  command: string;
  cwd: string;
  status: CommandRunStatus;
  exitCode?: number;
  /** 耗时（毫秒）。 */
  durationMs?: number;
  startedAt: string;
  endedAt?: string;
  /** 脱敏且限额后的输出（容量上限内）。 */
  output: string;
  outputTruncated: boolean;
  /** 原始输出字节数（截断前）。 */
  outputBytes: number;
  /** 该命令运行时所对应的验证快照指纹（若有）。 */
  verificationSnapshotFingerprint?: string;
};

/** 任务交付容器。 */
export type TaskDelivery = DeliveryOwner & {
  id: string;
  /** 目标合并分支（非隔离会话时为主工作区当前分支）。 */
  baseRef?: string;
  /** 隔离会话的 worktree 分支。 */
  worktreeBranch?: string;
  activeAttemptId?: string;
  createdAt: string;
  updatedAt: string;
};

/** 不可变交付尝试。 */
export type DeliveryAttempt = DeliveryOwner & {
  id: string;
  deliveryId: string;
  /** 关联的 Agent run（sessionId 内的某次 run 标识，P0 用时间戳序列）。 */
  runId: string;
  sequence: number;
  status: DeliveryStatus;
  unverifiedReason?: UnverifiedReason;
  approvedExecutionPlanId?: string;
  verificationSnapshot?: DeliverySnapshot;
  /** 被本 attempt supersede 的前一 attempt。 */
  supersedesAttemptId?: string;
  supersededAt?: string;
  changedPaths: string[];
  summary?: string;
  risks: string[];
  createdAt: string;
  updatedAt: string;
};

/** required/advisory 验证检查聚合结果。 */
export type VerificationAggregate = {
  /** 是否至少有一个 required 检查。 */
  hasRequired: boolean;
  requiredPassed: boolean;
  requiredFailed: boolean;
  advisoryPassed: boolean;
  advisoryFailed: boolean;
};

/** 合并（Git CAS）结果。 */
export type DeliveryMergeResult =
  | { ok: true; mergeCommitSha: string; baseRef: string }
  | { ok: false; reason: DeliveryMergeRejectReason; detail?: string };

export type DeliveryMergeRejectReason =
  | "not_git_repo"
  | "no_attempt"
  | "not_active_attempt"
  | "bad_status"
  | "snapshot_stale"
  | "no_delivery_commit"
  | "base_ref_moved"
  | "worktree_dirty"
  | "cas_failed"
  /** W1-S27：整合序列（WorkspaceService.integrate）失败的映射结果。 */
  | "integration_conflict"
  | "integration_failed";
