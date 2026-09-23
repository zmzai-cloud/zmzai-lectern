/** W1 后 V1-S2：受管服务实例（spec §11.2.2）——解析/复用/就绪检查/停止。
 *
 *  语义硬线：
 *  - 优先复用「同 workspace、同代码版本可核对」的已注册服务（fingerprint 相同
 *    才复用），否则 owned 启动（受管进程：注入 spawnService，生产接 TerminalManager，
 *    端口 Host 分配——不手工约定 3000）；
 *  - 就绪检查核对**实际 origin 与应用标识**（页面 title/meta 标记）——端口可连接
 *    ≠ 正确项目已启动；
 *  - borrowed 用户服务只观察与绑定，**不可停止不可改写**（取消/回收仅解除绑定）；
 *  - owned 启动失败不伪报：记录保留（healthCheck.ok=false），可修复重试。
 *
 *  存储复用 deliveries.db 的 service_instances 表（S1 建表）。 */
import { randomBytes } from "node:crypto";
import { getDb } from "./delivery.js";
import { allocatePort } from "./workspace-service.js";

export type ServiceInstanceStatus = "starting" | "running" | "unhealthy" | "stopped";

export type ServiceInstance = {
  id: string;
  workspaceId: string;
  attemptId?: string;
  cwd: string;
  declaredCommand: string;
  /** owned 启动绑定的受管进程通道（TerminalManager session id）。 */
  terminalId?: string;
  processIdentity?: { pid: number; startedAt: string };
  actualOrigin?: string;
  healthCheck?: { at: string; ok: boolean; appIdentity?: string };
  /** 启动/绑定时的代码快照指纹——复用判定的「同代码版本可核对」锚点。 */
  snapshotFingerprint?: string;
  /** owned=Host 启动可停；borrowed=只绑定不停（spec §11.2.2/§11.3）。 */
  owned: boolean;
  status: ServiceInstanceStatus;
};

export type ProbeResult = { ok: boolean; appIdentity?: string; reason?: string };

/** 应用标识提取：页面 title + 显式 meta 标记（lectern-app/generator）。
 *  端口可连但标识不符 → ok:false（identity-mismatch）。 */
export async function probeOrigin(origin: string, expectedAppIdentity?: string, opts: { timeoutMs?: number } = {}): Promise<ProbeResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 3000);
  try {
    const res = await fetch(origin, { signal: ac.signal, redirect: "manual" });
    if (!res.ok && res.status >= 400) return { ok: false, reason: `http-${res.status}` };
    const text = (await res.text()).slice(0, 64 * 1024);
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() ?? "";
    const meta = /<meta[^>]+name=["'](?:lectern-app|generator)["'][^>]+content=["']([^"']*)["']/i.exec(text)?.[1]?.trim() ?? "";
    const appIdentity = [title, meta].filter(Boolean).join("|") || `status-${res.status}`;
    if (expectedAppIdentity && appIdentity !== expectedAppIdentity) {
      return { ok: false, appIdentity, reason: `identity-mismatch: 期望 ${expectedAppIdentity}，实际 ${appIdentity}` };
    }
    return { ok: true, appIdentity };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

// ===== 持久化 =====

function ensureTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS service_instances (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      attempt_id TEXT,
      cwd TEXT NOT NULL,
      declared_command TEXT NOT NULL,
      owned INTEGER NOT NULL,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_svc_workspace ON service_instances(workspace_id);
  `);
}

function writeService(instance: ServiceInstance): void {
  ensureTables();
  getDb().prepare(
    `INSERT OR REPLACE INTO service_instances (id, workspace_id, attempt_id, cwd, declared_command, owned, json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(instance.id, instance.workspaceId, instance.attemptId ?? null, instance.cwd, instance.declaredCommand, instance.owned ? 1 : 0, JSON.stringify(instance), new Date().toISOString());
}

export function getService(id: string): ServiceInstance | null {
  ensureTables();
  const row = getDb().prepare("SELECT json FROM service_instances WHERE id = ?").get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as ServiceInstance) : null;
}

export function listServicesForWorkspace(workspaceId: string): ServiceInstance[] {
  ensureTables();
  const rows = getDb().prepare("SELECT json FROM service_instances WHERE workspace_id = ? ORDER BY created_at ASC").all(workspaceId) as { json: string }[];
  return rows.map((r) => JSON.parse(r.json) as ServiceInstance);
}

/** 复用判定（spec §11.2.2 优先复用）：同 workspace + running + 健康 +
 *  （提供 fingerprint 时必须相同——同代码版本可核对，不同版本不复用防串台）。 */
export function findReusableService(input: { workspaceId: string; snapshotFingerprint?: string }): ServiceInstance | null {
  const candidates = listServicesForWorkspace(input.workspaceId).filter(
    (s) => s.status === "running" && s.healthCheck?.ok && s.actualOrigin,
  );
  if (input.snapshotFingerprint) {
    return candidates.find((s) => s.snapshotFingerprint === input.snapshotFingerprint) ?? null;
  }
  return candidates[0] ?? null;
}

// ===== 依赖注入（生产接线：TerminalManager + fetch + allocatePort）=====

export type ServiceDeps = {
  /** 受管进程启动（生产=TerminalManager.start；返回停止通道 id）。 */
  spawnService(input: { command: string; cwd: string; env?: Record<string, string> }): Promise<{ terminalId: string; pid?: number }>;
  stopSpawned(terminalId: string): Promise<void>;
  portAllocator(workspaceId: string, preferred?: number): number;
  probe(origin: string, expected?: string): Promise<ProbeResult>;
};

/** owned 受管服务启动序列：复用探测 → 端口分配 → 受管进程 → 就绪轮询（探实际
 *  origin 与应用标识）→ 落库。失败不伪报：保留 unhealthy 记录（可修复重试）。 */
export async function startOwnedService(input: {
  workspaceId: string;
  attemptId?: string;
  cwd: string;
  /** 命令模板，{port} 占位替换；缺省直接注入 PORT env。 */
  command: string;
  snapshotFingerprint?: string;
  expectedAppIdentity?: string;
  preferredPort?: number;
  readyTimeoutMs?: number;
}, deps: ServiceDeps): Promise<{ ok: true; instance: ServiceInstance } | { ok: false; instance: ServiceInstance; reason: string }> {
  const reused = findReusableService({ workspaceId: input.workspaceId, snapshotFingerprint: input.snapshotFingerprint });
  if (reused) return { ok: true, instance: reused };

  const port = deps.portAllocator(input.workspaceId, input.preferredPort);
  const origin = `http://127.0.0.1:${port}`;
  const id = `svc_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
  let instance: ServiceInstance = {
    id, workspaceId: input.workspaceId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    cwd: input.cwd, declaredCommand: input.command,
    owned: true, status: "starting",
    ...(input.snapshotFingerprint ? { snapshotFingerprint: input.snapshotFingerprint } : {}),
  };
  writeService(instance);

  let spawned: { terminalId: string; pid?: number } | null = null;
  try {
    spawned = await deps.spawnService({
      command: input.command.includes("{port}") ? input.command.replaceAll("{port}", String(port)) : input.command,
      cwd: input.cwd,
      env: { PORT: String(port), HOST: "127.0.0.1" },
    });
  } catch (error) {
    const failed: ServiceInstance = { ...instance, status: "unhealthy", healthCheck: { at: new Date().toISOString(), ok: false }, };
    instance = failed;
    writeService(failed);
    return { ok: false, instance: failed, reason: `spawn 失败：${error instanceof Error ? error.message : String(error)}` };
  }
  instance = { ...instance, terminalId: spawned.terminalId, ...(spawned.pid != null ? { processIdentity: { pid: spawned.pid, startedAt: new Date().toISOString() } } : {}) };
  writeService(instance);

  // 就绪轮询：核对实际 origin 与应用标识（端口可连 ≠ 正确项目已启动）
  const deadline = Date.now() + (input.readyTimeoutMs ?? 30_000);
  let probe: ProbeResult = { ok: false, reason: "not-probed" };
  while (Date.now() < deadline) {
    probe = await deps.probe(origin, input.expectedAppIdentity);
    if (probe.ok) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const ready: ServiceInstance = {
    ...instance,
    status: probe.ok ? "running" : "unhealthy",
    actualOrigin: probe.ok ? origin : undefined,
    healthCheck: { at: new Date().toISOString(), ok: probe.ok, ...(probe.appIdentity ? { appIdentity: probe.appIdentity } : {}) },
  };
  writeService(ready);
  return probe.ok
    ? { ok: true, instance: ready }
    : { ok: false, instance: ready, reason: `就绪检查未通过：${probe.reason ?? "timeout"}` };
}

/** borrowed 用户服务登记（只观察绑定，不启动不停止）。探测通过才登记。 */
export async function registerBorrowedService(input: {
  workspaceId: string; attemptId?: string; cwd: string; origin: string;
  expectedAppIdentity?: string; snapshotFingerprint?: string;
}, deps: Pick<ServiceDeps, "probe">): Promise<{ ok: true; instance: ServiceInstance } | { ok: false; reason: string }> {
  const probe = await deps.probe(input.origin, input.expectedAppIdentity);
  if (!probe.ok) return { ok: false, reason: `borrowed 服务探测失败：${probe.reason}` };
  const instance: ServiceInstance = {
    id: `svc_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`,
    workspaceId: input.workspaceId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    cwd: input.cwd, declaredCommand: "(borrowed)",
    actualOrigin: input.origin, owned: false, status: "running",
    healthCheck: { at: new Date().toISOString(), ok: true, appIdentity: probe.appIdentity },
    ...(input.snapshotFingerprint ? { snapshotFingerprint: input.snapshotFingerprint } : {}),
  };
  writeService(instance);
  return { ok: true, instance };
}

/** 停止（spec §11.3）：owned 走受管通道停止并标 stopped；borrowed 一律拒绝
 *  （用户服务只解除绑定——V04：borrowed 服务不被停止）。 */
export async function stopServiceInstance(id: string, deps: Pick<ServiceDeps, "stopSpawned">): Promise<{ ok: boolean; reason?: string }> {
  const instance = getService(id);
  if (!instance) return { ok: false, reason: "not-found" };
  if (!instance.owned) return { ok: false, reason: "borrowed 服务不可停止（仅解除绑定）" };
  if (instance.status === "stopped") return { ok: true };
  if (instance.terminalId) await deps.stopSpawned(instance.terminalId).catch(() => undefined);
  writeService({ ...instance, status: "stopped" });
  return { ok: true };
}

/** 生产依赖装配（Host 进程内：TerminalManager 受管进程 + 真实 fetch 探测 +
 *  W1-S24 端口分配器）。 */
export function hostServiceDeps(terminal: {
  start(input: { command: string; cwd: string; env?: Record<string, string> }): Promise<{ id: string }>;
  kill(id: string): void;
}): ServiceDeps {
  return {
    spawnService: async (input) => {
      const info = await terminal.start(input);
      return { terminalId: info.id };
    },
    stopSpawned: async (terminalId) => { terminal.kill(terminalId); },
    portAllocator: (workspaceId, preferred) => allocatePort(workspaceId, preferred),
    probe: (origin, expected) => probeOrigin(origin, expected),
  };
}
