import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ get: vi.fn(), mark: vi.fn(), runtime: vi.fn() }));
vi.mock("@/lib/runtime", () => ({ sessionRuntime: mocks.runtime }));
import { GET, PUT } from "../app/api/sessions/[id]/read-state/route.js";
import { WorkflowError } from "./workflow-error.js";
const state = { lastReadMessageSeq: 2, latestMessageSeq: 3, unreadCount: 1, historyRevision: 1 };
const ctx = { params: Promise.resolve({ id: "a" }) };
const request = (body: unknown) => new NextRequest("http://localhost/api/sessions/a/read-state", { method: "PUT", body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.runtime.mockReturnValue({ store: { getReadState: mocks.get, markRead: mocks.mark } });
  mocks.get.mockResolvedValue(state); mocks.mark.mockResolvedValue(state);
});
it("reads and writes through the owning session store", async () => {
  expect(await (await GET(new NextRequest("http://localhost"), ctx)).json()).toEqual(state);
  expect(await (await PUT(request({ lastReadMessageSeq: 2, historyRevision: 1 }), ctx)).json()).toEqual(state);
  expect(mocks.runtime).toHaveBeenCalledWith("a");
  expect(mocks.mark).toHaveBeenCalledWith("a", 2, 1);
});
it("rejects invalid cursors before touching read state", async () => {
  for (const body of [null, {}, { lastReadMessageSeq: -1, historyRevision: 1 }, { lastReadMessageSeq: 1.5, historyRevision: 1 }, { lastReadMessageSeq: 2 }]) expect((await PUT(request(body), ctx)).status).toBe(422);
  expect(mocks.mark).not.toHaveBeenCalled();
});
it("rejects stale histories and future sequences", async () => {
  mocks.mark.mockRejectedValueOnce(new Error("HISTORY_REVISION_CONFLICT")).mockRejectedValueOnce(new Error("INVALID_READ_SEQUENCE"));
  expect((await PUT(request({ lastReadMessageSeq: 2, historyRevision: 1 }), ctx)).status).toBe(409);
  expect((await PUT(request({ lastReadMessageSeq: 99, historyRevision: 1 }), ctx)).status).toBe(422);
});
it("does not open a substitute store for missing sessions", async () => {
  mocks.runtime.mockImplementation(() => { throw new WorkflowError("NOT_FOUND", "missing", 404); });
  expect((await PUT(request({ lastReadMessageSeq: 2, historyRevision: 1 }), ctx)).status).toBe(404);
  expect(mocks.mark).not.toHaveBeenCalled();
});
