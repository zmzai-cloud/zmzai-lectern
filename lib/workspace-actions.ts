/** W1-S27 写路径收敛：会话级「合并回目标 / 丢弃副本」动作。
 *
 *  供 Next 路由（app/api/sessions/[id]/worktree）与 Host handler（S27-C）共用，
 *  单一实现清偿 M2b「两套合并并存」：旧 lib/worktree.ts 的 mergeWorktree
 *  （跟随主目录当前分支/合并后删目录）不再被任何入口调用。
 *
 *  序列（spec §10.1/§10.3）：
 *  - 交付门：会话有进行中的 delivery attempt → 拒绝，必须走交付接受流程
 *    （旧 worktree merge 不得绕过交付检查）；
 *  - merge：workspace 记录（legacy 会话先 adopt 导入）→ ready_for_review →
 *    整合序列（CAS 锚点 = 点击时刻目标 ref 现值，整合期间的推进由 CAS 兜底）；
 *  - discard：deleteWorkspace 删序查返回码，失败保留可修复记录；legacy 兜底旧清理。 */
import { dataDir } from "./runtime-constants.js";
import { getActiveAttempt, getDeliveryForSession } from "./delivery.js";
import { removeWorktree } from "./worktree.js";
import {
  adoptWorkspace,
  currentTargetCommit,
  deleteWorkspace,
  integrateWorkspace,
  markReadyForReview,
  workspaceRecordForSession,
} from "./workspace-service.js";

export type SessionWorkspaceAction = { ok: boolean; output: string; status: number };

/** 合并回目标分支（整合）。成功后工作区保留（integrated 会话继续指向原工作区）。 */
export async function mergeSessionWorkspace(sessionId: string): Promise<SessionWorkspaceAction> {
  // 交付门：有未终结的交付验证 → 必须走交付面板接受（证据约束不可绕过）
  const delivery = getDeliveryForSession(sessionId);
  const active = delivery ? getActiveAttempt(delivery.id) : null;
  if (active && active.status !== "accepted" && active.status !== "discarded" && active.status !== "cancelled") {
    return { ok: false, output: "该会话有进行中的交付验证，请通过交付流程接受合并（不得绕过交付检查）", status: 409 };
  }

  const ws = workspaceRecordForSession(dataDir, sessionId) ?? (await adoptWorkspace(dataDir, sessionId));
  if (!ws) return { ok: false, output: "会话没有隔离副本", status: 409 };

  const expected = await currentTargetCommit(dataDir, ws.workspaceId);
  if (!expected) {
    return { ok: false, output: "工作区创建于 detached HEAD，无有效目标分支；请显式指定目标分支后整合", status: 409 };
  }
  markReadyForReview(dataDir, ws.workspaceId);
  const result = await integrateWorkspace(dataDir, ws.workspaceId, { expectedTargetCommit: expected });
  if (!result.ok) {
    return { ok: false, output: `整合未完成（${result.reason}）：${result.record?.failureReason ?? ""}`.trim(), status: 409 };
  }
  return {
    ok: true,
    output: `已整合到 ${ws.targetRef}（${result.record.integrationCommit?.slice(0, 12) ?? ""}）；工作区保留，会话继续指向原工作区`,
    status: 200,
  };
}

/** 丢弃隔离副本（显式丢弃意图；删序查返回码，失败保留可修复记录）。 */
export async function discardSessionWorkspace(sessionId: string): Promise<SessionWorkspaceAction> {
  const ws = workspaceRecordForSession(dataDir, sessionId) ?? (await adoptWorkspace(dataDir, sessionId));
  if (ws) {
    const del = await deleteWorkspace(dataDir, ws.workspaceId, { discardUnintegrated: true });
    if (!del.ok) return { ok: false, output: `删除未完成（可修复记录已保留）：${del.failures.join("；")}`, status: 409 };
    return { ok: true, output: "隔离副本已丢弃", status: 200 };
  }
  // legacy 旧表会话（未 adopt 成功/无新记录）：旧清理兜底（新会话不再产生旧表行）
  await removeWorktree(sessionId);
  return { ok: true, output: "隔离副本已丢弃", status: 200 };
}
