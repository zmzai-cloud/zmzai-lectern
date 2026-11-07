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
 *  value（type/key 的真实输入）只经内存参数穿透，动作日志只落 valueMasked。
 *
 *  P0 2026-11-07（PC18/PC19）：
 *  - act 收到 expect（观察时的窗口身份）：adapter 在动作前核对真实前台窗口，
 *    不符返回 fatal:"stale"——5s TTL 不能代替 OS 状态验证（spec §5.2）；
 *  - act 收到 signal：紧急停止中止进行中的平台调用，结果按 unknown 处理；
 *  - userInputIdleMs：距最近一次真实键鼠输入的毫秒数（macOS HIDIdleTime）。
 *    观察之后出现过输入 = 用户接管 → 租约暂停，需用户显式恢复。不可读时
 *    能力受限：禁止无人值守控制（unattended acquire 拒绝）。 */
export type CuaAdapter = {
  capability(): { platform: string; available: boolean; permissions: { accessibility: boolean; screenRecording: boolean }; guidance?: string };
  probeCapability?(): Promise<{ platform: string; available: boolean; permissions: { accessibility: boolean; screenRecording: boolean }; guidance?: string; userTakeover?: boolean }>;
  observe(input: { targetApp: string; windowTitle?: string }): Promise<CuaAdapterResult>;
  act(input: { action: Omit<CuaAction, "id" | "status" | "at">; value?: string; expect?: { app: string; windowTitle: string }; signal?: AbortSignal }): Promise<CuaActResult>;
  userInputIdleMs?(): Promise<number | null>;
};

const OBSERVATION_TTL_MS = 5_000;
/** 观察之后的输入判定余量：HIDIdleTime 与时钟读数的粒度误差。 */
const TAKEOVER_GRACE_MS = 100;
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

/** 重启对账（PC19）：上一个进程退出时仍处于 accepted/executing 的动作——平台
 *  调用可能已发出，也可能没有——一律标 unknown，绝不当作未执行而重放。
 *  租约是进程内存态，重启后旧 lease/observation 全部失效，任何后续动作都要
 *  新租约、新观察。只应在拥有 broker 的进程（armed 下为 Host）首次使用时调用。 */
export function reconcileInterruptedActions(): { reconciled: number } {
  ensureTables();
  const rows = getDb().prepare("SELECT json FROM cua_actions").all() as { json: string }[];
  let reconciled = 0;
  for (const row of rows) {
    const action = JSON.parse(row.json) as CuaAction;
    if (action.status !== "accepted" && action.status !== "executing") continue;
    persistAction({ ...action, status: "unknown", detail: "进程重启时动作未完成：结果无法确认，不会自动重发" });
    reconciled += 1;
  }
  return { reconciled };
}

// ===== Broker =====

export class ComputerUseBroker {
  #lease: ControlSession | null = null;
  #queue: { rootTaskId: string }[] = [];
  #observations = new Map<string, { observation: Observation; revision: number }>();
  /** 进行中动作的中止器（紧急停止用；同一时刻至多一个——服务层串行化动作）。 */
  #inflight: AbortController | null = null;
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

    // PC18 用户接管：观察之后出现过真实键鼠输入 → 屏幕状态可能已被用户改变，
    // 且用户正在使用电脑——暂停租约（恢复须用户显式 resume），本动作不执行
    const observed = this.#observations.get(input.observationId)!.observation;
    if (adapter.userInputIdleMs) {
      const idleMs = await adapter.userInputIdleMs();
      const sinceObservation = Date.now() - Date.parse(observed.at);
      if (idleMs !== null && idleMs + TAKEOVER_GRACE_MS < sinceObservation) {
        lease.status = "paused";
        return { ok: false, reason: "user-takeover" };
      }
    }

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

    // value 只穿内存（日志里只有 valueMasked）；brokers 不缓存 value。
    // expect = 观察时的窗口身份（adapter 动作前核对真实前台窗口）；
    // signal 供紧急停止中止进行中的平台调用
    const controller = new AbortController();
    this.#inflight = controller;
    let result: CuaActResult;
    try {
      result = await adapter.act({
        action: { ...action },
        ...(input.value !== undefined ? { value: input.value } : {}),
        expect: { app: observed.windowIdentity.app, windowTitle: observed.windowIdentity.windowTitle },
        signal: controller.signal,
      });
    } finally {
      if (this.#inflight === controller) this.#inflight = null;
    }
    let finalStatus: CuaActionStatus = result.ok ? "succeeded" : "failed";
    // C04：结果无法确认 → unknown（绝不登记成 succeeded/failed 冒充已确认）。
    // 被紧急停止中止的进行中动作同样 unknown——输入可能已部分到达 OS
    if (!result.ok && (controller.signal.aborted || /(unknown|无法确认|结果未知)/i.test((result as { reason: string }).reason))) finalStatus = "unknown";
    const finished: CuaAction = {
      ...action,
      status: finalStatus,
      ...(result.ok
        ? { detail: result.detail?.slice(0, 240) }
        : { detail: `${(result as { reason: string }).reason}`.slice(0, 240) }),
    };
    persistAction(finished);
    if (!result.ok) {
      const fatal = (result as { fatal?: "app-exit" | "permission-revoked" | "screen-locked" | "stale" }).fatal;
      // 真实窗口与观察不符：该观察作废（不能再拿它重试），须重新观察
      if (fatal === "stale") this.#observations.delete(input.observationId);
      else this.#revokeOnFatal(fatal);
    }
    return result.ok
      ? { ok: true, action: finished, ...(result.text ? { text: result.text } : {}) }
      : { ok: false, reason: (result as { reason: string }).reason, action: finished };
  }

  /** 紧急停止（C03/PC19）：撤销 lease、清空队列——排队旧动作不执行；进行中的
   *  平台调用收到中止信号（已发到 OS 的输入无法撤回，结果记 unknown）。 */
  emergencyStop(): { stopped: boolean; queuedDropped: number; inflightAborted: boolean } {
    const dropped = this.#queue.length;
    this.#queue = [];
    if (this.#lease && this.#lease.status !== "revoked") this.#lease.status = "revoked";
    const inflight = this.#inflight;
    if (inflight) inflight.abort();
    return { stopped: true, queuedDropped: dropped, inflightAborted: !!inflight };
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
