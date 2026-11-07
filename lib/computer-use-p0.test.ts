import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const rtFixture = vi.hoisted(() => ({ dir: "" }));
vi.mock("./runtime-constants", () => ({ get dataDir() { return rtFixture.dir; } }));
const ownerFixture = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock("./session-owner", () => ({ resolveSessionOwner: ownerFixture.owner }));
import { ComputerUseBroker, listActionsForLease, reconcileInterruptedActions, type CuaAdapter, type Observation } from "./computer-use.js";
import { getDb } from "./delivery.js";

/** PC18/PC19（spec §5.2，P0 2026-11-07）：真实用户输入接管、动作前窗口核对、
 *  紧急停止中止进行中动作、结果未知不盲重发、重启对账。adapter 为可计数假件，
 *  broker/动作日志/SQLite 为真实实现。 */

const base = mkdtempSync(path.join(tmpdir(), "cua-p0-"));
rtFixture.dir = path.join(base, "data");
ownerFixture.owner.mockImplementation((sessionId: string) => ({ sessionId, project: { id: "p", path: "/w/p" }, effectiveWorkspaceRoot: "/w/p" }));
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

type ActInput = Parameters<CuaAdapter["act"]>[0];

function adapter(over: Partial<CuaAdapter> & { idleMs?: () => number | null; windowTitle?: () => string } = {}) {
  const acts: ActInput[] = [];
  const a: CuaAdapter = {
    capability: () => ({ platform: "darwin", available: true, permissions: { accessibility: true, screenRecording: true } }),
    observe: async () => ({ ok: true, observation: { observationId: "", at: new Date().toISOString(), windowIdentity: { app: "Calculator", windowTitle: over.windowTitle?.() ?? "Calculator" } } satisfies Observation }),
    act: async (input) => { acts.push(input); return { ok: true, detail: "done" }; },
    ...(over.idleMs ? { userInputIdleMs: async () => over.idleMs!() } : {}),
    ...over,
  };
  return { adapter: a, acts };
}

async function leaseAndObserve(broker: ComputerUseBroker, a: CuaAdapter, rootTaskId: string) {
  const acquired = broker.acquireLease({ rootTaskId, hostInstanceId: "h", targetApp: "Calculator" });
  if (!acquired.ok) throw new Error("acquire 失败");
  const obs = await broker.observe(acquired.lease.leaseId, a);
  if (!obs.ok) throw new Error("observe 失败");
  return { leaseId: acquired.lease.leaseId, observationId: obs.observation.observationId };
}

describe("PC18：用户接管与窗口核对", () => {
  it("观察之后出现真实键鼠输入 → 租约暂停、动作不执行；恢复后须新观察", async () => {
    const broker = new ComputerUseBroker();
    let idle = 10_000; // 观察前很久无输入
    const { adapter: a, acts } = adapter({ idleMs: () => idle });
    const { leaseId, observationId } = await leaseAndObserve(broker, a, "task_takeover");
    await new Promise((r) => setTimeout(r, 300));
    idle = 20; // 观察 300ms 后，用户刚动了鼠标
    const r = await broker.act(leaseId, { observationId, kind: "click", target: "1" }, a);
    expect(r).toMatchObject({ ok: false, reason: "user-takeover" });
    expect(acts).toHaveLength(0);
    expect(broker.leaseStatus()?.status).toBe("paused");
    // 暂停中任何动作被拒；恢复（用户显式）后旧观察因 revision 前进而失效
    expect((await broker.act(leaseId, { observationId, kind: "click", target: "1" }, a)).ok).toBe(false);
    expect(broker.resume(leaseId)).toBe(true);
    idle = 10_000;
    expect(await broker.act(leaseId, { observationId, kind: "click", target: "1" }, a)).toMatchObject({ ok: false, reason: "stale-observation" });
    const fresh = await broker.observe(leaseId, a);
    if (!fresh.ok) throw new Error("observe 失败");
    expect((await broker.act(leaseId, { observationId: fresh.observation.observationId, kind: "click", target: "1" }, a)).ok).toBe(true);
    expect(acts).toHaveLength(1);
  });

  it("观察之前的输入（如用户点批准）不算接管", async () => {
    const broker = new ComputerUseBroker();
    const { adapter: a, acts } = adapter({ idleMs: () => 5_000 });
    const { leaseId, observationId } = await leaseAndObserve(broker, a, "task_before_obs");
    expect((await broker.act(leaseId, { observationId, kind: "click", target: "2" }, a)).ok).toBe(true);
    expect(acts).toHaveLength(1);
  });

  it("动作前把观察时的窗口身份交给 adapter；真实窗口不符（stale）→ 动作 failed 且该观察作废", async () => {
    const broker = new ComputerUseBroker();
    const { adapter: a, acts } = adapter({
      act: async (input) => { acts.push(input); return { ok: false, reason: "stale-window：前台窗口已与观察时不同", fatal: "stale" }; },
    });
    const { leaseId, observationId } = await leaseAndObserve(broker, a, "task_stale");
    const r = await broker.act(leaseId, { observationId, kind: "click", target: "3" }, a);
    expect(r.ok).toBe(false);
    expect(acts[0]!.expect).toEqual({ app: "Calculator", windowTitle: "Calculator" });
    expect((r as { action?: { status: string } }).action?.status).toBe("failed");
    // 同一观察不可再用；租约仍有效（窗口变化不是致命错误）
    expect(await broker.act(leaseId, { observationId, kind: "click", target: "3" }, a)).toMatchObject({ ok: false, reason: "stale-observation" });
    expect(broker.leaseStatus()?.status).toBe("active");
  });
});

describe("PC19：紧急停止、结果未知与重启", () => {
  it("紧急停止中止进行中的平台调用 → 动作 unknown；之后同目标不盲重发，租约已撤", async () => {
    const broker = new ComputerUseBroker();
    let sawAbort = false;
    const { adapter: a } = adapter({
      act: (input) => new Promise((resolve) => {
        input.signal?.addEventListener("abort", () => { sawAbort = true; resolve({ ok: false, reason: "动作已被紧急停止中止：结果无法确认（unknown）" }); });
      }),
    });
    const { leaseId, observationId } = await leaseAndObserve(broker, a, "task_stop");
    const pending = broker.act(leaseId, { observationId, kind: "type", target: "field", value: "secret", valueMasked: "***(6)" }, a);
    await new Promise((r) => setTimeout(r, 20));
    expect(broker.emergencyStop()).toMatchObject({ stopped: true, inflightAborted: true });
    const r = await pending;
    expect(sawAbort).toBe(true);
    expect((r as { action?: { status: string } }).action?.status).toBe("unknown");
    const logged = listActionsForLease(leaseId);
    expect(logged.at(-1)).toMatchObject({ status: "unknown", valueMasked: "***(6)" });
    expect(JSON.stringify(logged)).not.toContain("secret");
    // 撤租约后任何动作（含同目标重发）都不执行
    expect(await broker.act(leaseId, { observationId, kind: "type", target: "field", value: "secret" }, a)).toMatchObject({ ok: false, reason: "lease-not-active" });
  });

  it("结果未知的动作：同观察同目标重发被拒（须新观察）", async () => {
    const broker = new ComputerUseBroker();
    const { adapter: a, acts } = adapter({ act: async (input) => { acts.push(input); return { ok: false, reason: "超时：结果无法确认" }; } });
    const { leaseId, observationId } = await leaseAndObserve(broker, a, "task_unknown");
    expect(((await broker.act(leaseId, { observationId, kind: "click", target: "=" }, a)) as { action?: { status: string } }).action?.status).toBe("unknown");
    expect(await broker.act(leaseId, { observationId, kind: "click", target: "=" }, a)).toMatchObject({ ok: false, reason: "blind-retry-rejected" });
    expect(acts).toHaveLength(1);
  });

  it("重启对账：上个进程遗留的 executing 动作标 unknown（不当作未执行）", () => {
    const stuck = { id: "act_stuck_1", leaseId: "cua_old", observationId: "obs_old", kind: "click", target: "x", status: "executing", at: new Date().toISOString() };
    listActionsForLease("cua_old"); // 建表
    getDb().prepare("INSERT OR REPLACE INTO cua_actions (id, lease_id, json, at) VALUES (?, ?, ?, ?)").run(stuck.id, stuck.leaseId, JSON.stringify(stuck), stuck.at);
    expect(reconcileInterruptedActions().reconciled).toBeGreaterThanOrEqual(1);
    const after = listActionsForLease("cua_old")[0]!;
    expect(after.status).toBe("unknown");
    expect(after.detail).toContain("不会自动重发");
    // 幂等：再次对账不重复改写
    expect(reconcileInterruptedActions().reconciled).toBe(0);
  });
});
