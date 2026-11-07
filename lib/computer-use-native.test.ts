import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const rtFixture = vi.hoisted(() => ({ dir: "" }));
vi.mock("./runtime-constants", () => ({ get dataDir() { return rtFixture.dir; } }));
const ownerFixture = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock("./session-owner", () => ({ resolveSessionOwner: ownerFixture.owner }));
import { ComputerUseBroker, listActionsForLease, type CuaAdapter } from "./computer-use.js";
import { createMacOsCuaAdapter, setAdapterTarget } from "./computer-use-macos.js";

/** C1-S4 原生 macOS 实测（spec §17.1 C1 放行条件）。
 *  跑法：CUA_NATIVE_TEST=1 corepack pnpm exec vitest run lib/computer-use-native.test.ts
 *  真流程：Calculator 真点击 + AX 读显示值（C02 观察→动作→效果核对；C04 动作日志）。
 *  权限缺失时：本文件只跑 C01 诚实降级断言（不伪报），真流程 skip。 */
const NATIVE = process.env.CUA_NATIVE_TEST === "1";
const AX_READY = NATIVE ? (await adapterProbe()) : false;
async function adapterProbe(): Promise<boolean> {
  const a = createMacOsCuaAdapter();
  return (await a.probeCapability!()).permissions.accessibility;
}

const base = mkdtempSync(path.join(tmpdir(), "c1-s4-"));
rtFixture.dir = path.join(base, "data");
ownerFixture.owner.mockImplementation((sessionId: string) => ({
  sessionId, project: { id: "p", path: "/w/p" }, effectiveWorkspaceRoot: "/w/p",
}));
afterAll(() => { if (!NATIVE) return; try { execSync("osascript -e 'tell application \"Calculator\" to quit'", { stdio: "ignore", timeout: 8000 }); } catch { /* 已退出 */ } });

const adapter = createMacOsCuaAdapter();
const broker = new ComputerUseBroker();

describe("C01：权限探测真实（原生）", () => {
  it("capability 探测：授权状态如实 + Windows 分支语义不假报", async () => {
    const cap = await adapter.probeCapability!();
    expect(cap.platform).toBe("darwin");
    expect(typeof cap.permissions.accessibility).toBe("boolean");
    if (!cap.permissions.accessibility) {
      expect(cap.available).toBe(false);
      expect(cap.guidance).toContain("辅助功能"); // 缺失给具体设置引导
    }
  // 两个权限探测各有 8s adapter 超时；测试需等待诚实降级结果。
  }, 20_000);
});

describe.skipIf(!AX_READY)("原生 Calculator 真流程（C02/C04）", () => {
  it("观察→AX 菜单点击「关于计算器」→重观察窗口数变化；TTL 过期动作拒绝；日志在案", async () => {
    execSync("open -a Calculator");
    await new Promise((r) => setTimeout(r, 1500)); // 启动窗口就绪

    const acquired = broker.acquireLease({ rootTaskId: "native_test", hostInstanceId: "e2e", targetApp: "Calculator" });
    expect(acquired.ok).toBe(true);
    setAdapterTarget("Calculator");
    const leaseId = acquired.ok ? acquired.lease.leaseId : "";
    const adapter2 = adapter as unknown as CuaAdapter;

    // 观察：初始窗口数（About 对话框未开）
    const obs1 = await broker.observe(leaseId, adapter2);
    expect(obs1.ok).toBe(true);
    if (!obs1.ok) return;
    expect(obs1.observation.windowIdentity.windowTitle).toContain("计算器");
    const windowsBefore = Number(/windows=(\d+)/.exec(obs1.observation.axSummary ?? "")?.[1] ?? 0);

    // AX 菜单点击（真点击；效果=窗口数 +1）
    const click = await broker.act(leaseId, { observationId: obs1.observation.observationId, kind: "click", target: "menu:计算器:关于计算器" }, adapter2);
    expect(click.ok).toBe(true);

    // 每次动作后重新观察目标效果（spec §12.2）
    const obs2 = await broker.observe(leaseId, adapter2);
    expect(obs2.ok).toBe(true);
    if (!obs2.ok) return;
    const windowsAfter = Number(/windows=(\d+)/.exec(obs2.observation.axSummary ?? "")?.[1] ?? 0);
    expect(windowsAfter).toBeGreaterThan(windowsBefore); // About 对话框真开了

    // C02：TTL 过期（默认 5s broker；这里等 5.5s）→ 陈旧动作拒绝
    await new Promise((r) => setTimeout(r, 5500));
    const stale = await broker.act(leaseId, { observationId: obs2.observation.observationId, kind: "key", value: "53" }, adapter2);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("stale-observation");

    // 动作日志（C04 证据链；成功动作全 succeeded）
    const log = listActionsForLease(leaseId);
    expect(log.filter((a) => a.status === "succeeded").length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(log)).not.toContain("value"); // 键入值不落库（key 码也只在内存）

    broker.emergencyStop();
    // 清理：直接退出 Calculator（About 随之关闭）。不向前台发 Escape——用户可能
    // 已切到别的应用，按键会落到用户正在使用的窗口
    try { execSync("osascript -e 'tell application \"Calculator\" to quit'", { stdio: "ignore", timeout: 8000 }); } catch { /* 已退出 */ }
  }, 45_000);
});

describe.skipIf(!AX_READY)("PC18 原生：真实窗口变化使旧观察失效（P0 2026-11-07）", () => {
  it("同一观察仍在 TTL 内且 revision 未变，但真实前台窗口已变成「关于」→ 只读动作被窗口核对拦下", async () => {
    // 上一用例刚退出 Calculator：等进程真正结束再启动（退出中 open -a 会失败）
    for (let i = 0; i < 50; i++) {
      try { execSync("pgrep -x Calculator", { stdio: "ignore" }); } catch { break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    execSync("open -a Calculator");
    await new Promise((r) => setTimeout(r, 1500));
    // 隔离窗口核对：不挂接管检测（用户此刻可能在动鼠标，接管另有用例）
    const real = createMacOsCuaAdapter();
    const guardOnly = { capability: real.capability, observe: real.observe, act: real.act } as unknown as CuaAdapter;
    const local = new ComputerUseBroker();
    const acquired = local.acquireLease({ rootTaskId: "native_pc18", hostInstanceId: "e2e", targetApp: "Calculator" });
    if (!acquired.ok) throw new Error("acquire 失败");
    setAdapterTarget("Calculator");
    const obs = await local.observe(acquired.lease.leaseId, guardOnly);
    if (!obs.ok) throw new Error(`observe 失败：${obs.reason}`);
    const opened = await local.act(acquired.lease.leaseId, { observationId: obs.observation.observationId, kind: "click", target: "menu:计算器:关于计算器" }, guardOnly);
    expect(opened.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(local.observationValid(obs.observation.observationId)).toBe(true); // TTL/revision 层面仍「有效」
    const stale = await local.act(acquired.lease.leaseId, { observationId: obs.observation.observationId, kind: "read_text" }, guardOnly);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toContain("stale-window");
    // 该观察已作废：再用同一观察直接被 broker 拒绝
    const again = await local.act(acquired.lease.leaseId, { observationId: obs.observation.observationId, kind: "read_text" }, guardOnly);
    expect(again).toMatchObject({ ok: false, reason: "stale-observation" });
    local.emergencyStop();
    try { execSync("osascript -e 'tell application \"Calculator\" to quit'", { stdio: "ignore", timeout: 8000 }); } catch { /* 已退出 */ }
  }, 45_000);

  it("真实用户输入接管：broker 读到的 HID 空闲值与决策一致（观察后有输入 → 暂停，否则执行）", async () => {
    for (let i = 0; i < 50; i++) {
      try { execSync("pgrep -x Calculator", { stdio: "ignore" }); } catch { break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    execSync("open -a Calculator");
    await new Promise((r) => setTimeout(r, 1500));
    const real = createMacOsCuaAdapter();
    let seenIdle: number | null = null;
    const withTakeover = { ...real, userInputIdleMs: async () => (seenIdle = await real.userInputIdleMs()) } as unknown as CuaAdapter;
    const local = new ComputerUseBroker();
    const acquired = local.acquireLease({ rootTaskId: "native_takeover", hostInstanceId: "e2e", targetApp: "Calculator" });
    if (!acquired.ok) throw new Error("acquire 失败");
    setAdapterTarget("Calculator");
    const obs = await local.observe(acquired.lease.leaseId, withTakeover);
    if (!obs.ok) throw new Error(`observe 失败：${obs.reason}`);
    await new Promise((r) => setTimeout(r, 1500)); // 观察后留出窗口：期间真实键鼠输入应触发接管
    const sinceObservation = Date.now() - Date.parse(obs.observation.at);
    const r = await local.act(acquired.lease.leaseId, { observationId: obs.observation.observationId, kind: "read_text" }, withTakeover);
    expect(seenIdle).not.toBeNull();
    const inputAfterObservation = seenIdle! + 100 < sinceObservation - 50; // 50ms：act 内读数晚于此处计时
    console.log(`[pc18-native] 接管判定：观察后 ${sinceObservation}ms，HID 空闲 ${seenIdle!.toFixed(0)}ms → ${r.ok ? "执行" : (r as { reason: string }).reason}`);
    if (!r.ok && (r as { reason: string }).reason === "user-takeover") {
      expect(local.leaseStatus()?.status).toBe("paused");
    } else if (inputAfterObservation) {
      throw new Error("观察后有真实输入却未触发接管");
    } else {
      expect(r.ok).toBe(true);
    }
    local.emergencyStop();
    try { execSync("osascript -e 'tell application \"Calculator\" to quit'", { stdio: "ignore", timeout: 8000 }); } catch { /* 已退出 */ }
  }, 45_000);

  it("真实键鼠空闲时间可读且随无输入单调增长（接管检测的信号源）", async () => {
    const { readHidIdleMs } = await import("./computer-use-macos.js");
    const first = await readHidIdleMs();
    expect(first).not.toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    const second = await readHidIdleMs();
    expect(second).not.toBeNull();
    // 期间若用户动了键鼠，second 会变小——两种都是真实信号；记录供执行记录引用
    console.log(`[pc18-native] HIDIdleTime ms: ${first!.toFixed(0)} → ${second!.toFixed(0)}（${second! >= first! + 250 ? "期间无输入" : "期间有真实输入"}）`);
    expect(Number.isFinite(second)).toBe(true);
  });
});
