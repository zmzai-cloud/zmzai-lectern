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
      const usageB = (await b.face.usage!(b.sessionB1)) as unknown as { messages: number };
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
      await expect(b.face.commandReceipt!(dupId, "req_x")).rejects.toThrow("多个项目存在相同会话 id");
    } finally {
      await cleanup(b.dir);
    }
  }, 60_000);

  it("prompt parity：首条 prompt 落占位标题（不叫「新会话」）；手动改名不被覆盖", async () => {
    // 2026-11-12 标题事故回归：armed 网关下 UI 的 prompt 全走 Host 面——
    // 自动标题逻辑若只在 Next 路由里（打包应用成死代码），侧栏会话永远停留
    // 「新会话」（用户实测 15 个会话全部无名）。AI 摘要标题②在本测试环境无
    // 凭据必然失败（保留占位），正好覆盖「生成失败不碰标题」分支。
    const b = await boot();
    try {
      const storeA = b.framework.createSqliteSessionStore({ dataDir: path.join(b.dir, "data", "projects", "p_a") });
      const s = await b.framework.createFrameworkSession({
        store: storeA as never,
        userId: "u1",
        workspaceId: "ws",
        model: { providerId: "openai", modelId: "m" },
      });
      expect((await storeA.getSession(s.id))?.title).toBe("新会话");

      await b.face.prompt!(s.id, { text: "帮我优化登录页的首屏加载性能", requestId: "t_title_0001" });
      expect((await storeA.getSession(s.id))?.title).toBe("帮我优化登录页的首屏加载性能");

      // 超长消息截断到 30 字
      const s2 = await b.framework.createFrameworkSession({
        store: storeA as never,
        userId: "u1",
        workspaceId: "ws",
        model: { providerId: "openai", modelId: "m" },
      });
      const long = "这是一个非常非常非常非常非常非常非常非常非常长的开头消息，后面还有内容".repeat(3);
      await b.face.prompt!(s2.id, { text: long, requestId: "t_title_0002" });
      expect((await storeA.getSession(s2.id))?.title).toHaveLength(30);
      expect((await storeA.getSession(s2.id))?.title).toBe(long.replace(/\s+/g, " ").slice(0, 30));

      // 手动改名后，后续消息不覆盖用户起的名（种子只在「新会话」/空标题时种下）
      await storeA.updateSession(s.id, { title: "用户手动起的名" });
      await b.face.prompt!(s.id, { text: "继续刚才的任务", requestId: "t_title_0003" });
      expect((await storeA.getSession(s.id))?.title).toBe("用户手动起的名");
    } finally {
      await cleanup(b.dir);
    }
  }, 120_000);
});
