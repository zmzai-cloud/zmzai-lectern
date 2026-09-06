"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, cn } from "@zmzai/theme";

import { client } from "@/lib/client";
import type { CommandRunView, DeliveryAttempt, DeliveryStatus } from "@/lib/types";

/** 交付状态 → 展示标签 + 语义色。 */
const STATUS_META: Record<DeliveryStatus, { label: string; cls: string }> = {
  running: { label: "运行中", cls: "text-live" },
  verifying: { label: "验证中", cls: "text-live" },
  ready_for_review: { label: "待审查", cls: "text-success" },
  verification_failed: { label: "验证失败", cls: "text-danger" },
  unverified: { label: "未验证", cls: "text-warning" },
  cancelled: { label: "已取消", cls: "text-ink-3" },
  accepted: { label: "已接受", cls: "text-success" },
  discarded: { label: "已丢弃", cls: "text-ink-3" },
};

/**
 * 交付审查（P0 最小证据展示）：
 * 展示当前 attempt 的变更文件、验证状态、命令记录与不可合并原因，
 * 并提供「开始验证 / 完成验证 / 接受并合并 / 丢弃」的最小动作集。
 *
 * 注意：本组件不自己扫描 git/文件系统，只消费 /api/deliveries 返回的
 * 服务端推导结果；owner 由 sessionId 在服务端确定。
 */
export default function DeliveryReview({ sessionId }: { sessionId: string | null }) {
  const [attempt, setAttempt] = useState<DeliveryAttempt | null>(null);
  const [runs, setRuns] = useState<CommandRunView[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshotValid, setSnapshotValid] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const overview = await client.deliveryOverview(sessionId);
      setAttempt(overview.attempt);
      setRuns(overview.runs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const checkSnapshot = useCallback(async () => {
    if (!sessionId) return;
    try {
      const r = await client.deliveryAction(sessionId, "check");
      setAttempt(r.attempt ?? attempt);
      setSnapshotValid(r.valid as boolean | null);
    } catch {
      /* 检查失败静默 */
    }
  }, [sessionId, attempt]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (attempt?.verificationSnapshot) void checkSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt?.id]);

  const act = useCallback(
    async (action: string, payload?: Record<string, unknown>) => {
      if (!sessionId) return;
      setBusy(true);
      setError(null);
      try {
        await client.deliveryAction(sessionId, action, payload);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "操作失败");
      } finally {
        setBusy(false);
      }
    },
    [sessionId, refresh],
  );

  if (!sessionId) {
    return <div className="p-4 text-xs text-ink-3">无活动会话。</div>;
  }

  if (loading && !attempt) {
    return <div className="p-4 text-xs text-ink-3">读取交付状态…</div>;
  }

  if (!attempt) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <div className="text-xs text-ink-2">本会话还没有交付记录</div>
        <Button size="sm" disabled={busy} onClick={() => void act("begin")}>
          开始一次交付
        </Button>
      </div>
    );
  }

  const meta = STATUS_META[attempt.status];
  const canAccept =
    attempt.status === "ready_for_review" ||
    (attempt.status === "unverified" && attempt.unverifiedReason === "no_required_checks");

  // 不可合并原因说明
  const mergeBlockReason = ((): string | null => {
    if (attempt.status === "running" || attempt.status === "verifying") return "验证尚未完成";
    if (attempt.status === "verification_failed") return "存在失败的必要验证";
    if (attempt.status === "unverified" && attempt.unverifiedReason === "snapshot_stale") return "验证快照已失效，需重新验证";
    if (attempt.status === "cancelled") return "交付已取消";
    if (attempt.status === "accepted" || attempt.status === "discarded") return null;
    if (snapshotValid === false) return "工作区已变化，证据不能用于合并";
    return null;
  })();

  const requiredRuns = runs.filter((r) => r.requirement === "required");
  const failedRequired = requiredRuns.filter((r) => r.status === "failed");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="wb-bar-sm">
        <span className={cn("text-[0.6875rem] font-semibold", meta.cls)}>{meta.label}</span>
        {attempt.sequence > 0 && (
          <span className="font-mono text-[0.625rem] text-ink-3">attempt #{attempt.sequence}</span>
        )}
        <span className="flex-1" />
        <button type="button" onClick={() => void refresh()} className="text-[0.6875rem] text-ink-3 transition-colors hover:text-ink">
          刷新
        </button>
      </div>

      {error && <div className="border-b border-line px-3 py-2 text-[0.6875rem] text-danger">{error}</div>}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {/* 变更文件 */}
        <section>
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-ink-3">变更文件</div>
          {attempt.changedPaths.length === 0 ? (
            <div className="mt-1 text-[0.6875rem] text-ink-3">暂无记录（进入验证时记录）</div>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {attempt.changedPaths.map((p) => (
                <li key={p} className="truncate font-mono text-[0.6875rem] text-ink-2" title={p}>
                  {p}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 验证状态 */}
        <section>
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-ink-3">验证状态</div>
          <div className="mt-1 space-y-1 text-[0.6875rem] text-ink-2">
            <div>
              required 检查：<span className="font-mono">{requiredRuns.length}</span> 条
              {failedRequired.length > 0 && <span className="text-danger">（{failedRequired.length} 失败）</span>}
            </div>
            {attempt.unverifiedReason && (
              <div className="text-warning">
                未验证原因：{attempt.unverifiedReason === "no_required_checks" ? "没有 required 检查" : "验证快照已失效"}
              </div>
            )}
            {snapshotValid === false && (
              <div className="text-danger">工作区已变化，证据不能用于合并</div>
            )}
          </div>
        </section>

        {/* 命令记录 */}
        <section>
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-ink-3">命令记录</div>
          {runs.length === 0 ? (
            <div className="mt-1 text-[0.6875rem] text-ink-3">暂无命令</div>
          ) : (
            <ul className="mt-1 space-y-1">
              {runs.map((r) => (
                <li key={r.id} className="rounded-sm bg-surface-2/60 px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        r.status === "passed" ? "bg-success" : r.status === "failed" ? "bg-danger" : r.status === "running" ? "bg-live" : "bg-ink-3",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-ink-2" title={r.command}>
                      {r.label}
                    </span>
                    <span className="shrink-0 font-mono text-[0.625rem] text-ink-3">
                      {r.requirement === "required" ? "required" : "advisory"}
                    </span>
                    {r.exitCode != null && (
                      <span className={cn("shrink-0 font-mono text-[0.625rem]", r.exitCode === 0 ? "text-success" : "text-danger")}>
                        exit {r.exitCode}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[0.625rem] text-ink-3" title={r.command}>
                    {r.command}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 不可合并原因 */}
        {mergeBlockReason && (
          <section>
            <div className="rounded-sm border border-warning/40 bg-warning/5 px-2 py-1.5 text-[0.6875rem] text-warning">
              不可合并：{mergeBlockReason}
            </div>
          </section>
        )}
      </div>

      {/* 动作区 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
        {attempt.status === "running" && (
          <Button size="sm" disabled={busy} onClick={() => void act("verify", { changedPaths: attempt.changedPaths })}>
            进入验证
          </Button>
        )}
        {attempt.status === "verifying" && (
          <Button size="sm" disabled={busy} onClick={() => void act("finish")}>
            完成验证
          </Button>
        )}
        {canAccept && mergeBlockReason === null && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              if (attempt.status === "unverified" && !window.confirm("该交付没有 required 检查（未验证）。确认接受未验证快照并合并？")) return;
              void act("accept", { allowUnverified: attempt.status === "unverified" });
            }}
          >
            {attempt.status === "unverified" ? "接受未验证快照并合并" : "接受并合并"}
          </Button>
        )}
        {attempt.status !== "accepted" && attempt.status !== "discarded" && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act("discard")}>
            丢弃
          </Button>
        )}
      </div>
    </div>
  );
}
