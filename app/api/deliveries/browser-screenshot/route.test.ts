import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const rtFixture = vi.hoisted(() => ({ dir: "" }));
vi.mock("@/lib/runtime-constants", () => ({ get dataDir() { return rtFixture.dir; } }));
// withWorkflowErrors/rethrowWorkflowError 是直通包装（workflow-error.test 钉过），route 直接 import
const { GET } = await import("./route.js");

const base = mkdtempSync(path.join(tmpdir(), "v1-s6-"));
rtFixture.dir = path.join(base, "data");
mkdirSync(path.join(rtFixture.dir, "browser-screenshots"), { recursive: true });
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

function get(ref: string): Promise<Response> {
  return GET({ url: `http://localhost/api/deliveries/browser-screenshot?ref=${encodeURIComponent(ref)}` } as never);
}

describe("截图证据服务（V1-S6）", () => {
  it("合法 ref → 200 PNG；不存在 → 404；非 png → 400", async () => {
    writeFileSync(path.join(rtFixture.dir, "browser-screenshots", "shot-1.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const ok = await get("browser-screenshots/shot-1.png");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(existsSync(path.join(rtFixture.dir, "browser-screenshots", "shot-1.png"))).toBe(true);

    expect((await get("browser-screenshots/nope.png")).status).toBe(404);
    expect((await get("browser-screenshots/evil.txt")).status).toBe(400);
  });

  it("目录穿越/绝对路径/其它目录 → 400（证据引用不可越出 browser-screenshots/）", async () => {
    expect((await get("browser-screenshots/../../etc/passwd.png")).status).toBe(400);
    expect((await get("/etc/passwd.png")).status).toBe(400);
    expect((await get("deliveries/deliveries.db.png")).status).toBe(400);
    expect((await get("")).status).toBe(400);
  });
});
