import { beforeEach, expect, it, vi } from "vitest";
const store = { getMessages: vi.fn(), getMessageSnapshot: vi.fn() };
vi.mock("@/lib/runtime", () => ({ sessionRuntime: () => ({ store }) }));
vi.mock("@/lib/session-owner", () => ({ resolveSessionOwner: () => ({ project: { id: "project-a" } }) }));
import { GET } from "../app/api/sessions/[id]/messages/route";
import { NextRequest } from "next/server";

const request = (query: string) => GET(new NextRequest(`http://localhost/api/sessions/a/messages${query}`), { params: Promise.resolve({ id: "a" }) });
beforeEach(() => {
  store.getMessages.mockResolvedValue(Array.from({ length: 5 }, (_, i) => ({ id: String(i) })));
  store.getMessageSnapshot.mockReset();
});
it("returns the newest page and reports earlier history", async () => {
  const body = await (await request("?tail=2")).json();
  expect(body.messages.map((m: { id: string }) => m.id)).toEqual(["3", "4"]);
  expect(body.total).toBe(5);
  expect(body.hasMore).toBe(true);
});
it("uses skip to page backwards without overlap", async () => {
  const body = await (await request("?tail=2&skip=2")).json();
  expect(body.messages.map((m: { id: string }) => m.id)).toEqual(["1", "2"]);
  expect(body.hasMore).toBe(true);
});
it("caps pathological page sizes and reports the oldest page", async () => {
  store.getMessages.mockResolvedValue(Array.from({ length: 250 }, (_, i) => ({ id: String(i) })));
  const body = await (await request("?tail=999&skip=100")).json();
  expect(body.messages).toHaveLength(150);
  expect(body.messages[0].id).toBe("0");
  expect(body.hasMore).toBe(false);
});
it("returns a stable message window with snapshot watermark", async () => {
  store.getMessageSnapshot.mockResolvedValue({
    messages: [{ info: { id: "m2" },parts: [],messageSeq: 2 }],
    revision: 3,snapshotSeq: 9,hasMore: true,nextBefore: 2,nextAfter: null,hasMoreAfter: false,stateEvents: [],runs: [],
  });
  const response = await request("?view=window&limit=1");
  const body = await response.json();
  expect(body).toMatchObject({ projectId: "project-a",sessionId: "a",historyRevision: 3,snapshotSeq: 9,hasMoreBefore: true });
  const decoded = JSON.parse(Buffer.from(body.beforeCursor,"base64url").toString("utf8"));
  expect(decoded).toEqual({ sessionId: "a",messageSeq: 2,historyRevision: 3 });
});
it("rejects a cursor belonging to another session", async () => {
  const cursor = Buffer.from(JSON.stringify({ sessionId: "b",messageSeq: 2,historyRevision: 1 })).toString("base64url");
  const response = await request(`?view=window&limit=10&before=${cursor}`);
  expect(response.status).toBe(422);
});
it("locates historical messages and accepts forward cursors", async () => {
  store.getMessageSnapshot.mockResolvedValue({ messages: [],revision: 3,snapshotSeq: 9,hasMore: false,nextBefore: null,nextAfter: 25,hasMoreAfter: true,stateEvents: [],runs: [] });
  const body = await (await request("?view=window&around=message-1")).json();
  expect(store.getMessageSnapshot).toHaveBeenLastCalledWith("a", expect.objectContaining({ around: "message-1" }));
  await request(`?view=window&after=${body.afterCursor}`);
  expect(store.getMessageSnapshot).toHaveBeenLastCalledWith("a", expect.objectContaining({ after: 25, revision: 3, before: undefined }));
  expect((await request(`?view=window&around=message-1&after=${body.afterCursor}`)).status).toBe(422);
});
it("reports a deleted search target", async () => {
  store.getMessageSnapshot.mockRejectedValue(new Error("MESSAGE_NOT_FOUND"));
  expect((await request("?view=window&around=removed")).status).toBe(404);
});
