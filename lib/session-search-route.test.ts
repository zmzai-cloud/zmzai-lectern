import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ projects: vi.fn(), open: vi.fn(), activeStore: { listSessions: vi.fn(), getMessages: vi.fn() } }));
vi.mock("@/lib/runtime", () => ({ cloudRuntime: () => ({ store: mocks.activeStore }) }));
vi.mock("@/lib/projects", () => ({ getActiveProject: () => ({ id: "a" }), listProjects: mocks.projects, projectStore: mocks.open }));
import { GET } from "../app/api/sessions/search/route.js";

const sessions = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, title: `${prefix}${i}`, time: {} }));
const messages = async () => [{ parts: [{ type: "text", text: "Needle in transcript" }] }];
const search = async (q = "needle") => (await GET(new NextRequest(`http://localhost/api/sessions/search?q=${q}`))).json();
beforeEach(() => {
  vi.resetAllMocks();
  mocks.projects.mockReturnValue([{ id: "a" }, { id: "b" }]);
  mocks.activeStore.listSessions.mockResolvedValue(sessions("a", 1));
  mocks.activeStore.getMessages.mockImplementation(messages);
  mocks.open.mockReturnValue({ listSessions: async () => sessions("b", 1), getMessages: messages });
});
it("searches active and other project transcripts", async () => {
  expect((await search()).results.map((r: { sessionId: string }) => r.sessionId)).toEqual(["a0", "b0"]);
});
it("searches completed tool summaries as well as text", async () => {
  mocks.activeStore.getMessages.mockResolvedValue([{ parts: [{ type: "tool", tool: "git_status", state: { status: "completed", title: "working tree" } }] }]);
  expect((await search("git_status")).results[0].sessionId).toBe("a0");
});
it("enforces the global limit without opening more project databases", async () => {
  mocks.activeStore.listSessions.mockResolvedValue(sessions("a", 35));
  expect((await search()).results).toHaveLength(30);
  expect(mocks.open).not.toHaveBeenCalled();
});
it("preserves healthy results when another database cannot open", async () => {
  mocks.open.mockImplementation(() => { throw new Error("unavailable database"); });
  expect((await search()).results).toHaveLength(1);
});
it("preserves healthy results when a project listing rejects", async () => {
  mocks.open.mockReturnValue({ listSessions: async () => { throw new Error("corrupt database"); } });
  expect((await search()).results).toHaveLength(1);
});
it("empty queries do not open project databases", async () => {
  expect((await search("")).results).toEqual([]);
  expect(mocks.projects).not.toHaveBeenCalled();
});
