import { createRequire } from "node:module";
import { afterAll, beforeEach, expect, it, vi } from "vitest";

// Vite 的内置模块枚举不含 node:sqlite（与 lib/session-owner.test.ts 同一约定）。
// lib/runtime 现在经 ./attachments/scope 间接加载附件库（规格 2 §9.2），
// 不 mock 会在收集阶段就 "Failed to load url sqlite"。
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

const fixture = vi.hoisted(() => ({
  active: { id: "a", path: "/workspace/a" },
  create: vi.fn(), gitTools: vi.fn(), terminalTools: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("node:fs", () => ({ existsSync: () => true, mkdirSync: vi.fn(), watch: vi.fn() }));
vi.mock("@zmzai/agent-framework", () => ({
  createAgentRuntime: fixture.create,
  createSqliteSessionStore: () => ({}), createSqliteEventLog: () => ({}),
  createOpenAiModelProvider: () => ({ getModel: () => ({}) }),
  createGitTools: fixture.gitTools, createTerminalTools: fixture.terminalTools,
  createHostTerminalBackend: vi.fn(), TerminalManager: class {},
  createAttachmentTools: () => [],
  reclaimExpiredLeases: vi.fn(), listActiveSessions: () => [],
}));
vi.mock("./projects", () => ({
  DEFAULT_PROJECT: { id: "default" },
  getActiveProject: () => fixture.active,
  listProjects: () => [{ id: "a", path: "/workspace/a" }, { id: "b", path: "/workspace/b" }],
  dataDirFor: (p: { id: string }) => `/data/${p.id}`,
  projectStore: vi.fn(),
}));
vi.mock("./session-owner", () => ({ resolveSessionOwner: fixture.resolve, assertWorkspaceAvailable: vi.fn() }));
vi.mock("./worktree", () => ({ worktreeForSession: () => null }));
// 附件库要真开一个 SQLite 库文件，而本用例的 dataDir 是假的 `/data/a`。
// 这里测的是「工具根是否跟着活动项目定格」，与附件存储无关，直接替身即可。
vi.mock("./attachments/scope", () => ({ attachmentProviderFor: () => ({ read: async () => null }) }));
vi.mock("./settings", () => ({ authHeaders: () => ({}), ollamaBase: () => null, getFailoverEndpoints: () => [] }));
vi.mock("./relay", () => ({ relayBase: () => "https://relay.invalid" }));
vi.mock("./mcp-config", () => ({ loadMcpConfig: () => ({ entries: [], errors: [], sources: [] }) }));
vi.mock("./skills", () => ({ listSkills: () => [], loadSkill: vi.fn() }));
import { runtimeFor, sessionRuntime, workspaceRootForSession } from "./runtime";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.active = { id: "a", path: "/workspace/a" };
  fixture.create.mockImplementation((config) => ({ config }));
  fixture.gitTools.mockReturnValue([]);
  fixture.terminalTools.mockReturnValue([]);
  fixture.resolve.mockReturnValue({ project: { id: "a", path: "/workspace/a" }, effectiveWorkspaceRoot: "/workspace/a" });
  globalThis.__lecternRuntimes = new Map();
  globalThis.__lecternMcp = new Map();
  // Avoid launching the background lease poller in a unit test.
  globalThis.__lecternLeaseTimer ??= setInterval(() => {}, 60_000);
  globalThis.__lecternLeaseTimer.unref();
});

afterAll(() => {
  clearInterval(globalThis.__lecternLeaseTimer);
  globalThis.__lecternLeaseTimer = undefined;
  globalThis.__lecternLeaseTargets?.clear();
});

it("pins all tool roots when the active project changes during a background run", () => {
  runtimeFor("/workspace/a");
  fixture.active = { id: "b", path: "/workspace/b" };
  const config = fixture.create.mock.calls[0][0];
  expect(config.workspace.root).toBe("/workspace/a");
  expect(config.sandbox.workspaceRoot()).toBe("/workspace/a");
  expect(config.capabilities.repoMap.workspaceRoot()).toBe("/workspace/a");
  expect(fixture.gitTools.mock.calls[0][0].cwd()).toBe("/workspace/a");
  expect(fixture.terminalTools.mock.calls[0][1].workspaceRoot()).toBe("/workspace/a");
});

it("resolves an ordinary background session independently of the active project", () => {
  fixture.active = { id: "b", path: "/workspace/b" };
  sessionRuntime("session_a");
  expect(fixture.resolve).toHaveBeenCalledWith("session_a");
  expect(fixture.create.mock.calls[0][0].workspace.root).toBe("/workspace/a");
  expect(workspaceRootForSession("session_a")).toBe("/workspace/a");
});

it("never constructs a runtime for an unregistered project", () => {
  expect(() => runtimeFor("/unregistered")).toThrow();
  expect(fixture.create).not.toHaveBeenCalled();
});

it("only uses the active project when no session was supplied", () => {
  expect(workspaceRootForSession()).toBe("/workspace/a");
  expect(fixture.resolve).not.toHaveBeenCalled();
});
