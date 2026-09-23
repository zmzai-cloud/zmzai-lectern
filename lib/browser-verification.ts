/** W1 后 V1-S1：浏览器验证与交付证据——Host 纯逻辑层（spec §11）。
 *
 *  与驱动的边界（V1 设计 §1.1）：状态机、Plan 固定、证据聚合与持久化
 *  全在本模块（纯 Node 可测）；真实浏览器驱动是注入的 BrowserVerifierAdapter
 *  （S3 落地 Electron 主进程实现；dev/web 模式无 adapter → 如实 unavailable，
 *  不算通过——spec §11.2.7「required unavailable 时保持 unverified 并说明环境原因」）。
 *
 *  语义硬线：
 *  - unavailable ≠ passed（环境原因如实记录，永远不能当通过证据）；
 *  - run 通过的唯一条件 = 全部 required 步骤 passed（advisory 不影响终态，只记录）；
 *  - 单截图/HTTP 200/无 console error 不单独代替功能断言（步骤分项即证据）；
 *  - Plan 版本化：失败后不得把既有 required 步骤降级为 advisory（服务端拒绝降级写）；
 *  - 证据有效性绑定 snapshotFingerprint：run 通过后源码变化 → stale（§11.2 末段）。
 *
 *  存储：deliveries.db 三张新表（复用 delivery.ts 的连接句柄）。 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./delivery.js";

export type VerificationStepKind = "goto" | "click" | "type" | "wait" | "assert_dom" | "assert_visual" | "assert_network";

export type VerificationStep = {
  kind: VerificationStepKind;
  /** CSS/ARIA 选择器或 URL（goto）。 */
  target?: string;
  /** 输入文本 / 断言描述。 */
  value?: string;
  requirement: "required" | "advisory";
};

export type VerificationPlan = {
  id: string;
  attemptId: string;
  version: number;
  steps: VerificationStep[];
  viewport: { width: number; height: number };
};

export type RunStepRecord = {
  index: number;
  kind: VerificationStepKind;
  requirement: "required" | "advisory";
  status: "passed" | "failed" | "unavailable";
  durationMs: number;
  consoleErrors: number;
  detail?: string;
};

export type BrowserRunStatus = "queued" | "starting" | "running" | "passed" | "failed" | "cancelled" | "unavailable";

export type BrowserVerificationRun = {
  id: string;
  attemptId: string;
  serviceId?: string;
  planId: string;
  planVersion: number;
  snapshotFingerprint: string;
  status: BrowserRunStatus;
  steps: RunStepRecord[];
  evidenceRefs: string[];
  /** unavailable/失败的环境与原因说明（不含凭据与敏感 body）。 */
  unavailableReason?: string;
  startedAt: string;
  endedAt?: string;
};

import type { ServiceInstance } from "./service-instance.js";
export type { ServiceInstance } from "./service-instance.js";

// ===== 浏览器驱动 adapter（S3 落地 Electron 实现；测试注入 mock）=====

export type VerifierStepResult = {
  status: "passed" | "failed" | "unavailable";
  detail?: string;
  consoleErrors?: number;
  screenshotArtifactRef?: string;
};

export type BrowserVerifierAdapter = {
  /** 开隔离 context（partition 隔离；失败=unavailable 语义，如无 Electron 环境）。 */
  openContext(input: { contextKey: string; viewport: { width: number; height: number } }):
    Promise<{ ok: true; browserContextId: string } | { ok: false; reason: string }>;
  /** 执行单步（Host 编排串行；context 内操作不并发）。 */
  runStep(input: { browserContextId: string; step: VerificationStep; serviceOrigin?: string }): Promise<VerifierStepResult>;
  captureScreenshot(browserContextId: string): Promise<{ artifactRef?: string; failed?: string }>;
  closeContext(browserContextId: string): Promise<void>;
};

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

function ensureTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS verification_plans (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS browser_verification_runs (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      service_id TEXT,
      plan_id TEXT NOT NULL,
      status TEXT NOT NULL,
      snapshot_fingerprint TEXT NOT NULL,
      json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bvr_attempt ON browser_verification_runs(attempt_id);
  `);
}

// ===== Plan：版本化 + 降级守卫 =====

/** 步骤匹配签名（降级守卫按签名匹配，不按 index）。 */
function stepSignature(step: VerificationStep): string {
  return `${step.kind}|${step.target ?? ""}|${step.value ?? ""}`;
}

export type SavePlanResult = { ok: true; plan: VerificationPlan } | { ok: false; reason: "downgrade-rejected" | "invalid-steps"; detail?: string };

/** 保存新版本 Plan。降级守卫（spec §11.2.1）：AI/重试可以增改步骤，
 *  但既有版本的 required 步骤在新版本中不得消失或降为 advisory——
 *  失败后自行把 required 降级是服务端拒绝的写操作。 */
export function saveVerificationPlan(attemptId: string, input: { steps: VerificationStep[]; viewport: { width: number; height: number } }): SavePlanResult {
  if (!Array.isArray(input.steps) || input.steps.length === 0) return { ok: false, reason: "invalid-steps" };
  const db = getDb();
  ensureTables(db);
  const prior = getLatestPlan(attemptId);
  if (prior) {
    const priorRequired = new Set(prior.steps.filter((s) => s.requirement === "required").map(stepSignature));
    const nextRequired = new Set(input.steps.filter((s) => s.requirement === "required").map(stepSignature));
    for (const sig of priorRequired) {
      if (!nextRequired.has(sig)) {
        return { ok: false, reason: "downgrade-rejected", detail: `required 步骤被降级或移除：${sig}` };
      }
    }
  }
  const plan: VerificationPlan = {
    id: newId("vplan"),
    attemptId,
    version: (prior?.version ?? 0) + 1,
    steps: input.steps,
    viewport: input.viewport,
  };
  db.prepare("INSERT INTO verification_plans (id, attempt_id, version, json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(plan.id, attemptId, plan.version, JSON.stringify(plan), new Date().toISOString());
  return { ok: true, plan };
}

export function getLatestPlan(attemptId: string): VerificationPlan | null {
  const db = getDb();
  ensureTables(db);
  const row = db.prepare("SELECT json FROM verification_plans WHERE attempt_id = ? ORDER BY version DESC LIMIT 1").get(attemptId) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as VerificationPlan) : null;
}

// ===== Run 状态机 =====

function writeRun(db: DatabaseSync, run: BrowserVerificationRun): void {
  db.prepare(
    `INSERT OR REPLACE INTO browser_verification_runs
      (id, attempt_id, service_id, plan_id, status, snapshot_fingerprint, json, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(run.id, run.attemptId, run.serviceId ?? null, run.planId, run.status, run.snapshotFingerprint, JSON.stringify(run), run.startedAt, run.endedAt ?? null);
}

export function getRun(runId: string): BrowserVerificationRun | null {
  const db = getDb();
  ensureTables(db);
  const row = db.prepare("SELECT json FROM browser_verification_runs WHERE id = ?").get(runId) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as BrowserVerificationRun) : null;
}

export function listRunsForAttempt(attemptId: string): BrowserVerificationRun[] {
  const db = getDb();
  ensureTables(db);
  const rows = db.prepare("SELECT json FROM browser_verification_runs WHERE attempt_id = ? ORDER BY started_at ASC").all(attemptId) as { json: string }[];
  return rows.map((r) => JSON.parse(r.json) as BrowserVerificationRun);
}

/** 聚合判定（spec §11.2.5）：run 通过的唯一条件 = 全部 required passed。
 *  任一 required failed → failed；无 required failed 但有 required unavailable
 *  → unavailable（环境原因，不算通过）；advisory 全程只记录不影响终态。 */
export function aggregateStatus(steps: RunStepRecord[]): { status: "passed" | "failed" | "unavailable"; unavailableReason?: string } {
  const required = steps.filter((s) => s.requirement === "required");
  if (required.some((s) => s.status === "failed")) return { status: "failed" };
  const unavailable = required.filter((s) => s.status === "unavailable");
  if (unavailable.length > 0) {
    return { status: "unavailable", unavailableReason: `required 步骤不可用（环境原因）：${unavailable.map((s) => s.kind).join("、")}` };
  }
  return { status: "passed" };
}

/** 执行一次浏览器验证 run：
 *  queued → starting（context 打不开 = unavailable 收尾）→ running（逐步串行）→ 聚合终态。
 *  verifier 缺失（dev/web 无 Electron）→ unavailable，如实说明环境原因。 */
export async function startBrowserVerificationRun(input: {
  attemptId: string;
  snapshotFingerprint: string;
  serviceId?: string;
  verifier?: BrowserVerifierAdapter;
  /** context 隔离键（默认按 attempt 隔离；登录态按账号+项目隔离由调用方扩展）。 */
  contextKey?: string;
}): Promise<BrowserVerificationRun> {
  const db = getDb();
  ensureTables(db);
  const plan = getLatestPlan(input.attemptId);
  if (!plan) throw new Error("无 VerificationPlan，先 saveVerificationPlan");
  const run: BrowserVerificationRun = {
    id: newId("bvr"),
    attemptId: input.attemptId,
    ...(input.serviceId ? { serviceId: input.serviceId } : {}),
    planId: plan.id,
    planVersion: plan.version,
    snapshotFingerprint: input.snapshotFingerprint,
    status: "queued",
    steps: [],
    evidenceRefs: [],
    startedAt: new Date().toISOString(),
  };
  writeRun(db, run);

  const finish = (patch: Partial<BrowserVerificationRun>): BrowserVerificationRun => {
    const done = { ...run, ...patch, endedAt: new Date().toISOString() };
    Object.assign(run, done);
    writeRun(db, run);
    return run;
  };

  // 无驱动：环境能力缺失，如实 unavailable（不伪报、不算通过）
  if (!input.verifier) {
    return finish({ status: "unavailable", unavailableReason: "verifier 未配置（dev/web 模式无 Electron 浏览器驱动）" });
  }

  const contextKey = input.contextKey ?? `bvr-${input.attemptId}`;
  const opened = await input.verifier.openContext({ contextKey, viewport: plan.viewport });
  if (!opened.ok) {
    return finish({ status: "unavailable", unavailableReason: `浏览器 context 不可用：${opened.reason}` });
  }
  writeRun(db, { ...run, status: "starting" });

  writeRun(db, { ...run, status: "running", steps: [] });
  const stepRecords: RunStepRecord[] = [];
  const evidenceRefs: string[] = [];
  for (let i = 0; i < plan.steps.length; i += 1) {
    const step = plan.steps[i]!;
    const t0 = Date.now();
    let result: VerifierStepResult;
    try {
      result = await input.verifier.runStep({ browserContextId: opened.browserContextId, step });
    } catch (error) {
      result = { status: "unavailable", detail: error instanceof Error ? error.message : String(error) };
    }
    const record: RunStepRecord = {
      index: i,
      kind: step.kind,
      requirement: step.requirement,
      status: result.status,
      durationMs: Date.now() - t0,
      consoleErrors: result.consoleErrors ?? 0,
      ...(result.detail ? { detail: result.detail.slice(0, 240) } : {}),
    };
    stepRecords.push(record);
    if (result.screenshotArtifactRef) evidenceRefs.push(result.screenshotArtifactRef);
    // 分项逐步落库（中断后已完成步骤仍是证据）
    writeRun(db, { ...run, status: "running", steps: [...stepRecords], evidenceRefs: [...evidenceRefs] });
  }

  // 失败现场截图（失败或 required unavailable 时补采一张，作为证据附件引用）
  const aggregated = aggregateStatus(stepRecords);
  if (aggregated.status !== "passed") {
    const shot = await input.verifier.captureScreenshot(opened.browserContextId).catch(() => ({ failed: "capture-error" }) as { artifactRef?: string; failed?: string });
    if (shot.artifactRef) evidenceRefs.push(shot.artifactRef);
  }
  await input.verifier.closeContext(opened.browserContextId).catch(() => undefined);

  return finish({
    status: aggregated.status,
    steps: stepRecords,
    evidenceRefs,
    ...(aggregated.unavailableReason ? { unavailableReason: aggregated.unavailableReason } : {}),
  });
}

/** 取消（spec §11.3：取消关闭当前验证操作；adapter context 的关闭由调用方
 *  在持 verifier 引用处补做——本函数只落终态，不伪造完成证据）。 */
export function cancelBrowserVerificationRun(runId: string): BrowserVerificationRun | null {
  const run = getRun(runId);
  if (!run) return null;
  if (run.status === "passed" || run.status === "failed" || run.status === "cancelled" || run.status === "unavailable") return run;
  const cancelled: BrowserVerificationRun = { ...run, status: "cancelled", endedAt: new Date().toISOString() };
  writeRun(getDb(), cancelled);
  return cancelled;
}

// ===== 证据有效性（fingerprint 绑定）=====

export type RunEvidenceStatus = "valid" | "stale" | "not-passed";

/** run 证据是否仍有效（spec §11.2 末段：验证开始到结束前后核对 fingerprint；
 *  中途改变 → stale，不能 accepted）。非通过终态一律 not-passed
 *  （unavailable 不是通过——测试范围之外不宣称通过）。 */
export function runEvidenceStatus(run: BrowserVerificationRun, currentFingerprint: string): RunEvidenceStatus {
  if (run.status !== "passed") return "not-passed";
  return run.snapshotFingerprint === currentFingerprint ? "valid" : "stale";
}
