import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
import { createFrameworkSession, createSqliteEventLog, createSqliteSessionStore, reclaimExpiredLeases } from "@zmzai/agent-framework";
import { expireDeadOwnerLeases } from "./lease-takeover.js";

/** PC11（P0 2026-11-07）：Host 强杀后重启——前任实例（已死 pid）的未过期租约被立即标为
 *  过期，交给框架官方回收扫描收尾（追加「运行因服务重启中断」事件、清租约），不等 10 分钟；
 *  存活进程持有的租约保持不动。真实 SQLite store/event log。 */
it("死进程租约立即进入官方回收；存活进程租约不动", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lease-takeover-"));
  try {
    const store = createSqliteSessionStore({ dataDir: dir });
    const log = createSqliteEventLog({ dataDir: dir });
    const mk = async () => (await createFrameworkSession({ store: store as never, userId: "local", workspaceId: "local", model: { providerId: "openai", modelId: "m" }, prompt: "s" })).id;
    const dead = await mk();
    const alive = await mk();
    const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid!; // 已退出的进程号
    const future = new Date(Date.now() + 10 * 60 * 1000);
    await store.stamp(dead, `node:${deadPid}`, future);
    await store.stamp(alive, `node:${process.pid}`, future);

    // 未接管前：官方扫描不认未过期租约（这正是重启后挂「执行中」的原因）
    await reclaimExpiredLeases({ store: store as never, log });
    expect(JSON.stringify(await store.getSession(dead))).toContain("leaseOwner");

    expect(await expireDeadOwnerLeases(dir, store)).toEqual([dead]);
    await reclaimExpiredLeases({ store: store as never, log });
    const after = await store.getSession(dead) as unknown as { leaseOwner?: string };
    expect(after.leaseOwner).toBeUndefined();
    const events = await log.read(dead, 0, 100);
    expect(events.some((e) => e.type === "session.error" && JSON.stringify(e).includes("服务重启中断"))).toBe(true);
    // 存活进程（本进程）的租约不动
    expect((await store.getSession(alive) as unknown as { leaseOwner?: string }).leaseOwner).toBe(`node:${process.pid}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
