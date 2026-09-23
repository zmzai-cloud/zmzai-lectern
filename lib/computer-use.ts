/** C1-S1：ComputerUseBroker——桌面控制的观察/租约/动作纯逻辑层（spec §12）。
 *
 *  与平台 adapter 的边界：状态机、TTL、单租约、停止/接管、unknown 防盲重试
 *  全在本模块（纯 Node 可测）；截图/AX 树/点击/键盘是注入的 CuaAdapter
 *  （S2 落地 macOS osascript 实现；Windows → capability unavailable）。
 *
 *  安全硬线（C01–C04）：
 *  - Observation TTL 5 秒（adapter 可收紧）；过期/窗口身份变化/revision 不符
 *    → 拒绝陈旧动作，必须重新观察（C02）；
 *  - 全桌面同一时刻只有一个活动 lease；新 rootTask 抢占 = 前租约 revoked
 *    （排队动作作废）（C03）；紧急停止清空队列；用户接管 → paused，
 *    恢复必须显式 resume（C03）；
 *  - 结果无法确认 → status=unknown；同 (leaseId, observationId, kind, target)
 *    的动作不盲目重试——需新观察新动作（C04）；
 *  - adapter 报 app-exit/permission-revoked/screen-locked → 撤 lease，
 *    不复用旧输入队列（C04）。
 *
 *  持久化：动作日志落 deliveries.db cua_actions 表（证据链进 DeliveryAttempt
 *  由 S3 的 CommandRun 映射完成）；lease 态进程内存（Host/Next 单进程语义）。 */
import { randomBytes } from "node:crypto";
import { getDb } from "./delivery.js";

// ===== 契约类型 =====

export type CuaLeaseStatus = "active" | "paused" | "revoked";

export type ControlSession = {
  leaseId: string;
  rootTaskId: string;
  hostInstanceId: string;
  targetApp: string;
  windowId?: string;
  /** 权限范围（本期白名单：observe/click/type/key/scroll/read_text）。 */
  capabilities: string[];
  revision: number;
  status: CuaLeaseStatus;
  acquiredAt: string;
};

export type Observation = {
  observationId: string;
  at: string;
  windowIdentity: { app: string; windowTitle: string; windowId?: string };
  display?: string;
  scale?: number;
  /** accessibility 元数据摘要（按需，不整树）。 */
  axSummary?: string;
};

export type CuaActionKind = "click" | "type" | "key" | "scroll" | "read_text";

export type CuaActionStatus = "accepted" | "executing" | "succeeded" | "failed" | "unknown";

export type CuaAction = {
  id: string;
  leaseId: string;
  observationId: string;
  kind: CuaActionKind;
  target?: string;
  /** 键入值不落库（脱敏占位，如 "***(4)"）。 */
  valueMasked?: string;
  status: CuaActionStatus;
  detail?: string;
  at: string;
};

export type CuaAdapterResult =
  | { ok: true; observation: Observation }
  | { ok: false; reason: string; fatal?: "app-exit" | "permission-revoked" | "screen-locked" };

export type CuaActResult =
  | { ok: true; detail?: string; text?: string }
  | { ok: false; reason: string; fatal?: "app-exit" | "permission-revoked" | "screen-locked" | "stale" };

/** 平台 adapter（S2 macOS 实现；探测失败/Windows → 不可用能力如实报）。
 *  value（type/key 的真实输入）只经内存参数穿透，动作日志只落 valueMasked。 */
export type CuaAdapter = {
  capability(): { platform: string; available: boolean; permissions: { accessibility: boolean; screenRecording: boolean }; guidance?: string };
  probeCapability?(): Promise<{ platform: string; available: boolean; permissions: { accessibility: boolean; screenRecording: boolean }; guidance?: string }>;
  observe(input: { targetApp: string; windowTitle?: string }): Promise<CuaAdapterResult>;
  act(input: { action: Omit<CuaAction, "id" | "status" | "at">; value?: string }): Promise<CuaActResult>;
};

const OBSERVATION_TTL_MS = 5_000;
const CAPABILITY_WHITELIST = new Set(["observe", "click", "type", "key", "scroll", "read_text"]);

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

// ===== 持久化（动作日志）=====

function ensureTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS cua_actions (
      id TEXT PRIMARY KEY,
      lease_id TEXT NOT NULL,
      json TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cua_lease ON cua_actions(lease_id);
  `);
}

function persistAction(action: CuaAction): void {
  ensureTables();
  getDb().prepare("INSERT OR REPLACE INTO cua_actions (id, lease_id, json, at) VALUES (?, ?, ?, ?)")
    .run(action.id, action.leaseId, JSON.stringify(action), action.at);
}

export function listActionsForLease(leaseId: string): CuaAction[] {
  ensureTables();
  const rows = getDb().prepare("SELECT json FROM cua_actions WHERE lease_id = ? ORDER BY at ASC").all(leaseId) as { json: string }[];
  return rows.map((r) => JSON.parse(r.json) as CuaAction);
}

// ===== Broker =====

export class ComputerUseBroker {
  #lease: ControlSession | null = null;
  #queue: { rootTaskId: string }[] = [];
  #observations = new Map<string, { observation: Observation; revision: number }>();
  /** Observation TTL（spec 默认 5s；测试收紧用）。 */
  readonly #ttlMs: number;

  constructor(observationTtlMs = OBSERVATION_TTL_MS) {
    this.#ttlMs = observationTtlMs;
  }

  get activeLease(): ControlSession | null {
    return this.#lease?.status === "active" ? this.#lease : null;
  }

  leaseStatus(): ControlSession | null {
    return this.#lease;
  }

  /** 取得桌面控制租约（spec §12.2：全桌面只有一个 lease，按根 Task 排队）。
   *  已有活动 lease 且同 rootTask → 幂等返回；不同 rootTask → 排队（返回排队位）。 */
  acquireLease(input: { rootTaskId: string; hostInstanceId: string; targetApp: string; capabilities?: string[] }):
    | { ok: true; lease: ControlSession }
    | { ok: false; reason: "queued"; position: number; heldBy: string }
    | { ok: false; reason: "invalid-capabilities"; detail?: string } {
    const capabilities = (input.capabilities ?? [...CAPABILITY_WHITELIST]).filter((c) => CAPABILITY_WHITELIST.has(c));
    if (capabilities.length === 0) return { ok: false, reason: "invalid-capabilities" };

    if (this.#lease && this.#lease.status === "active") {
      if (this.#lease.rootTaskId === input.rootTaskId) return { ok: true, lease: this.#lease };
      // 不同根任务 → 排队（不抢占：用户在用的控制不被新任务无声顶掉）
      this.#queue.push({ rootTaskId: input.rootTaskId });
      return { ok: false, reason: "queued", position: this.#queue.length, heldBy: this.#lease.rootTaskId };
    }
    // paused/revoked 的旧租约让位
    this.#lease = {
      leaseId: newId("cua"),
      rootTaskId: input.rootTaskId,
      hostInstanceId: input.hostInstanceId,
      targetApp: input.targetApp,
      capabilities,
      revision: 1,
      status: "active",
      acquiredAt: new Date().toISOString(),
    };
    return { ok: true, lease: this.#lease };
  }

  #leaseUsable(leaseId: string): ControlSession | null {
    if (!this.#lease || this.#lease.leaseId !== leaseId) return null;
    if (this.#lease.status !== "active") return null;
    return this.#lease;
  }

  /** 观察（spec §12.2：Observation 绑定窗口身份；adapter 收紧 TTL 可传 shorterTtlMs）。 */
  async observe(leaseId: string, adapter: CuaAdapter): Promise<CuaAdapterResult> {
    const lease = this.#leaseUsable(leaseId);
    if (!lease) return { ok: false, reason: "lease-not-active" };
    const observed = await adapter.observe({ targetApp: lease.targetApp });
    if (!observed.ok) {
      this.#revokeOnFatal(observed.fatal);
      return observed;
    }
    // revision 前进后记录：此后任何 lease 状态变化（resume/re-observe）都使
    // 旧观察失效（C02：lease revision 也是观察有效性的一部分）
    lease.revision += 1;
    const observation = { ...observed.observation, observationId: newId("obs") };
    this.#observations.set(observation.observationId, { observation, revision: lease.revision });
    return { ok: true, observation };
  }

  /** Observation 是否仍有效（TTL + 租约 revision 未变 + 窗口身份一致）。 */
  observationValid(observationId: string): boolean {
    const entry = this.#observations.get(observationId);
    if (!entry || !this.#lease || this.#lease.status !== "active") return false;
    if (entry.revision !== this.#lease.revision) return false; // resume/再观察后旧观察失效
    if (Date.now() - Date.parse(entry.observation.at) > this.#ttlMs) return false;
    // 窗口身份与租约目标一致（app 不符 = 换了目标，需重新取租约/观察）
    return entry.observation.windowIdentity.app === this.#lease.targetApp;
  }

  #revokeOnFatal(fatal?: "app-exit" | "permission-revoked" | "screen-locked"): void {
    if (!fatal || !this.#lease) return;
    this.#lease.status = "revoked";
    this.#queue = []; // 不复用旧输入队列（C04）
  }

  /** 执行一个动作（一次 API = 一个动作；长串坐标脚本由调用方逐动作核验编排）。 */
  async act(leaseId: string, input: { observationId: string; kind: CuaActionKind; target?: string; value?: string; valueMasked?: string }, adapter: CuaAdapter):
    Promise<{ ok: true; action: CuaAction; text?: string } | { ok: false; reason: string; action?: CuaAction }> {
    const lease = this.#leaseUsable(leaseId);
    if (!lease) return { ok: false, reason: "lease-not-active" };

    // C02：陈旧观察拒绝（TTL 过期/身份变化）
    if (!this.observationValid(input.observationId)) return { ok: false, reason: "stale-observation" };

    // C04：unknown 动作不盲目重试（同 lease+observation+kind+target 视为重试）
    const prior = listActionsForLease(leaseId);
    const isBlindRetry = prior.some(
      (a) => a.status === "unknown" && a.observationId === input.observationId
        && a.kind === input.kind && a.target === input.target,
    );
    if (isBlindRetry) return { ok: false, reason: "blind-retry-rejected" };

    // 权限范围检查（lease capabilities 白名单）
    if (!lease.capabilities.includes(input.kind)) return { ok: false, reason: "capability-not-granted" };

    const action: CuaAction = {
      id: newId("act"),
      leaseId, observationId: input.observationId,
      kind: input.kind,
      ...(input.target ? { target: input.target } : {}),
      ...(input.valueMasked ? { valueMasked: input.valueMasked } : {}),
      status: "executing",
      at: new Date().toISOString(),
    };
    persistAction(action);

    // value 只穿内存（日志里只有 valueMasked）；brokers 不缓存 value
    const result = await adapter.act({ action: { ...action }, ...(input.value !== undefined ? { value: input.value } : {}) });
    let finalStatus: CuaActionStatus = result.ok ? "succeeded" : "failed";
    // C04：结果无法确认 → unknown（绝不登记成 succeeded/failed 冒充已确认）
    if (!result.ok && /(unknown|无法确认|结果未知)/i.test((result as { reason: string }).reason)) finalStatus = "unknown";
    const finished: CuaAction = {
      ...action,
      status: finalStatus,
      ...(result.ok
        ? { detail: result.detail?.slice(0, 240) }
        : { detail: `${(result as { reason: string }).reason}`.slice(0, 240) }),
    };
    persistAction(finished);
    if (!result.ok) this.#revokeOnFatal((result as { fatal?: "app-exit" | "permission-revoked" | "screen-locked" }).fatal);
    return result.ok
      ? { ok: true, action: finished, ...(result.text ? { text: result.text } : {}) }
      : { ok: false, reason: (result as { reason: string }).reason, action: finished };
  }

  /** 紧急停止（C03）：撤销 lease、清空队列——排队旧动作不执行。 */
  emergencyStop(): { stopped: boolean; queuedDropped: number } {
    const dropped = this.#queue.length;
    this.#queue = [];
    if (this.#lease && this.#lease.status !== "revoked") this.#lease.status = "revoked";
    return { stopped: true, queuedDropped: dropped };
  }

  /** 用户接管（C03）：lease → paused；恢复需显式 resume（新观察）。 */
  takeover(): boolean {
    if (!this.#lease || this.#lease.status !== "active") return false;
    this.#lease.status = "paused";
    return true;
  }

  /** 恢复（用户明确继续）：paused → active，revision 前进（旧观察全失效）。 */
  resume(leaseId: string): boolean {
    if (!this.#lease || this.#lease.leaseId !== leaseId || this.#lease.status !== "paused") return false;
    this.#lease.status = "active";
    this.#lease.revision += 1;
    return true;
  }

  /** 释放租约：revoked + 队首出队（接棒任务重新 acquire；无队首即空闲）。 */
  release(leaseId: string): { released: boolean; nextQueued: string | null } {
    if (!this.#lease || this.#lease.leaseId !== leaseId) return { released: false, nextQueued: null };
    this.#lease.status = "revoked";
    const next = this.#queue.shift() ?? null;
    this.#lease = null;
    return { released: true, nextQueued: next?.rootTaskId ?? null };
  }
}
