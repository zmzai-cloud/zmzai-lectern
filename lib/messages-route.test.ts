import { beforeEach, expect, it, vi } from "vitest";
const store = { getMessages: vi.fn() };
vi.mock("@/lib/runtime", () => ({ sessionRuntime: () => ({ store }) }));
import { GET } from "../app/api/sessions/[id]/messages/route";
import { NextRequest } from "next/server";

const request = (query: string) => GET(new NextRequest(`http://localhost/api/sessions/a/messages${query}`), { params: Promise.resolve({ id: "a" }) });
beforeEach(() => store.getMessages.mockResolvedValue(Array.from({ length: 5 }, (_, i) => ({ id: String(i) }))));
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
