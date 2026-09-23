import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const rtFixture = vi.hoisted(() => ({ dir: "" }));
vi.mock("./runtime-constants", () => ({ get dataDir() { return rtFixture.dir; } }));
const ownerFixture = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock("./session-owner", () => ({ resolveSessionOwner: ownerFixture.owner }));
import { ComputerUseBroker, listActionsForLease, type CuaAdapter, type Observation } from "./computer-use.js";

// 文件级共享 dataDir（deliveries.db 句柄是模块级缓存——delivery-owner.test 同款）
const base = mkdtempSync(path.join(tmpdir(), "c1-s1-"));
rtFixture.dir = path.join(base, "data");
ownerFixture.owner.mockImplementation((sessionId: string) => ({
  sessionId, project: { id: "p", path: "/w/p" }, effectiveWorkspaceRoot: "/w/p",
}));
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

function mockAdapter(over: Partial<CuaAdapter> = {}): CuaAdapter & { acts: unknown[] } {
  const state = { acts: [] as unknown[] };
  return {
    acts: state.acts,
    capability: () => ({ platform: "darwin", available: true, permissions: { accessibility: true, screenRecording: true } }),
    observe: async () => ({
      ok: true,
      observation: {
        observationId: "obs_x", at: new Date().toISOString(),
        windowIdentity: { app: "Calculator", windowTitle: "Calculator" },
      } satisfies Observation,
    }),
    act: async (input) => { state.acts.push(input); return { ok: true }; },
    ...over,
  } as CuaAdapter & { acts: unknown[] };
}

async function activeLease(broker: ComputerUseBroker, adapter: CuaAdapter, rootTaskId = "task_a") {
  const acquired = broker.acquireLease({ rootTaskId, hostInstanceId: "host_1", targetApp: "Calculator" });
  expect(acquired.ok).toBe(true);
  if (!acquired.ok) throw new Error("lease 获取失败");
  const obs = await broker.observe(acquired.lease.leaseId, adapter);
  expect(obs.ok).toBe(true);
  if (!obs.ok) throw new Error("observe 失败");
  return { lease: acquired.lease, observationId: obs.observation.observationId };
}

describe("ComputerUseBroker 租约与排队（C1-S1 / C03）", () => {
  it("单 lease：同 rootTask 幂等；不同 rootTask 排队；释放后队首可接棒", () => {
    const broker = new ComputerUseBroker();
    const a = broker.acquireLease({ rootTaskId: "task_a", hostInstanceId: "h", targetApp: "Calculator" });
    expect(a.ok).toBe(true);
    const again = broker.acquireLease({ rootTaskId: "task_a", hostInstanceId: "h", targetApp: "Calculator" });
    expect(again.ok && again.lease.leaseId).toBe(a.ok ? a.lease.leaseId : "");

    const b = broker.acquireLease({ rootTaskId: "task_b", hostInstanceId: "h", targetApp: "Finder" });
    expect(b.ok).toBe(false);
    if (!b.ok && b.reason === "queued") {
      expect(b.position).toBe(1);
      expect(b.heldBy).toBe("task_a");
    }

    if (a.ok) {
      const released = broker.release(a.lease.leaseId);
      expect(released.released).toBe(true);
      expect(released.nextQueued).toBe("task_b"); // 队首出队（接棒重取）
      const c = broker.acquireLease({ rootTaskId: "task_b", hostInstanceId: "h", targetApp: "Finder" });
      expect(c.ok).toBe(true);
    }
  });

  it("紧急停止：lease revoked + 排队清空——排队旧任务不再持有位置（C03）", () => {
    const broker = new ComputerUseBroker();
    broker.acquireLease({ rootTaskId: "t1", hostInstanceId: "h", targetApp: "X" });
    broker.acquireLease({ rootTaskId: "t2", hostInstanceId: "h", targetApp: "X" });
    broker.acquireLease({ rootTaskId: "t3", hostInstanceId: "h", targetApp: "X" });
    const stopped = broker.emergencyStop();
    expect(stopped).toEqual({ stopped: true, queuedDropped: 2 });
    expect(broker.leaseStatus()?.status).toBe("revoked");
    // 停止后新任务立即可取（队列已清）
    const fresh = broker.acquireLease({ rootTaskId: "t4", hostInstanceId: "h", targetApp: "X" });
    expect(fresh.ok).toBe(true);
  });

  it("用户接管：paused 后动作/观察全拒；resume 前进 revision（旧观察失效）", async () => {
    const broker = new ComputerUseBroker();
    const adapter = mockAdapter();
    const { lease, observationId } = await activeLease(broker, adapter);

    expect(broker.takeover()).toBe(true);
    expect(broker.leaseStatus()?.status).toBe("paused");
    // paused：观察与动作都拒
    const obs = await broker.observe(lease.leaseId, adapter);
    expect(obs.ok).toBe(false);
    const act = await broker.act(lease.leaseId, { observationId, kind: "click", target: "按钮 1" }, adapter);
    expect(act.ok).toBe(false);

    expect(broker.resume(lease.leaseId)).toBe(true);
    expect(broker.observationValid(observationId)).toBe(false); // revision 前进 → 旧观察失效，需重新观察
  });
});

describe("观察 TTL 与陈旧拒绝（C1-S1 / C02）", () => {
  it("过期观察拒绝（TTL）；窗口身份变化拒绝；有效观察可动作", async () => {
    const broker = new ComputerUseBroker(60); // 测试收紧 TTL（spec 默认 5s）
    const adapter = mockAdapter();
    const { lease, observationId } = await activeLease(broker, adapter);
    expect(broker.observationValid(observationId)).toBe(true);

    const ok = await broker.act(lease.leaseId, { observationId, kind: "click", target: "1" }, adapter);
    expect(ok.ok).toBe(true);

    // TTL 过期（60ms）→ 陈旧拒绝
    const obs2 = await broker.observe(lease.leaseId, adapter);
    expect(obs2.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    if (obs2.ok) {
      expect(broker.observationValid(obs2.observation.observationId)).toBe(false);
      const stale = await broker.act(lease.leaseId, { observationId: obs2.observation.observationId, kind: "click", target: "1" }, adapter);
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.reason).toBe("stale-observation");
    }
  });

  it("目标 app 切换的观察（身份不符）→ observationValid false", async () => {
    const broker = new ComputerUseBroker();
    const switched = mockAdapter({
      observe: async () => ({ ok: true, observation: { observationId: "o", at: new Date().toISOString(), windowIdentity: { app: "Finder", windowTitle: "F" } } }),
    });
    const acquired = broker.acquireLease({ rootTaskId: "t", hostInstanceId: "h", targetApp: "Calculator" });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    const obs = await broker.observe(acquired.lease.leaseId, switched);
    expect(obs.ok).toBe(true);
    if (obs.ok) expect(broker.observationValid(obs.observation.observationId)).toBe(false); // app 与租约目标不符
  });
});

describe("动作状态机与 unknown 防盲重试（C1-S1 / C04）", () => {
  it("动作日志持久化：executing→succeeded 落库；值脱敏占位", async () => {
    const broker = new ComputerUseBroker();
    const adapter = mockAdapter();
    const { lease, observationId } = await activeLease(broker, adapter);
    const r = await broker.act(lease.leaseId, { observationId, kind: "type", target: "搜索框", valueMasked: "***(4)" }, adapter);
    expect(r.ok).toBe(true);
    const log = listActionsForLease(lease.leaseId);
    expect(log.length).toBe(1);
    expect(log[0]?.status).toBe("succeeded");
    expect(log[0]?.valueMasked).toBe("***(4)");
    expect(JSON.stringify(log)).not.toContain("secret"); // 键入值永不落库
  });

  it("unknown 动作：同 observation+kind+target 重试被拒；新观察后新动作可执行（C04）", async () => {
    const broker = new ComputerUseBroker();
    let failOnce = true;
    const adapter = mockAdapter({
      act: async () => (failOnce ? { ok: false, reason: "结果未知：动作已发出但无法确认效果" } : { ok: true }),
    });
    const { lease, observationId } = await activeLease(broker, adapter);

    const first = await broker.act(lease.leaseId, { observationId, kind: "click", target: "发送" }, adapter);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.action?.status).toBe("unknown");

    // 盲目重试（同 observation/同目标）被拒
    const retry = await broker.act(lease.leaseId, { observationId, kind: "click", target: "发送" }, adapter);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.reason).toBe("blind-retry-rejected");

    // 新观察 → 新 observationId → 允许新动作（adapter 修好后成功）
    failOnce = false;
    const reObs = await broker.observe(lease.leaseId, adapter);
    expect(reObs.ok).toBe(true);
    if (!reObs.ok) return;
    const fresh = await broker.act(lease.leaseId, { observationId: reObs.observation.observationId, kind: "click", target: "发送" }, adapter);
    expect(fresh.ok).toBe(true);
  });

  it("fatal（app-exit/权限撤销/锁屏）→ lease revoked + 队列清空（C04/C01）", async () => {
    const broker = new ComputerUseBroker();
    const adapter = mockAdapter({
      act: async () => ({ ok: false, reason: "目标应用已退出", fatal: "app-exit" }),
    });
    broker.acquireLease({ rootTaskId: "t1", hostInstanceId: "h", targetApp: "Calculator" });
    broker.acquireLease({ rootTaskId: "t2", hostInstanceId: "h", targetApp: "Calculator" }); // 排队
    const { lease, observationId } = await activeLease(broker, mockAdapter(), "t1");
    // 先用真 adapter 观察，再用 fatal adapter 动作
    const r = await broker.act(lease.leaseId, { observationId, kind: "click", target: "x" }, adapter);
    expect(r.ok).toBe(false);
    expect(broker.leaseStatus()?.status).toBe("revoked");
    expect(broker.acquireLease({ rootTaskId: "t_new", hostInstanceId: "h", targetApp: "Calculator" }).ok).toBe(true); // 队列也清了
  });

  it("capability 白名单：lease 未授的动作类型拒绝", async () => {
    const broker = new ComputerUseBroker();
    const adapter = mockAdapter();
    const acquired = broker.acquireLease({ rootTaskId: "t", hostInstanceId: "h", targetApp: "Calculator", capabilities: ["observe", "click"] });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    const obs = await broker.observe(acquired.lease.leaseId, adapter);
    if (!obs.ok) return;
    const denied = await broker.act(acquired.lease.leaseId, { observationId: obs.observation.observationId, kind: "type", target: "t" }, adapter);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("capability-not-granted");
    // 非法能力名整体拒绝
    const bad = broker.acquireLease({ rootTaskId: "t2", hostInstanceId: "h", targetApp: "Calculator", capabilities: ["format_disk"] });
    expect(bad.ok).toBe(false);
  });
});
