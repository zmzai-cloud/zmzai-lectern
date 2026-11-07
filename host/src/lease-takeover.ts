/** Host 启动时接管前任实例遗留的运行租约（PC11 / spec §4.2，P0 2026-11-07）。
 *
 *  框架只回收 leaseExpiresAt 已过期的租约（时长 10 分钟）：Host 被强杀后立即重启，
 *  原运行中的会话最长约 10 分钟仍显示「执行中」。Host 是数据目录的唯一 owner（启动
 *  持锁、活锁探测），所以持锁后仍挂着的租约若属于已不存在的进程（owner 形如
 *  node:<pid> 且 pid 不存活），必然来自已死的前任——把它们标为已过期，交给预热
 *  runtime 时的官方回收扫描（清租约、workflow 进入恢复审查、追加「运行因服务重启
 *  中断」事件），不另写一套恢复逻辑。
 *
 *  保守：owner 不是 node:<pid> 形式、pid 是本进程、或 pid 仍存活（含 pid 被复用）
 *  一律跳过，照旧等自然过期。必须在预热 runtime（触发扫描）之前调用。 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type LeaseStamper = { stamp(sessionId: string, owner: string, expiresAt: Date): Promise<void> };

function ownerAlive(owner: string): boolean | null {
  const m = /^node:(\d+)$/.exec(owner);
  if (!m) return null; // 非本机进程格式：不判断
  const pid = Number(m[1]);
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // 存在但无权限 = 仍存活
  }
}

/** 返回被标为过期（待官方扫描回收）的会话 id。 */
export async function expireDeadOwnerLeases(dataDir: string, store: LeaseStamper): Promise<string[]> {
  const file = join(dataDir, "zmzai.db");
  if (!existsSync(file)) return [];
  let rows: { id: string; json: string }[] = [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    rows = db.prepare("SELECT id, json FROM sessions WHERE json LIKE '%leaseOwner%'").all() as { id: string; json: string }[];
  } finally {
    db.close();
  }
  const expired: string[] = [];
  for (const row of rows) {
    let session: { leaseOwner?: string; leaseExpiresAt?: string };
    try { session = JSON.parse(row.json) as typeof session; } catch { continue; }
    if (!session.leaseOwner || !session.leaseExpiresAt) continue;
    if (Date.parse(session.leaseExpiresAt) < Date.now()) continue; // 已过期：扫描自会处理
    if (ownerAlive(session.leaseOwner) !== false) continue;
    await store.stamp(row.id, session.leaseOwner, new Date(0));
    expired.push(row.id);
  }
  return expired;
}
