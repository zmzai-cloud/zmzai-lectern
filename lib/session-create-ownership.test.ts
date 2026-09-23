import { createRequire } from "node:module";
import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

const state = vi.hoisted(() => ({
  active: { id: "a", name: "A", path: "/workspace/a" },
  resolve: vi.fn(), create: vi.fn(), createWorkspace: vi.fn(), existingWorktree: vi.fn(), getSession: vi.fn(), runtimeFor: vi.fn(),
}));
vi.mock("@/lib/projects", () => ({ getActiveProject: () => state.active }));
vi.mock("@/lib/relay", () => ({ resolveModel: state.resolve, sessionCookieName: "test_session" }));
vi.mock("@/lib/runtime", () => ({ runtimeFor: state.runtimeFor }));
vi.mock("@/lib/worktree", () => ({ worktreeForSession: state.existingWorktree }));
// W1-S27 起 sessions route 的 isolate 走 WorkspaceService（旧 createWorktree 不再被调用）
vi.mock("@/lib/workspace-service", () => ({ createWorkspace: state.createWorkspace }));
vi.mock("@/lib/runtime-constants", () => ({ get dataDir() { return "/tmp/lectern-test-data"; } }));
vi.mock("@zmzai/agent-framework", () => ({}));
import { POST } from "../app/api/sessions/route.js";

beforeEach(() => {
  vi.resetAllMocks();
  state.active = { id: "a", name: "A", path: "/workspace/a" };
  state.getSession.mockResolvedValue(null);
  state.existingWorktree.mockReturnValue(null);
  state.runtimeFor.mockReturnValue({ createSession: state.create,store: { getSession: state.getSession } });
  state.create.mockResolvedValue({ id: "created_session" });
  state.createWorkspace.mockResolvedValue({
    ok: true, record: { path: "/workspace/a/.lectern-worktrees/created_session", branch: "lectern/wt/created_session" },
  });
});

it("pins the project through model resolution and isolated worktree creation", async () => {
  state.resolve.mockImplementation(async () => {
    state.active = { id: "b", name: "B", path: "/workspace/b" };
    return { providerId: "test", modelId: "test" };
  });
  const response = await POST(new NextRequest("http://localhost/api/sessions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ isolate: true }),
  }));
  expect(response.status).toBe(200);
  expect(state.runtimeFor).toHaveBeenCalledTimes(1);
  expect(state.runtimeFor).toHaveBeenCalledWith("/workspace/a");
  expect(state.createWorkspace).toHaveBeenCalledTimes(1);
  expect(state.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({
    projectId: "a", projectPath: "/workspace/a", sessionId: "created_session",
  }));
  expect(await response.json()).toMatchObject({ projectId: "a", projectName: "A", isolation: { enabled: true } });
});

it("does not change projects while the request body is being read", async () => {
  const request = new NextRequest("http://localhost/api/sessions", { method: "POST" });
  vi.spyOn(request, "json").mockImplementation(async () => {
    state.active = { id: "b", name: "B", path: "/workspace/b" };
    return { isolate: true, model: { providerId: "test", modelId: "test" } };
  });
  expect((await POST(request)).status).toBe(200);
  expect(state.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ projectPath: "/workspace/a" }));
});
