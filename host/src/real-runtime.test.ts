import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/** T08 / PC12（production-chain-closure，spec §4.3 / F05）：Host 真实 runtime
 *  面按会话归属/显式 projectId 解析——不捕获默认工作区 runtime。
 *
 *  双项目 fixture（各自独立 SQLite 库）：列表全项目聚合、projectId 过滤、
 *  未知项目报错不空成功；会话读写路由到归属项目库；跨项目重复会话 id 拒绝。 */

vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

type RealRuntimeModule = typeof import("./real-runtime.js");
type Framework = typeof import("@zmzai/agent-framework");
type Face = ReturnType<RealRuntimeModule["buildRealRuntimeFace"]>;

type Booted = {
  dir: string;
  face: Face;
  framework: Framework;
  sessionA1: string;
  sessionA2: string;
  sessionB1: string;
};

async function boot(): Promise<Booted> {
  const dir = await mkdtemp(path.join(tmpdir(), "t08-pc12-"));
  const dataDir = path.join(dir, "data");
  const projA = path.join(dir, "projA");
  const projB = path.join(dir, "projB");
  const defaultWs = path.join(dir, "ws-default");
  for (const d of [dataDir, projA, projB, defaultWs]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(dataDir, "projects.json"), JSON.stringify({
    activeId: "default",
    projects: [
      { id: "p_a", name: "A", path: projA, createdAt: new Date().toISOString() },
      { id: "p_b", name: "B", path: projB, createdAt: new Date().toISOString() },
    ],
  }));

  // env 先行（runtime-constants 模块加载期求值）→ resetModules → 动态 import
  process.env.LECTERN_DATA_DIR = dataDir;
  process.env.LECTERN_WORKSPACE = defaultWs;
  vi.resetModules();
  const globals = globalThis as Record<string, unknown>;
  for (const key of ["__lecternRuntimes", "__lecternProjectStores", "__lecternMcp", "__lecternTerminalManager", "__lecternLeaseTargets", "__lecternSubagentAdmission", "__lecternLeaseTimer"]) {
    delete globals[key];
  }
  const { buildRealRuntimeFace } = await import("./real-runtime.js");
  const framework: Framework = await import("@zmzai/agent-framework");

  // 两项目各建会话（非默认项目库在 dataDir/projects/<id>/）
  const storeA = framework.createSqliteSessionStore({ dataDir: path.join(dataDir, "projects", "p_a") });
  const storeB = framework.createSqliteSessionStore({ dataDir: path.join(dataDir, "projects", "p_b") });
  const mk = async (store: Framework["createSqliteSessionStore"] extends (...a: never) => infer R ? R : never, userId: string) =>
    (await framework.createFrameworkSession({ store: store as never, userId, workspaceId: "ws", model: { providerId: "openai", modelId: "m" }, prompt: "s" })).id;
  const sessionA1 = await mk(storeA as never, "u1");
  const sessionA2 = await mk(storeA as never, "u1");
  const sessionB1 = await mk(storeB as never, "u1");

  return { dir, face: buildRealRuntimeFace({ credentialFor: () => null }), framework, sessionA1, sessionA2, sessionB1 };
}

async function cleanup(dir: string): Promise<void> {
  delete process.env.LECTERN_DATA_DIR;
  delete process.env.LECTERN_WORKSPACE;
  await rm(dir, { recursive: true, force: true });
}

describe("T08/PC12：Host 真实 runtime 面归属解析（F05——不捕获默认 rt）", () => {
  it("列表全项目聚合；projectId 过滤正确；未知 projectId 报错（不空成功）", async () => {
    const b = await boot();
    try {
      const all = (await b.face.listSessions({ userId: "u1" })) as unknown as { id: string }[];
      expect(all.map((s) => s.id).sort()).toEqual([b.sessionA1, b.sessionA2, b.sessionB1].sort());

      const onlyA = (await b.face.listSessions({ userId: "u1", projectId: "p_a" })) as unknown as { id: string }[];
      expect(onlyA.map((s) => s.id).sort()).toEqual([b.sessionA1, b.sessionA2].sort());

      await expect(b.face.listSessions({ userId: "u1", projectId: "p_ghost" })).rejects.toThrow("PROJECT_NOT_FOUND");
    } finally {
      await cleanup(b.dir);
    }
  }, 60_000);

  it("会话读写路由到归属项目库（B 项目会话经默认项目不可见，经面可读）；未知会话 NOT_FOUND", async () => {
    const b = await boot();
    try {
      // B 项目的会话：face.messages 走归属解析（旧实现读默认库 → 空数据掩盖）
      const messagesB = (await b.face.messages(b.sessionB1)) as unknown as unknown[];
      expect(Array.isArray(messagesB)).toBe(true);
      // usage 能解析即证明归属路由正确（新会话 0 条消息是事实，不伪造）
      const usageB = (await b.face.usage(b.sessionB1)) as unknown as { messages: number };
      expect(typeof usageB.messages).toBe("number");

      // A 项目会话同样可读（不同库）
      const messagesA = (await b.face.messages(b.sessionA1)) as unknown as unknown[];
      expect(Array.isArray(messagesA)).toBe(true);

      // 未知会话：归属解析 NOT_FOUND（不是默认库的空结果）
      await expect(b.face.messages("ses_does_not_exist")).rejects.toThrow("会话不存在");
    } finally {
      await cleanup(b.dir);
    }
  }, 60_000);

  it("跨项目重复会话 id → CONFLICT 拒绝（不静默选第一个库）", async () => {
    const b = await boot();
    try {
      const dupId = "ses_dup_pc12";
      for (const projectId of ["p_a", "p_b"]) {
        await b.framework.createFrameworkSession({
          store: b.framework.createSqliteSessionStore({ dataDir: path.join(b.dir, "data", "projects", projectId) }),
          id: dupId,
          userId: "u1",
          workspaceId: "ws",
          model: { providerId: "openai", modelId: "m" },
        });
      }
      await expect(b.face.messages(dupId)).rejects.toThrow("多个项目存在相同会话 id");
      await expect(b.face.commandReceipt(dupId, "req_x")).rejects.toThrow("多个项目存在相同会话 id");
    } finally {
      await cleanup(b.dir);
    }
  }, 60_000);
});
