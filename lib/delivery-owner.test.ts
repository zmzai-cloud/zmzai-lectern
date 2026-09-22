import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const fixture = vi.hoisted(() => ({ dir: "", owner: vi.fn() }));
vi.mock("./runtime-constants", () => ({ get dataDir() { return fixture.dir; } }));
vi.mock("./session-owner", () => ({ resolveSessionOwner: fixture.owner }));
vi.mock("./worktree", () => ({ worktreeForSession: () => null }));
import { beginAttempt, getOrCreateDelivery, resolveOwner } from "./delivery.js";

fixture.dir = mkdtempSync(join(tmpdir(), "lectern-delivery-owner-"));
fixture.owner.mockImplementation((sessionId: string) => ({
  sessionId, project: { id: "a", path: "/workspace/a" }, effectiveWorkspaceRoot: "/workspace/a",
}));
// DatabaseSync stays open for the module lifetime; removing an open SQLite file
// is not portable on Windows. Keep this small fixture for diagnostic inspection.

it("resolves an existing correctly-owned delivery", () => {
  getOrCreateDelivery({ sessionId: "correct", projectId: "a", effectiveWorkspaceRoot: "/workspace/a" });
  expect(resolveOwner("correct")).toMatchObject({ projectId: "a", effectiveWorkspaceRoot: "/workspace/a" });
});

it("rejects a legacy delivery captured under the wrong active project", () => {
  getOrCreateDelivery({ sessionId: "wrong", projectId: "b", effectiveWorkspaceRoot: "/workspace/b" });
  expect(() => resolveOwner("wrong")).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
});

it("rejects a mismatched active attempt even when the container is correct", () => {
  getOrCreateDelivery({ sessionId: "bad_attempt", projectId: "a", effectiveWorkspaceRoot: "/workspace/a" });
  beginAttempt({ sessionId: "bad_attempt", projectId: "b", effectiveWorkspaceRoot: "/workspace/b" }, "run_test");
  expect(() => resolveOwner("bad_attempt")).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
});
