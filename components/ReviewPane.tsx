"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, cn } from "@zmzai/theme";

import { client } from "@/lib/client";
import DiffView from "./DiffView";
import DeliveryReview from "./DeliveryReview";
import type { DiffFile, GitDiff, SessionSummary, TaskRecordView } from "@/lib/types";
import { presentTask } from "@/lib/task-presentation";

type Checkpoint = { hash: string; time: string; subject: string; checkpoint: boolean };

/** 变更文件行：本轮任务触碰的路径以 live 色点标记（F4 高亮的延续，另加文字分组标题）。 */
function FileRow({
  f,
  isTouched,
  onOpen,
}: {
  f: DiffFile;
  isTouched: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "mb-0.5 flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left transition-colors hover:bg-surface-2",
        isTouched && "bg-live-tint/60",
      )}
    >
      {isTouched && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-live" title="本轮 Agent 触碰" />}
      <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-ink-2" title={f.path}>
        {f.path}
      </span>
      {f.binary ? (
        <span className="shrink-0 text-[0.625rem] text-ink-3">binary</span>
      ) : (
        <span className="shrink-0 font-mono text-[0.625rem]">
          <span className="text-success">+{f.additions ?? 0}</span>{" "}
          <span className="text-danger">-{f.deletions ?? 0}</span>
        </span>
      )}
    </button>
  );
}

/**
 * 审查 Tab：工作区未提交变更（git diff HEAD）。
 * 文件列表（+/- 统计）→ 点击进入逐文件 diff；非 git 仓库降级提示。
 * 顶部检查点条（P1-9）：列出快照 commit，支持一键回滚（二次确认）。
 */
export default function ReviewPane({
  editedPaths = [],
  sessionId,
  /** 本轮小结（session.summary，N5）：渲染为该轮的变更摘要（§V3-1）。 */
  summary = null,
  /** 当前持久任务（规格 3 §15.2）：审查页要能回答「这些改动属于哪个目标、
   *  那个目标交付了没有」——只看 diff 是看不出来的。 */
  task = null,
  /** 跳到「文件」Tab 的路线（§4.5：审查必须给出到 Files 的路线，但不内嵌完整文件树）。 */
  onOpenFiles,
}: {
  editedPaths?: string[];
  sessionId?: string | null;
  summary?: SessionSummary | null;
  task?: TaskRecordView | null;
  onOpenFiles?: () => void;
}) {
  const [data, setData] = useState<GitDiff | null>(null);
  const [selected, setSelected] = useState<DiffFile | null>(null);
  const [fileDiff, setFileDiff] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [cpsOpen, setCpsOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  /** 交付审查区块展开态（P0：默认收起，避免与现有 diff 审查抢焦点）。 */
  const [deliveryOpen, setDeliveryOpen] = useState(false);

  const refreshCps = useCallback(async () => {
    try {
      const r = await client.checkpoints(sessionId);
      setCheckpoints(r.points.filter((p) => p.checkpoint));
    } catch {
      setCheckpoints([]);
    }
  }, [sessionId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setSelected(null);
    try {
      setData(await client.gitDiff(undefined, sessionId));
    } catch {
      setData({ available: false, files: [], diff: "" });
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    void refreshCps();
  }, [refresh, refreshCps]);

  const openFile = useCallback(async (f: DiffFile) => {
    setSelected(f);
    setFileDiff("");
    try {
      const d = await client.gitDiff(f.path, sessionId);
      setFileDiff(d.diff || "（该文件无未暂存 diff，可能是新文件或已暂存）");
    } catch (err) {
      setFileDiff(`读取失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }, [sessionId]);

  if (loading && !data) {
    return <div className="p-4 text-xs text-ink-3">读取变更中…</div>;
  }
  if (data && !data.available) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-sm font-semibold text-ink-2">当前项目不是 git 仓库</div>
        <div className="max-w-56 text-xs leading-5 text-ink-3">在工作区初始化 git 后，这里会显示 Agent 产生的未提交变更；检查点/回滚（P1-9）也依赖 git 快照。</div>
        <code className="rounded-sm bg-surface-2 px-2 py-1 font-mono text-[0.6875rem] text-ink-2">git init</code>
        <Button variant="secondary" size="sm" onClick={() => void refresh()}>
          重新检测
        </Button>
      </div>
    );
  }

  const files = data?.files ?? [];
  // §7.4：头部给出变更文件数与加减总量（能算就算，binary 文件没有行统计）。
  const totals = files.reduce(
    (acc, f) => ({
      add: acc.add + (f.binary ? 0 : (f.additions ?? 0)),
      del: acc.del + (f.binary ? 0 : (f.deletions ?? 0)),
    }),
    { add: 0, del: 0 },
  );
  // §7.4：本轮任务触碰的路径优先，其余归为「其他工作区变更」，并明确标注这个区别。
  const touched = files.filter((f) => editedPaths.includes(f.path));
  const others = files.filter((f) => !editedPaths.includes(f.path));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="wb-bar-sm">
        {selected ? (
          <>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-[0.6875rem] text-ink-3 transition-colors hover:text-ink"
            >
              ← 返回
            </button>
            <span className="truncate font-mono text-[0.6875rem] text-ink-2" title={selected.path}>
              {selected.path}
            </span>
          </>
        ) : (
          <>
            <span className="text-[0.6875rem] text-ink-3">
              {files.length > 0 ? `${files.length} 个文件变更` : "没有未提交变更"}
            </span>
            {files.length > 0 && (
              <span className="shrink-0 font-mono text-[0.625rem]">
                <span className="text-success">+{totals.add}</span>{" "}
                <span className="text-danger">-{totals.del}</span>
              </span>
            )}
            {data?.truncated && <span className="text-[0.625rem] text-warning">diff 已截断</span>}
          </>
        )}
        <span className="flex-1" />
        {/* 检查点（P1-9）：任务前快照列表 + 回滚 */}
        <button
          type="button"
          onClick={() => setCpsOpen((v) => !v)}
          className={cn(
            "inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[0.6875rem] font-medium transition-colors",
            cpsOpen ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink",
          )}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 5.5V8l1.8 1.8" strokeLinecap="round" />
          </svg>
          检查点{checkpoints.length > 0 ? ` · ${checkpoints.length}` : ""}
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-[0.6875rem] text-ink-3 transition-colors hover:text-ink"
        >
          刷新
        </button>
        {/* 交付审查（P0）：本地可信交付入口，默认收起 */}
        <button
          type="button"
          onClick={() => setDeliveryOpen((v) => !v)}
          className={cn(
            "inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[0.6875rem] font-medium transition-colors",
            deliveryOpen ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink",
          )}
        >
          交付
        </button>
      </div>

      {/* 交付审查区块（P0 最小证据展示） */}
      {deliveryOpen && (
        <div className="shrink-0 border-b border-line">
          <DeliveryReview sessionId={sessionId ?? null} />
        </div>
      )}

      {/* 检查点下拉列表 */}
      {cpsOpen && (
        <div className="shrink-0 bg-surface-2/50 p-2">
          {checkpoints.length === 0 && (
            <div className="px-2 py-1.5 text-[0.6875rem] leading-5 text-ink-3">
              还没有检查点。发送任务时会自动打快照（git 仓库且有变更时）。
            </div>
          )}
          {checkpoints.map((cp) => (
            <div key={cp.hash} className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-surface-2">
              <span className="shrink-0 font-mono text-[0.625rem] text-accent-strong">{cp.hash.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-ink-2" title={cp.subject}>
                {cp.subject.replace("harness-checkpoint: ", "")}
              </span>
              <span className="shrink-0 text-[0.625rem] text-ink-3">
                {new Date(cp.time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </span>
              <button
                type="button"
                disabled={restoring}
                onClick={() => {
                  if (!window.confirm(`硬回滚到 ${cp.hash.slice(0, 7)}？之后的所有提交与未跟踪文件将被丢弃。`)) return;
                  setRestoring(true);
                  void client
                    .checkpointRestore(cp.hash, sessionId)
                    .then(() => {
                      setCpsOpen(false);
                      return refresh();
                    })
                    .catch((e: Error) => window.alert(`回滚失败：${e.message}`))
                    .finally(() => setRestoring(false));
                }}
                className="shrink-0 rounded-pill border border-danger/40 px-1.5 py-0.5 text-[0.625rem] text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
              >
                回滚
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 任务交付状态（规格 3 §15.2）：审查页最容易犯的错是把「有一批改动」
          当成「目标达成」。这一行把目标本身和它的交付状态摆出来，让审查的人
          知道自己在审的是「一个已完成目标的结果」还是「半途的中间态」。 */}
      {task && (
        <div className="shrink-0 bg-surface-2/40 px-3 py-2" data-review-task-status={task.status}>
          <div className="flex items-center gap-2">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", task.status === "delivered" ? "bg-success" : task.status === "failed" ? "bg-danger" : task.status === "blocked" || task.status.startsWith("waiting_") ? "bg-warning" : "bg-live")} />
            <span className="shrink-0 text-[0.625rem] font-semibold uppercase tracking-wider text-ink-2">{presentTask(task).label}</span>
            <span className="min-w-0 truncate text-[0.6875rem] leading-4 text-ink-2" title={task.goal}>
              {task.goal}
            </span>
          </div>
        </div>
      )}

      {/* §V3-1：本轮变更摘要（有终态小结时）。失败/中断也保留，作为可追溯的次级信息（§7.5）。
          规格 3 §15.2 要求这里区分「本轮结束」与「任务交付」：`summary` 说的是前者，
          所以文案只说「本轮」；任务是否真的交付由上方 task 行说明。旧文案把
          kind === "completed" 写成「已完成」，把一个运行的结束读成了整个任务的完成。 */}
      {!selected && summary && (
        <div className="shrink-0 bg-surface-2/40 px-3 py-2">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "shrink-0 text-[0.625rem] font-semibold uppercase tracking-wider",
                summary.kind === "error" ? "text-danger" : summary.kind === "aborted" ? "text-warning" : "text-ink-3",
              )}
              data-attempt-summary-label
            >
              {summary.kind === "error" ? "本轮出错" : summary.kind === "aborted" ? "本轮中断" : "本轮已结束"}
            </span>
            {summary.meta && (
              <span className="shrink-0 font-mono text-[0.625rem] text-ink-3">
                改 {summary.meta.filesEdited} 文件 · {summary.meta.toolCalls} 次调用
                {summary.meta.durationMs > 0 && ` · ${(summary.meta.durationMs / 1000).toFixed(1)}s`}
              </span>
            )}
          </div>
          {summary.text && (
            <p className="mt-1 line-clamp-2 text-[0.6875rem] leading-4 text-ink-2" title={summary.text}>
              {summary.text}
            </p>
          )}
        </div>
      )}

      {selected ? (
        <DiffView diff={fileDiff} path={selected?.path} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {/* §4.5 空态：必须说明「基线是什么」+「当前变更状态」，而不是一句泛泛的占位。 */}
          {files.length === 0 && (
            <div className="flex flex-col items-start gap-2 px-3 py-6">
              <span className="text-[0.8125rem] font-medium text-ink-2">当前没有未提交变更</span>
              <span className="text-xs leading-5 text-ink-3">
                这里的基线是最近一次提交（<code className="font-mono">git diff HEAD</code>）：工作区里相对它的改动会出现在此处供审查。Agent 修改文件后会自动切到这里。
              </span>
              {onOpenFiles && (
                <button
                  type="button"
                  onClick={onOpenFiles}
                  className="mt-1 rounded-[3px] bg-surface-2 px-2 py-1 text-[0.6875rem] font-medium text-ink-2 transition-colors hover:text-ink"
                >
                  查看当前任务文件
                </button>
              )}
            </div>
          )}
          {touched.length > 0 && (
            <div className="px-2.5 pb-1 pt-1.5 text-[0.625rem] font-semibold uppercase tracking-wider text-ink-3">
              本轮任务
            </div>
          )}
          {touched.map((f) => (
            <FileRow key={f.path} f={f} isTouched onOpen={() => void openFile(f)} />
          ))}
          {others.length > 0 && (
            <div className="px-2.5 pb-1 pt-2 text-[0.625rem] font-semibold uppercase tracking-wider text-ink-3">
              其他工作区变更
            </div>
          )}
          {others.map((f) => (
            <FileRow key={f.path} f={f} isTouched={false} onOpen={() => void openFile(f)} />
          ))}
        </div>
      )}
    </div>
  );
}
