"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, cn } from "@zmzai/theme";

const post = (body: Record<string, unknown>) =>
  fetch("/api/deliveries/computer-use", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json().catch(() => ({})));

type Lease = {
  leaseId: string;
  rootTaskId: string;
  targetApp: string;
  status: "active" | "paused" | "revoked";
} | null;

/** C1-S3：桌面控制常驻指示条（spec §12.2「UI 常驻显示正在控制的应用与停止入口」）。
 *  仅在有 lease 时出现；停止走紧急停止端点（清队列——排队旧动作不执行）。 */
export default function ComputerUseIndicator() {
  const [lease, setLease] = useState<Lease>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = (await post({ action: "status" })) as { lease?: Lease };
      setLease(r.lease && r.lease.status !== "revoked" ? r.lease : null);
    } catch {
      /* 探测失败静默（未启用 CUA 时无碍） */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await post({ action: "stop" });
      setLease(null);
    } finally {
      setBusy(false);
    }
  }, []);

  if (!lease) return null;
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b px-3 py-1.5 text-[0.6875rem]",
        lease.status === "active" ? "border-warning/40 bg-warning/5 text-warning" : "border-line bg-surface-2/60 text-ink-3",
      )}
      role="status"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      <span>
        桌面控制中：<strong className="font-semibold">{lease.targetApp}</strong>
        {lease.status === "paused" && "（已由用户接管，恢复需显式继续）"}
      </span>
      <span className="flex-1" />
      <span className="font-mono text-[0.625rem] opacity-70">⌘⇧⌫ 紧急停止</span>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void stop()}>
        停止控制
      </Button>
    </div>
  );
}
