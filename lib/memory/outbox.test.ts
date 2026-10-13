import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vite's builtin enumeration omits node:sqlite on some Node versions.
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

const state = vi.hoisted(() => ({ data: "" }));
vi.mock("../projects", () => ({
  dataDirFor: (p: { id: string }) => join(state.data, p.id),
}));
vi.mock("../settings", () => ({
  memoryPat: () => "zmk_test_pat",
}));

import { drainOutbox, enqueueApprovedCandidates, listOutbox, retryOutboxRow } from "./outbox.js";
import { resetMemoryDbHandlesForTest, ensureAutoBinding, openMemoryDb, rebindMemory, setMemoryEnabled } from "./binding.js";
import type { MemoryResult } from "./client.js";

const project = { id: "p_ob", name: "outbox 测试" };

type RetainMock = ReturnType<typeof vi.fn>;

function clientWith(overrides: { retain?: RetainMock; operationStatus?: ReturnType<typeof vi.fn> } = {}) {
  return {
    retain: overrides.retain ?? vi.fn(async (): Promise<MemoryResult<Record<string, unknown>>> => ({ ok: true, data: { ok: true, operationId: "op-1" } })),
    operationStatus: overrides.operationStatus ?? vi.fn(async (): Promise<MemoryResult<Record<string, unknown>>> => ({ ok: true, data: { status: "succeeded" } })),
  };
}

async function seedApprovedCandidate(statement: string, kind = "command"): Promise<number> {
  const db = openMemoryDb(project.id);
  const result = db
    .prepare("INSERT INTO memory_candidates (projectId, statement, kind, scope, status, createdAt) VALUES (?, ?, ?, 'project', 'approved', ?)")
    .run(project.id, statement, kind, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

beforeEach(async () => {
  state.data = mkdtempSync(join(tmpdir(), "k1-outbox-"));
  resetMemoryDbHandlesForTest();
  await ensureAutoBinding(project, { createBank: vi.fn(async () => ({ ok: true as const, data: { ok: true as const, bankId: "x" } })) });
});

afterEach(() => {
  rmSync(state.data, { recursive: true, force: true });
});

describe("enqueueApprovedCandidates", () => {
  it("approved 候选 → pending 行（确定性幂等键 + payload 带 tags/context）；重复扫描零副作用", async () => {
    const id = await seedApprovedCandidate("构建用 pnpm test");
    expect(enqueueApprovedCandidates(project.id)).toBe(1);
    expect(enqueueApprovedCandidates(project.id)).toBe(0);
    const rows = listOutbox(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "pending", attempts: 0, bindingVersion: 1 });
    expect(rows[0].payload).toEqual({
      content: "构建用 pnpm test",
      tags: ["command", "project"],
      context: JSON.stringify({ source: "lectern", candidateId: id }),
    });
  });

  it("binding 禁用时入队为 0", async () => {
    await seedApprovedCandidate("不该入队");
    setMemoryEnabled(project.id, false);
    expect(enqueueApprovedCandidates(project.id)).toBe(0);
  });
});

describe("drainOutbox 状态机", () => {
  it("成功路径：pending → retain(async) → accepted+operationId → operationStatus → succeeded", async () => {
    await seedApprovedCandidate("成功路径语句");
    enqueueApprovedCandidates(project.id);
    const retain = vi.fn(async (_bank: string, content: string, opts: Record<string, unknown>) => {
      expect(opts.idempotencyKey).toBe(listOutbox(project.id)[0].idempotencyKey);
      expect(opts.async).toBe(true);
      expect(content).toBe("成功路径语句");
      return { ok: true as const, data: { operationId: "op-abc" } };
    });
    const report1 = await drainOutbox(project.id, clientWith({ retain }));
    expect(report1).toMatchObject({ sent: 1 });
    expect(listOutbox(project.id)[0]).toMatchObject({ state: "accepted", operationId: "op-abc" });

    const report2 = await drainOutbox(project.id, clientWith({ retain }));
    expect(report2.succeeded).toBe(1);
    expect(listOutbox(project.id)[0].state).toBe("succeeded");
  });

  it("网络失败：退避内不重发；3 次后退避→failed；手动重试后可恢复", async () => {
    await seedApprovedCandidate("失败重试语句");
    enqueueApprovedCandidates(project.id);
    const fail = vi.fn(async () => ({ ok: false as const, kind: "network" as const }));
    await drainOutbox(project.id, clientWith({ retain: fail }));
    expect(listOutbox(project.id)[0]).toMatchObject({ state: "pending", attempts: 1 });

    // 退避未到：不再发
    await drainOutbox(project.id, clientWith({ retain: fail }));
    expect(fail).toHaveBeenCalledTimes(1);

    // 退避到期（直接改 updatedAt 模拟时间流逝）→ 第 2、3 次 → failed
    const db = openMemoryDb(project.id);
    const age = (ms: number) => db.prepare("UPDATE memory_outbox SET updatedAt = ?").run(new Date(Date.now() - ms).toISOString());
    age(60_000);
    await drainOutbox(project.id, clientWith({ retain: fail }));
    expect(listOutbox(project.id)[0]).toMatchObject({ state: "pending", attempts: 2 });
    age(180_000);
    await drainOutbox(project.id, clientWith({ retain: fail }));
    expect(listOutbox(project.id)[0]).toMatchObject({ state: "failed", attempts: 3, lastError: "network" });

    // 手动重试 → pending(attempts=0) → 下一轮成功
    expect(retryOutboxRow(project.id, listOutbox(project.id)[0].id)).toBe(true);
    const ok = vi.fn(async () => ({ ok: true as const, data: { operationId: "op-x" } }));
    await drainOutbox(project.id, clientWith({ retain: ok }));
    expect(listOutbox(project.id)[0].state).toBe("accepted");
  });

  it("401：暂停本轮、不计数、lastError=UNAUTHENTICATED", async () => {
    await seedApprovedCandidate("401 暂停语句");
    enqueueApprovedCandidates(project.id);
    const unauth = vi.fn(async () => ({ ok: false as const, kind: "unauthenticated" as const, status: 401 }));
    const report = await drainOutbox(project.id, clientWith({ retain: unauth }));
    expect(report.paused).toBe(true);
    expect(listOutbox(project.id)[0]).toMatchObject({ state: "pending", attempts: 0, lastError: "UNAUTHENTICATED" });
  });

  it("sending 悬置恢复 → unknown；有 operationId 的 unknown 轮询收敛；无 operationId 保留待人工", async () => {
    await seedApprovedCandidate("悬置恢复语句");
    enqueueApprovedCandidates(project.id);
    const db = openMemoryDb(project.id);
    const rowId = listOutbox(project.id)[0].id;
    // 模拟进程崩溃：行卡 sending 且 updatedAt 超阈值，带 operationId（提交过）
    db.prepare("UPDATE memory_outbox SET state = 'sending', operationId = 'op-zombie', updatedAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 120_000).toISOString(), rowId);

    await drainOutbox(project.id, clientWith());
    expect(listOutbox(project.id)[0]).toMatchObject({ state: "succeeded" });

    // 无 operationId 的 unknown：drain 后仍是 unknown（不盲重发）
    db.prepare("UPDATE memory_outbox SET state = 'unknown', operationId = NULL, updatedAt = ? WHERE id = ?")
      .run(new Date().toISOString(), rowId);
    await drainOutbox(project.id, clientWith());
    expect(listOutbox(project.id)[0].state).toBe("unknown");
  });

  it("bindingVersion 不匹配的 pending → orphaned（重绑后旧记录绝不发新 bank）", async () => {
    await seedApprovedCandidate("旧版本语句");
    enqueueApprovedCandidates(project.id);
    rebindMemory(project.id, { bankId: "ws_newbank", bankName: "新库", source: "manual" });
    const retain = vi.fn(async () => ({ ok: true as const, data: { operationId: "op-never" } }));
    await drainOutbox(project.id, clientWith({ retain }));
    expect(retain).not.toHaveBeenCalled();
    expect(listOutbox(project.id)[0].state).toBe("orphaned");
  });
});
