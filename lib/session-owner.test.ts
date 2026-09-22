import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Vite's builtin enumeration omits node:sqlite on some Node versions.
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const state = vi.hoisted(() => ({ projects: [] as Array<{ id: string; path: string }>, data: "", worktree: vi.fn() }));
vi.mock("./projects", () => ({
  registeredProjects: () => state.projects,
  dataDirFor: (p: { id: string }) => join(state.data, p.id),
}));
vi.mock("./worktree", () => ({ worktreeForSession: state.worktree }));
import { resolveSessionOwner } from "./session-owner.js";
import { WorkflowError, withWorkflowErrors } from "./workflow-error.js";
import { NextRequest } from "next/server";
const api = vi.hoisted(() => ({ abort: vi.fn(), start: vi.fn() }));
vi.mock("@/lib/runtime", () => ({
  sessionRuntime: (id: string) => {
    const owner = resolveSessionOwner(id);
    return {
      store: { getMessages: async () => [{ projectId: owner.project.id }] },
      runner: { abort: async () => api.abort(owner.project.id, id) },
    };
  },
  workspaceRootForSession: (id?: string | null) => id == null ? state.projects[0].path : resolveSessionOwner(id).effectiveWorkspaceRoot,
  activeWorkspaceRoot: () => state.projects[0].path,
  terminalManager: () => ({ start: api.start }),
}));
import { GET as messages } from "../app/api/sessions/[id]/messages/route.js";
import { POST as abort } from "../app/api/sessions/[id]/abort/route.js";
import { GET as readFile, PUT as saveFile } from "../app/api/fs/file/route.js";
import { GET as checkpoints } from "../app/api/git/checkpoint/route.js";
import { POST as startTerminal } from "../app/api/terminal/route.js";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
let dir: string;

function database(projectId: string, sessionIds: string[]) {
  const root = join(state.data, projectId);
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(join(root, "zmzai.db"));
  db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)");
  for (const id of sessionIds) db.prepare("INSERT INTO sessions (id) VALUES (?)").run(id);
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lectern-owner-"));
  state.data = join(dir, "data");
  state.projects = ["a", "b"].map(id => ({ id, path: join(dir, id) }));
  for (const p of state.projects) mkdirSync(p.path);
  state.worktree.mockReset().mockReturnValue(null);
  api.abort.mockReset();
  api.start.mockReset().mockImplementation(async (input) => ({ id: "terminal_test", ...input }));
  database("a", ["session_a"]);
  database("b", ["session_b"]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("resolves each ordinary session using its persisted database", () => {
  expect(resolveSessionOwner("session_a").project.id).toBe("a");
  expect(resolveSessionOwner("session_b").effectiveWorkspaceRoot).toBe(join(dir, "b"));
  state.projects.reverse();
  expect(resolveSessionOwner("session_a").project.id).toBe("a");
});

it("does not create a database for a project with no stored sessions", () => {
  state.projects.push({ id: "empty", path: join(dir, "empty") });
  expect(() => resolveSessionOwner("unknown")).toThrowError(expect.objectContaining({ status: 404 }));
  expect(existsSync(join(state.data, "empty"))).toBe(false);
});

it.each(["", "../a", "a/b", "a\\b", "a\0", "a".repeat(256)])("rejects invalid session ID %j", id => {
  expect(() => resolveSessionOwner(id)).toThrowError(expect.objectContaining({ status: 422 }));
});

it("rejects ambiguous duplicate session IDs rather than choosing the first project", () => {
  database("b", ["session_a"]);
  expect(() => resolveSessionOwner("session_a")).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
});

it("fails closed when an ownership database cannot be read", () => {
  writeFileSync(join(state.data, "b", "zmzai.db"), "corrupt");
  expect(() => resolveSessionOwner("session_a")).toThrowError(expect.objectContaining({ status: 503 }));
});

it("never recreates a missing project directory", () => {
  rmSync(join(dir, "b"), { recursive: true });
  expect(() => resolveSessionOwner("session_b")).toThrowError(expect.objectContaining({ code: "RECOVERY_REQUIRED" }));
  expect(existsSync(join(dir, "b"))).toBe(false);
});

it("resolves an isolated worktree only inside its owning project's container", () => {
  const root = join(dir, "a");
  const path = join(root, ".lectern-worktrees", "session_a");
  mkdirSync(path, { recursive: true });
  state.worktree.mockReturnValue({ projectPath: root, path });
  expect(resolveSessionOwner("session_a").effectiveWorkspaceRoot).toBe(path);
});

it("rejects mismatched worktree ownership", () => {
  state.worktree.mockReturnValue({ projectPath: join(dir, "b"), path: join(dir, "b") });
  expect(() => resolveSessionOwner("session_a")).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
});

it("does not fall back or recreate a lost worktree", () => {
  const path = join(dir, "a", ".lectern-worktrees", "session_a");
  state.worktree.mockReturnValue({ projectPath: join(dir, "a"), path });
  expect(() => resolveSessionOwner("session_a")).toThrowError(expect.objectContaining({ code: "RECOVERY_REQUIRED" }));
  expect(existsSync(path)).toBe(false);
});

it("rejects a worktree symlink redirected into another project", () => {
  const root = join(dir, "a");
  const path = join(root, ".lectern-worktrees", "session_a");
  mkdirSync(join(root, ".lectern-worktrees"));
  symlinkSync(join(dir, "b"), path, "junction");
  state.worktree.mockReturnValue({ projectPath: root, path });
  expect(() => resolveSessionOwner("session_a")).toThrowError(expect.objectContaining({ code: "RECOVERY_REQUIRED" }));
});

it("does not swallow an unreadable worktree mapping", () => {
  state.worktree.mockImplementation(() => { throw new WorkflowError("RESOURCE_UNAVAILABLE", "映射不可读取", 503); });
  expect(() => resolveSessionOwner("session_a")).toThrowError(expect.objectContaining({ status: 503 }));
});

it("preserves the legacy error string and returns a typed 404 with a diagnostic ID", async () => {
  const response = await withWorkflowErrors(async () => Response.json(resolveSessionOwner("unknown")))();
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: "会话不存在", detail: { code: "NOT_FOUND", retryable: false, requestId: expect.any(String) } });
});

it("does not hide unexpected programming errors behind a domain response", async () => {
  const fail = withWorkflowErrors(async () => { throw new Error("bug"); });
  await expect(fail()).rejects.toThrow("bug");
});

const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (path: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost${path}`, {
  method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

it("serves the background session's messages and stops only its runner", async () => {
  const response = await messages(request("/api/sessions/session_b/messages"), context("session_b"));
  expect(await response.json()).toEqual([{ projectId: "b" }]);
  expect((await abort(request("/api/sessions/session_b/abort", "POST"), context("session_b"))).status).toBe(200);
  expect(api.abort).toHaveBeenCalledTimes(1);
  expect(api.abort).toHaveBeenCalledWith("b", "session_b");
});

it("returns a typed 404 for unknown session read and abort without executing", async () => {
  for (const response of [
    await messages(request("/api/sessions/unknown/messages"), context("unknown")),
    await abort(request("/api/sessions/unknown/abort", "POST"), context("unknown")),
  ]) {
    expect(response.status).toBe(404);
    expect((await response.json()).detail.code).toBe("NOT_FOUND");
  }
  expect(api.abort).not.toHaveBeenCalled();
});

it("reads and writes the session's project even while another project is active", async () => {
  writeFileSync(join(dir, "a", "note.txt"), "project A");
  writeFileSync(join(dir, "b", "note.txt"), "project B");
  const read = await readFile(request("/api/fs/file?sessionId=session_b&path=note.txt"));
  expect((await read.json()).content).toBe("project B");
  const saved = await saveFile(request("/api/fs/file", "PUT", { sessionId: "session_b", path: "note.txt", content: "B changed" }));
  expect(saved.status).toBe(200);
  expect((await (await readFile(request("/api/fs/file?sessionId=session_a&path=note.txt"))).json()).content).toBe("project A");
});

it("does not write to the active project for an unknown session", async () => {
  const response = await saveFile(request("/api/fs/file", "PUT", { sessionId: "unknown", path: "not-created.txt", content: "bad" }));
  expect(response.status).toBe(404);
  expect((await response.json()).detail.code).toBe("NOT_FOUND");
  expect(existsSync(join(dir, "a", "not-created.txt"))).toBe(false);
});

it("does not turn invalid checkpoint ownership into an empty successful list", async () => {
  const response = await checkpoints(request("/api/git/checkpoint?sessionId=unknown"));
  expect(response.status).toBe(404);
});

it("starts a terminal at the background task root, rejecting unknown tasks before spawn", async () => {
  const response = await startTerminal(request("/api/terminal", "POST", { sessionId: "session_b", command: "echo test" }));
  expect(response.status).toBe(200);
  expect(api.start.mock.calls[0][0].cwd).toBe(join(dir, "b"));
  api.start.mockClear();
  const unknown = await startTerminal(request("/api/terminal", "POST", { sessionId: "unknown", command: "echo test" }));
  expect(unknown.status).toBe(404);
  expect(api.start).not.toHaveBeenCalled();
});
