import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ search: vi.fn(), owner: vi.fn() }));
vi.mock("@/lib/runtime", () => ({ sessionRuntime: () => ({ store: { searchMessages: mocks.search } }) }));
vi.mock("@/lib/session-owner", () => ({ resolveSessionOwner: mocks.owner }));
import { GET } from "../app/api/sessions/[id]/search/route";
import { WorkflowError } from "./workflow-error";

const request = (query = "q=needle") => GET(new NextRequest(`http://localhost/api/sessions/a/search?${query}`), { params: Promise.resolve({ id: "a" }) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.owner.mockReturnValue({ project: { id: "project-a" } });
  mocks.search.mockResolvedValue({ results: [{ sessionId: "a", messageId: "m", partId: "p", kind: "text", messageSeq: 10, snippet: "needle", match: { start: 0, length: 6 } }], revision: 2, hasMore: true });
});
it("returns ownership and a cursor tied to query, session and revision", async () => {
  const body = await (await request()).json();
  expect(body.results[0].projectId).toBe("project-a");
  expect(JSON.parse(Buffer.from(body.nextCursor, "base64url").toString())).toEqual({ sessionId: "a", query: "needle", revision: 2, messageSeq: 10, partId: "p" });
  await request(`q=needle&cursor=${body.nextCursor}`);
  expect(mocks.search).toHaveBeenLastCalledWith("a", { query: "needle", limit: 30, after: { messageSeq: 10, partId: "p" }, revision: 2 });
  expect((await request(`q=changed&cursor=${body.nextCursor}`)).status).toBe(422);
});
it("validates query and page sizes, and skips empty queries", async () => {
  expect((await (await request("q=")).json()).results).toEqual([]);
  expect(mocks.search).not.toHaveBeenCalled();
  for (const query of ["q=x&limit=0", "q=x&limit=101", "q=x&limit=1.5", `q=${"x".repeat(201)}`, "q=x&cursor=bad"]) expect((await request(query)).status).toBe(422);
});
it("does not search an unknown session", async () => {
  mocks.owner.mockImplementation(() => { throw new WorkflowError("NOT_FOUND", "missing", 404); });
  expect((await request()).status).toBe(404);
  expect(mocks.search).not.toHaveBeenCalled();
});
it("reports rewind conflicts without advancing the search page", async () => {
  mocks.search.mockRejectedValue(new Error("HISTORY_REVISION_CONFLICT"));
  expect((await request()).status).toBe(409);
});
