import { withWorkflowErrors, rethrowWorkflowError } from "@/lib/workflow-error";
import { NextResponse, type NextRequest } from "next/server";

import {
  beginAttempt,
  cancelAttempt,
  finishVerification,
  getActiveAttempt,
  getAttempt,
  getDeliveryForSession,
  isSnapshotStillValid,
  listCommandRuns,
  markAccepted,
  markDiscarded,
  markSnapshotStale,
  mergeAttemptCas,
  recordCommandRun,
  resolveCwdWithin,
  resolveOwner,
  transitionToVerifying,
} from "@/lib/delivery";
import { sanitizeOutput } from "@/lib/sanitize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

type ActionBody = {
  sessionId?: string;
  action?: string;
  attemptId?: string;
  changedPaths?: string[];
  commands?: {
    id?: string;
    kind?: "agent" | "verification" | "service" | "browser_qa";
    requirement?: "required" | "advisory";
    label?: string;
    command?: string;
    cwdRelativePath?: string;
    status?: "running" | "passed" | "failed" | "cancelled";
    exitCode?: number;
    durationMs?: number;
    startedAt?: string;
    endedAt?: string;
    output?: string;
  }[];
  allowUnverified?: boolean;
};

function requireSessionId(body: ActionBody): string {
  const sid = body.sessionId;
  if (!sid || !SAFE_ID.test(sid)) throw new Error("缺少或非法的 sessionId");
  return sid;
}

/** 校验 attempt 归属当前 session（服务端 join：attemptId 必须属于该 session 的 delivery）。 */
function assertAttemptOwned(attemptId: string, sessionId: string) {
  const attempt = getAttempt(attemptId);
  if (!attempt) throw new Error("attempt 不存在");
  if (attempt.sessionId !== sessionId) throw new Error("attempt 不属于当前会话");
  return attempt;
}

/**
 * POST /api/deliveries/attempt
 * body: { sessionId, action: "begin"|"verify"|"finish"|"accept"|"discard"|"cancel"|"commands"|"check" }
 * 单一入口，owner 全部从 sessionId 推导；attemptId 必须与该 session 的 delivery join。
 */
async function handlePOST(request: NextRequest) {
  let body: ActionBody;
  try {
    body = (await request.json()) as ActionBody;
  } catch {
    return NextResponse.json({ error: "无效请求体" }, { status: 400 });
  }

  try {
    const sessionId = requireSessionId(body);
    const owner = resolveOwner(sessionId);
    if (!owner) return NextResponse.json({ error: "会话不存在" }, { status: 404 });

    switch (body.action) {
      case "begin": {
        const attempt = beginAttempt(owner, new Date().toISOString());
        return NextResponse.json({ ok: true, attempt });
      }

      case "verify": {
        const delivery = getDeliveryForSession(sessionId);
        const active = delivery ? getActiveAttempt(delivery.id) : null;
        if (!active) return NextResponse.json({ error: "无 active attempt" }, { status: 409 });
        const attempt = await transitionToVerifying(active.id);
        return NextResponse.json({ ok: true, attempt });
      }

      case "commands": {
        const delivery = getDeliveryForSession(sessionId);
        const active = delivery ? getActiveAttempt(delivery.id) : null;
        if (!active) return NextResponse.json({ error: "无 active attempt" }, { status: 409 });
        if (!Array.isArray(body.commands)) return NextResponse.json({ error: "commands 必须是数组" }, { status: 400 });

        const saved = [];
        for (const c of body.commands) {
          if (!c.command || !c.label) continue;
          // 服务端解析 cwd：只允许 root 相对路径，拒绝绝对路径/../symlink escape
          const cwd = resolveCwdWithin(owner.effectiveWorkspaceRoot, c.cwdRelativePath);
          // required 命令只能来自已批准 plan（P0 无 plan 系统，故服务端强制 advisory——
          // 伪造 requirement=required 被服务端降级为 advisory，除非后续接入 ApprovedExecutionPlan）
          const requirement: "required" | "advisory" =
            c.requirement === "required" ? "advisory" : (c.requirement ?? "advisory");
          const sanitized = sanitizeOutput(c.output ?? "");
          const run = {
            id: c.id ?? `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            deliveryAttemptId: active.id,
            kind: c.kind ?? "verification",
            requirement,
            label: c.label,
            command: c.command,
            cwd,
            status: c.status ?? "passed",
            ...(c.exitCode != null ? { exitCode: c.exitCode } : {}),
            ...(c.durationMs != null ? { durationMs: c.durationMs } : {}),
            startedAt: c.startedAt ?? new Date().toISOString(),
            ...(c.endedAt ? { endedAt: c.endedAt } : {}),
            output: sanitized.output,
            outputTruncated: sanitized.truncated,
            outputBytes: sanitized.outputBytes,
          } as const;
          recordCommandRun(run);
          saved.push(run);
        }
        return NextResponse.json({ ok: true, runs: saved });
      }

      case "finish": {
        const delivery = getDeliveryForSession(sessionId);
        const active = delivery ? getActiveAttempt(delivery.id) : null;
        if (!active) return NextResponse.json({ error: "无 active attempt" }, { status: 409 });
        const attempt = finishVerification(active.id);
        return NextResponse.json({ ok: true, attempt, runs: listCommandRuns(attempt.id) });
      }

      case "check": {
        // 检查当前 active attempt 的快照是否仍有效（用于 UI 判断「证据是否失效」）
        const delivery = getDeliveryForSession(sessionId);
        const active = delivery ? getActiveAttempt(delivery.id) : null;
        if (!active) return NextResponse.json({ ok: true, attempt: null, valid: null });
        const valid = active.verificationSnapshot ? await isSnapshotStillValid(active) : null;
        // 若已失效且仍处于可退回状态，落库标记 snapshot_stale
        let attempt = active;
        if (valid === false) attempt = markSnapshotStale(active.id);
        return NextResponse.json({ ok: true, attempt, valid });
      }

      case "accept": {
        const delivery = getDeliveryForSession(sessionId);
        const active = delivery ? getActiveAttempt(delivery.id) : null;
        if (!active) return NextResponse.json({ error: "无 active attempt" }, { status: 409 });
        const mergeResult = await mergeAttemptCas(active.id, body.allowUnverified === true);
        if (!mergeResult.ok) {
          return NextResponse.json({ ok: false, error: mergeResult.reason, detail: mergeResult.detail }, { status: 409 });
        }
        const attempt = markAccepted(active.id);
        return NextResponse.json({ ok: true, attempt, merge: mergeResult });
      }

      case "discard": {
        const delivery = getDeliveryForSession(sessionId);
        const active = delivery ? getActiveAttempt(delivery.id) : null;
        if (!active) return NextResponse.json({ error: "无 active attempt" }, { status: 409 });
        const attempt = markDiscarded(active.id);
        return NextResponse.json({ ok: true, attempt });
      }

      case "cancel": {
        const delivery = getDeliveryForSession(sessionId);
        const active = delivery ? getActiveAttempt(delivery.id) : null;
        if (!active) return NextResponse.json({ error: "无 active attempt" }, { status: 409 });
        const attempt = cancelAttempt(active.id);
        return NextResponse.json({ ok: true, attempt });
      }

      default:
        return NextResponse.json({ error: "未知 action" }, { status: 400 });
    }
  } catch (err) {
    rethrowWorkflowError(err);
    const message = err instanceof Error ? err.message : "操作失败";
    const status = /不存在|不属于|不可接受|非法|越出|必须是|缺少/.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export const POST = withWorkflowErrors(handlePOST);
