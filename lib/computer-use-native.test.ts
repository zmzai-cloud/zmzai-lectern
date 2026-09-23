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
afterAll(() => { try { execSync("osascript -e 'tell application \"Calculator\" to quit'", { stdio: "ignore" }); } catch { /* 已退出 */ } });

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
  });
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
    // 清理：Escape 关 About + 退出 Calculator
    try { execSync("osascript -e 'tell application \"System Events\" to keystroke (ASCII character 27)'", { stdio: "ignore" }); } catch { /* 忽略 */ }
  }, 45_000);
});
