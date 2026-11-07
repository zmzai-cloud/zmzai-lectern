import { withWorkflowErrors, rethrowWorkflowError } from './workflow-error.js';
import {
  beginAttempt,
  cancelAttempt,
  finishVerification,
  getActiveAttempt,
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
} from './delivery.js';
import { sanitizeOutput } from './sanitize.js';

/** 交付验证服务（P0 2026-11-07 Host 迁移，route-ownership-matrix）：
 *  GET /api/deliveries?sessionId= 概览与 POST /api/deliveries/attempt 动作族。
 *  逻辑与原进程内 handler 同源；owner 由 sessionId 服务端推导，attemptId 必须
 *  与该 session 的 delivery join。挂载路径：进程内 /api/deliveries*（legacy）
 *  与 Host /v1/delivery-overview、/v1/delivery-attempt（armed）。 */

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

type ActionBody = {
  sessionId?: string;
  action?: string;
  attemptId?: string;
  changedPaths?: string[];
  commands?: {
    id?: string;
    kind?: 'agent' | 'verification' | 'service' | 'browser_qa';
    requirement?: 'required' | 'advisory';
    label?: string;
    command?: string;
    cwdRelativePath?: string;
    status?: 'running' | 'passed' | 'failed' | 'cancelled';
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
  if (!sid || !SAFE_ID.test(sid)) throw new Error('缺少或非法的 sessionId');
  return sid;
}

// 注：动作族一律作用于「该会话 delivery 的 active attempt」，不采信 body.attemptId——
// attempt 归属由服务端 join 保证（原路由的 assertAttemptOwned 从未被调用，迁移时移除）。

/** GET 概览：delivery + active attempt + 命令记录。 */
async function handleOverview(request: Request): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get('sessionId');
  if (!sessionId) return Response.json({ error: '缺少 sessionId' }, { status: 400 });

  const owner = resolveOwner(sessionId);
  if (!owner) return Response.json({ error: '会话不存在或无法推导归属' }, { status: 404 });

  const delivery = getDeliveryForSession(sessionId);
  const attempt = delivery ? getActiveAttempt(delivery.id) : null;
  const runs = attempt ? listCommandRuns(attempt.id) : [];

  return Response.json({ delivery, attempt, runs });
}

/** POST 动作族：begin|verify|finish|accept|discard|cancel|commands|check。 */
async function handleAttempt(request: Request): Promise<Response> {
  let body: ActionBody;
  try {
    body = (await request.json()) as ActionBody;
  } catch {
    return Response.json({ error: '无效请求体' }, { status: 400 });
  }

  try {
    const sessionId = requireSessionId(body);
    const owner = resolveOwner(sessionId);
    if (!owner) return Response.json({ error: '会话不存在' }, { status: 404 });

    switch (body.action) {
      case 'begin': {
        const attempt = beginAttempt(owner, new Date().toISOString());
        return Response.json({ ok: true, attempt });
      }

      case 'verify': {
        const delivery = getDeliveryForSession(sessionId);
        const active = delivery ? getActiveAttempt(delivery.id) : null;
        if (!active) return Response.json({ error: '无 active attempt' }, { status: 409 });
        const attempt = await transitionToVerifying(active.id);
        return Response.json({ ok: true, attempt });
      }

      case 'commands': {
        const delivery = getDeliveryForSession(sessionId);
        const active = delivery ? getActiveAttempt(delivery.id) : null;
        if (!active) return Response.json({ error: '无 active attempt' }, { status: 409 });
        if (!Array.isArray(body.commands)) return Response.json({ error: 'commands 必须是数组' }, { status: 400 });

        const saved = [];
        for (const c of body.commands) {
          if (!c.command || !c.label) continue;
          // 服务端解析 cwd：只允许 root 相对路径，拒绝绝对路径/../symlink escape
          const cwd = resolveCwdWithin(owner.effectiveWorkspaceRoot, c.cwdRelativePath);
          // required 命令只能来自已批准 plan（P0 无 plan 系统，故服务端强制 advisory——
          // 伪造 requirement=required 被服务端降级为 advisory，除非后续接入 ApprovedExecutionPlan）
          const requirement: 'required' | 'advisory' =
            c.requirement === 'required' ? 'advisory' : (c.requirement ?? 'advisory');
          const sanitized = sanitizeOutput(c.output ?? '');
          const run = {
            id: c.id ?? `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            deliveryAttemptId: active.id,
            kind: c.kind ?? 'verification',
            requirement,
            label: c.label,
            command: c.command,
            cwd,
            status: c.status ?? 'passed',
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
        return Response.json({ ok: true, runs: saved });
      }

      case 'finish': {
        const delivery = getDeliveryForSession(sessionId);
        const active = delivery ? getActiveAttempt(delivery.id) : null;
        if (!active) return Response.json({ error: '无 active attempt' }, { status: 409 });
        const attempt = finishVerification(active.id);
        return Response.json({ ok: true, attempt, runs: listCommandRuns(attempt.id) });
      }

      case 'check': {
        // 检查当前 active attempt 的快照是否仍有效（用于 UI 判断「证据是否失效」）
        const delivery = getDeliveryForSession(sessionId);
        const active = delivery ? getActiveAttempt(delivery.id) : null;
        if (!active) return Response.json({ ok: true, attempt: null, valid: null });
        const valid = active.verificationSnapshot ? await isSnapshotStillValid(active) : null;
        // 若已失效且仍处于可退回状态，落库标记 snapshot_stale
        let attempt = active;
        if (valid === false) attempt = markSnapshotStale(active.id);
        return Response.json({ ok: true, attempt, valid });
      }

      case 'accept': {
        const delivery = getDeliveryForSession(sessionId);
        const active = delivery ? getActiveAttempt(delivery.id) : null;
        if (!active) return Response.json({ error: '无 active attempt' }, { status: 409 });
        const mergeResult = await mergeAttemptCas(active.id, body.allowUnverified === true);
        if (!mergeResult.ok) {
          return Response.json({ ok: false, error: mergeResult.reason, detail: mergeResult.detail }, { status: 409 });
        }
        const attempt = markAccepted(active.id);
        return Response.json({ ok: true, attempt, merge: mergeResult });
      }

      case 'discard': {
        const delivery = getDeliveryForSession(sessionId);
        const active = delivery ? getActiveAttempt(delivery.id) : null;
        if (!active) return Response.json({ error: '无 active attempt' }, { status: 409 });
        const attempt = markDiscarded(active.id);
        return Response.json({ ok: true, attempt });
      }

      case 'cancel': {
        const delivery = getDeliveryForSession(sessionId);
        const active = delivery ? getActiveAttempt(delivery.id) : null;
        if (!active) return Response.json({ error: '无 active attempt' }, { status: 409 });
        const attempt = cancelAttempt(active.id);
        return Response.json({ ok: true, attempt });
      }

      default:
        return Response.json({ error: '未知 action' }, { status: 400 });
    }
  } catch (err) {
    rethrowWorkflowError(err);
    const message = err instanceof Error ? err.message : '操作失败';
    const status = /不存在|不属于|不可接受|非法|越出|必须是|缺少/.test(message) ? 400 : 500;
    return Response.json({ error: message }, { status });
  }
}

export const handleDeliveryOverview = withWorkflowErrors(handleOverview);
export const handleDeliveryAttempt = withWorkflowErrors(handleAttempt);
