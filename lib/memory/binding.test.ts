import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vite's builtin enumeration omits node:sqlite on some Node versions.
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

// 文件级共享 dataDir（delivery-owner.test 同款约定：句柄缓存指向的目录不能中途消失）
const state = vi.hoisted(() => ({ data: "" }));
vi.mock("../projects", () => ({
  dataDirFor: (p: { id: string }) => join(state.data, p.id),
}));
vi.mock("../settings", () => ({
  memoryAccountUserId: () => "u_test",
  ensureMemoryInstallNonce: () => "0123456789abcdef0123456789abcdef",
}));

import {
  deterministicBankId,
  ensureAutoBinding,
  getMemoryBinding,
  openMemoryDb,
  recordRecall,
  rebindMemory,
  resetMemoryDbHandlesForTest,
  setMemorySyncPolicy,
} from "./binding.js";

const project = { id: "p_test1", name: "测试项目", path: "/tmp/x", createdAt: "1970-01-01T00:00:00.000Z" };

function okClient() {
  return {
    createBank: vi.fn(async () => ({
      ok: true as const,
      data: { ok: true as const, bankId: deterministicBankId(project.id) },
    })),
  };
}

beforeEach(() => {
  state.data = mkdtempSync(join(tmpdir(), "k1-binding-"));
  resetMemoryDbHandlesForTest();
});

afterEach(() => {
  rmSync(state.data, { recursive: true, force: true });
});

describe("deterministicBankId", () => {
  it("lec_ 前缀 + 24 hex + 跨调用稳定 + 项目间区分", () => {
    const a = deterministicBankId("p_one");
    expect(a.startsWith("lec_")).toBe(true);
    expect(a.slice(4)).toMatch(/^[0-9a-f]{24}$/);
    expect(deterministicBankId("p_one")).toBe(a);
    expect(deterministicBankId("p_two")).not.toBe(a);
  });
});

describe("ensureAutoBinding（项目自动建库）", () => {
  it("无 binding 时建库并落绑定：确定性 bankId、bankName=项目名、manual/auto 默认档", async () => {
    const client = okClient();
    const result = await ensureAutoBinding(project, client);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.binding.bankId).toBe(deterministicBankId(project.id));
    expect(result.binding.bankName).toBe("测试项目");
    expect(result.binding.syncPolicy).toBe("manual");
    expect(result.binding.source).toBe("auto");
    expect(result.binding.enabled).toBe(1);
    expect(client.createBank).toHaveBeenCalledWith(deterministicBankId(project.id), "测试项目");
  });

  it("幂等：已有 binding 直接返回，不再打服务端", async () => {
    const client = okClient();
    await ensureAutoBinding(project, client);
    const again = await ensureAutoBinding(project, client);
    expect(again.ok && again.created).toBe(false);
    expect(client.createBank).toHaveBeenCalledTimes(1);
  });

  it("默认项目按账号区分，切换账户自动建新库并孤儿化旧队列", async () => {
    expect(deterministicBankId("default", "u_test")).not.toBe(deterministicBankId("default", "u_other"));
    const client = okClient();
    await ensureAutoBinding(project, client, "u_test");
    const before = getMemoryBinding(project.id)!;
    const switched = await ensureAutoBinding(project, client, "u_other");
    expect(switched.ok).toBe(true);
    if (!switched.ok) return;
    expect(switched.binding.accountUserId).toBe("u_other");
    expect(switched.binding.bankId).not.toBe(before.bankId);
    expect(switched.binding.bindingVersion).toBe(before.bindingVersion + 1);
  });

  it("建库失败不落 binding（下个根目标自然重触发）", async () => {
    const client = { createBank: vi.fn(async () => ({ ok: false as const, kind: "network" as const })) };
    const result = await ensureAutoBinding(project, client);
    expect(result.ok).toBe(false);
    expect(getMemoryBinding(project.id)).toBeNull();
  });
});

describe("rebindMemory（换绑孤儿语义，spec 红线：旧待上传不发新 bank）", () => {
  it("version 递增、未终态 outbox 标 orphaned、succeeded 保留、bank 字段更新", async () => {
    await ensureAutoBinding(project, okClient());
    const db = openMemoryDb(project.id);
    const now = new Date().toISOString();
    const insert = db.prepare(
      "INSERT INTO memory_outbox (projectId, bindingVersion, idempotencyKey, payload, state, attempts, createdAt, updatedAt) VALUES (?, 1, ?, '{}', ?, 0, ?, ?)",
    );
    for (const key of ["k-pending", "k-sending", "k-failed", "k-unknown", "k-done"]) {
      insert.run(project.id, key, key === "k-done" ? "succeeded" : key === "k-failed" ? "failed" : key === "k-unknown" ? "unknown" : key === "k-sending" ? "sending" : "pending", now, now);
    }

    const next = rebindMemory(project.id, { bankId: "ws_shared", bankName: "Agent 工作区", source: "manual" });
    expect(next.bankId).toBe("ws_shared");
    expect(next.bindingVersion).toBe(2);
    expect(next.source).toBe("manual");

    const states = Object.fromEntries(
      (db.prepare("SELECT idempotencyKey AS k, state FROM memory_outbox").all() as Array<{ k: string; state: string }>).map((r) => [r.k, r.state]),
    );
    expect(states["k-pending"]).toBe("orphaned");
    expect(states["k-sending"]).toBe("orphaned");
    expect(states["k-failed"]).toBe("orphaned");
    expect(states["k-unknown"]).toBe("orphaned");
    expect(states["k-done"]).toBe("succeeded");
  });

  it("再次换绑 version 继续递增", async () => {
    await ensureAutoBinding(project, okClient());
    rebindMemory(project.id, { bankId: "b2", bankName: "二", source: "manual" });
    const again = rebindMemory(project.id, { bankId: "b3", bankName: "三", source: "manual" });
    expect(again.bindingVersion).toBe(3);
  });
});

describe("syncPolicy / recall_log", () => {
  it("setMemorySyncPolicy 落库可读回；recordRecall 写入日志行", async () => {
    await ensureAutoBinding(project, okClient());
    setMemorySyncPolicy(project.id, "auto");
    expect(getMemoryBinding(project.id)?.syncPolicy).toBe("auto");

    recordRecall(project.id, { sessionId: "ses_1", goalDigest: "abc", hitCount: 3, hits: [{ text: "x" }], usedTokens: 120 });
    const row = openMemoryDb(project.id).prepare("SELECT * FROM memory_recall_log").get() as { sessionId: string; hitCount: number; hits: string };
    expect(row.sessionId).toBe("ses_1");
    expect(row.hitCount).toBe(3);
    expect(JSON.parse(row.hits)).toEqual([{ text: "x" }]);
  });
});
