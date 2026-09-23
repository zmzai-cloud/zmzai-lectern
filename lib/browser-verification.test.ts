import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const fixture = vi.hoisted(() => ({ dir: "" }));
vi.mock("./runtime-constants", () => ({ get dataDir() { return fixture.dir; } }));
const ownerFixture = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock("./session-owner", () => ({ resolveSessionOwner: ownerFixture.owner }));
import {
  saveVerificationPlan, getLatestPlan, startBrowserVerificationRun, getRun,
  listRunsForAttempt, cancelBrowserVerificationRun, runEvidenceStatus, aggregateStatus,
  type BrowserVerifierAdapter, type VerificationStep,
} from "./browser-verification.js";

// 文件级共享 dataDir（delivery/worktrees 的 SQLite 句柄是模块级缓存——
// 逐用例换目录会让句柄指向已删除文件，delivery-owner.test 同款约定）
const base = mkdtempSync(path.join(tmpdir(), "v1-s1-"));
fixture.dir = path.join(base, "data");
ownerFixture.owner.mockImplementation((sessionId: string) => ({
  sessionId, project: { id: "p", path: "/workspace/p" }, effectiveWorkspaceRoot: "/workspace/p",
}));
afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(base, { recursive: true, force: true });
});

/** scripted mock verifier：按步骤序号给结果；openContext 可注入失败。 */
function mockVerifier(opts: {
  results?: Array<"passed" | "failed" | "unavailable">;
  openFail?: string;
  throwOnStep?: number;
} = {}): BrowserVerifierAdapter & { closed: string[] } {
  const closed: string[] = [];
  return {
    closed,
    openContext: async () => opts.openFail ? { ok: false, reason: opts.openFail } : { ok: true, browserContextId: "ctx-1" },
    runStep: async ({ step, browserContextId }) => {
      const i = Number(step.value?.match(/#(\d+)/)?.[1] ?? 0);
      if (opts.throwOnStep === i) throw new Error("verifier 崩溃");
      const status = opts.results?.[i] ?? "passed";
      return { status, detail: status === "passed" ? undefined : `step#${i} ${status}`, consoleErrors: status === "failed" ? 2 : 0 };
    },
    captureScreenshot: async (id: string) => ({ artifactRef: `shot:${id}` }),
    closeContext: async (id: string) => { closed.push(id); },
  };
}

const steps = (n: number, requirement: "required" | "advisory" = "required"): VerificationStep[] =>
  Array.from({ length: n }, (_, i) => ({ kind: i === 0 ? "goto" : "assert_dom", target: i === 0 ? "/" : `#el-${i}`, value: `step#${i}`, requirement }));

describe("VerificationPlan 版本化与降级守卫（V1-S1）", () => {
  it("首版落库自增版本；新增 required 允许；既有 required 降级/移除被服务端拒绝", () => {
    const v1 = saveVerificationPlan("att_p1", { steps: steps(2), viewport: { width: 1280, height: 800 } });
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(v1.plan.version).toBe(1);

    // 新增 required 步骤：允许（v2）
    const v2 = saveVerificationPlan("att_p1", { steps: steps(3), viewport: { width: 1280, height: 800 } });
    expect(v2.ok).toBe(true);
    expect(v2.ok && v2.plan.version).toBe(2);
    expect(getLatestPlan("att_p1")?.version).toBe(2);

    // v3 移除既有 required 步骤（降级的等价形式）→ 服务端拒绝（spec §11.2.1）
    const downgraded = saveVerificationPlan("att_p1", {
      steps: steps(3).filter((s) => s.value !== "step#1"),
      viewport: { width: 1280, height: 800 },
    });
    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) throw new Error("应被拒绝");
    expect(downgraded.reason).toBe("downgrade-rejected");
    // 降为 advisory 的写法同样拒绝
    const asAdvisory = saveVerificationPlan("att_p1", {
      steps: [
        ...steps(3).filter((s) => s.value !== "step#1"),
        { kind: "assert_dom", target: "#el-1", value: "step#1", requirement: "advisory" } as VerificationStep,
      ],
      viewport: { width: 1280, height: 800 },
    });
    expect(asAdvisory.ok).toBe(false);
    // 拒绝后最新版本仍是 v2
    expect(getLatestPlan("att_p1")?.version).toBe(2);
  });

  it("空步骤拒绝", () => {
    const bad = saveVerificationPlan("att_p9", { steps: [], viewport: { width: 1, height: 1 } });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("应被拒绝");
    expect(bad.reason).toBe("invalid-steps");
  });
});

describe("Run 状态机与 unavailable 语义（V1-S1 / V02 前置）", () => {
  it("全部 required passed → run passed，分项步骤逐步落库", async () => {
    const plan = saveVerificationPlan("att_r1", { steps: steps(3), viewport: { width: 1280, height: 800 } });
    expect(plan.ok).toBe(true);
    const run = await startBrowserVerificationRun({ attemptId: "att_r1", snapshotFingerprint: "fp-1", verifier: mockVerifier() });
    expect(run.status).toBe("passed");
    expect(run.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed"]);
    expect(run.steps.map((s) => s.requirement)).toEqual(["required", "required", "required"]);
    expect(getRun(run.id)?.status).toBe("passed"); // 落库
    expect(runEvidenceStatus(run, "fp-1")).toBe("valid");
  });

  it("required failed（advisory 全过也不救）→ run failed；失败现场截图入证据（不算通过）", async () => {
    saveVerificationPlan("att_r2", {
      steps: [...steps(2), { kind: "assert_dom", target: "#soft", value: "step#2", requirement: "advisory" }],
      viewport: { width: 1280, height: 800 },
    });
    const run = await startBrowserVerificationRun({
      attemptId: "att_r2", snapshotFingerprint: "fp-2",
      verifier: mockVerifier({ results: ["passed", "failed", "passed"] }),
    });
    expect(run.status).toBe("failed"); // required 失败定终态，advisory 通过不掩盖
    expect(runEvidenceStatus(run, "fp-2")).toBe("not-passed");
    expect(run.evidenceRefs.length).toBeGreaterThan(0); // 失败截图
  });

  it("verifier 缺失（dev/web 无 Electron）→ run unavailable + 环境原因，绝不算通过", async () => {
    saveVerificationPlan("att_r3", { steps: steps(1), viewport: { width: 1280, height: 800 } });
    const run = await startBrowserVerificationRun({ attemptId: "att_r3", snapshotFingerprint: "fp-3" });
    expect(run.status).toBe("unavailable");
    expect(run.unavailableReason).toContain("verifier 未配置");
    expect(runEvidenceStatus(run, "fp-3")).toBe("not-passed");
  });

  it("openContext 失败 / required 步骤 unavailable → unavailable；advisory unavailable 不影响通过", async () => {
    saveVerificationPlan("att_r4", { steps: steps(1), viewport: { width: 1280, height: 800 } });
    const noCtx = await startBrowserVerificationRun({
      attemptId: "att_r4", snapshotFingerprint: "fp-4",
      verifier: mockVerifier({ openFail: "无可用显示器" }),
    });
    expect(noCtx.status).toBe("unavailable");
    expect(noCtx.unavailableReason).toContain("浏览器 context 不可用");

    // advisory unavailable 不拖垮 run；required unavailable 才 unavailable
    saveVerificationPlan("att_r5", {
      steps: [
        ...steps(1),
        { kind: "assert_visual", value: "step#1", requirement: "advisory" },
      ],
      viewport: { width: 375, height: 812 },
    });
    const advOnly = await startBrowserVerificationRun({
      attemptId: "att_r5", snapshotFingerprint: "fp-5",
      verifier: mockVerifier({ results: ["passed", "unavailable"] }),
    });
    expect(advOnly.status).toBe("passed"); // advisory 不影响终态，只记录
    expect(advOnly.steps[1]?.status).toBe("unavailable");

    saveVerificationPlan("att_r6", { steps: steps(2), viewport: { width: 1280, height: 800 } });
    const reqNa = await startBrowserVerificationRun({
      attemptId: "att_r6", snapshotFingerprint: "fp-6",
      verifier: mockVerifier({ results: ["passed", "unavailable"] }),
    });
    expect(reqNa.status).toBe("unavailable");
    expect(reqNa.unavailableReason).toContain("required");
    expect(runEvidenceStatus(reqNa, "fp-6")).toBe("not-passed");
  });

  it("单步崩溃按 unavailable 记录不炸 run；context 关闭收尾", async () => {
    saveVerificationPlan("att_r7", { steps: steps(2), viewport: { width: 1280, height: 800 } });
    const verifier = mockVerifier({ throwOnStep: 1 });
    const run = await startBrowserVerificationRun({ attemptId: "att_r7", snapshotFingerprint: "fp-7", verifier });
    expect(run.status).toBe("unavailable"); // 崩溃的 required 步骤 → unavailable 终态
    expect(run.steps[1]?.detail).toContain("verifier 崩溃");
    expect(verifier.closed).toEqual(["ctx-1"]); // closeContext 收尾
  });

  it("取消：非终态 run → cancelled（不伪造完成证据）；终态幂等返回", async () => {
    saveVerificationPlan("att_r8", { steps: steps(1), viewport: { width: 1280, height: 800 } });
    const run = await startBrowserVerificationRun({ attemptId: "att_r8", snapshotFingerprint: "fp-8", verifier: mockVerifier() });
    expect(run.status).toBe("passed"); // 终态
    expect(cancelBrowserVerificationRun(run.id)?.status).toBe("passed"); // 不改终态

    saveVerificationPlan("att_r9", { steps: steps(1), viewport: { width: 1280, height: 800 } });
    const na = await startBrowserVerificationRun({ attemptId: "att_r9", snapshotFingerprint: "fp-9" }); // queued 即 unavailable 终态
    expect(listRunsForAttempt("att_r9").length).toBe(1);
    expect(cancelBrowserVerificationRun(na.id)?.status).toBe("unavailable");
  });

  it("fingerprint 绑定：通过后源码变化 → stale（旧证据失效，不能 accepted）", async () => {
    saveVerificationPlan("att_r10", { steps: steps(1), viewport: { width: 1280, height: 800 } });
    const run = await startBrowserVerificationRun({
      attemptId: "att_r10", snapshotFingerprint: "fp-old",
      verifier: mockVerifier(),
    });
    expect(run.status).toBe("passed");
    expect(runEvidenceStatus(run, "fp-old")).toBe("valid");
    expect(runEvidenceStatus(run, "fp-new")).toBe("stale"); // 验证后源码变化
  });

  it("聚合判定纯函数：required 全 passed 才 passed", () => {
    expect(aggregateStatus([
      { index: 0, kind: "goto", requirement: "required", status: "passed", durationMs: 1, consoleErrors: 0 },
    ]).status).toBe("passed");
    expect(aggregateStatus([
      { index: 0, kind: "goto", requirement: "advisory", status: "failed", durationMs: 1, consoleErrors: 0 },
    ]).status).toBe("passed"); // advisory 失败不影响终态
  });
});
