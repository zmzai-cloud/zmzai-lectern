import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const rtFixture = vi.hoisted(() => ({ dir: "" }));
vi.mock("./runtime-constants", () => ({ get dataDir() { return rtFixture.dir; } }));
import { verifierFromEnv, readVerifierBootstrap, newVerifierBootstrap } from "./browser-verifier-adapter.js";

const base = mkdtempSync(path.join(tmpdir(), "v1-s3-"));
rtFixture.dir = path.join(base, "data");
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

/** 真 HTTP 假 verifier（实现 S3 协议；记录收到的请求供断言）。 */
function fakeVerifier(opts: { token: string; stepStatus?: "passed" | "failed" }): Promise<{
  origin: string; port: number; received: { url: string; auth?: string; body: Record<string, unknown> }[]; close(): Promise<void>;
}> {
  return new Promise((resolve) => {
    const received: { url: string; auth?: string; body: Record<string, unknown> }[] = [];
    const png = Buffer.from("89504e470d0a1a0a", "hex"); // PNG magic（假图，协议透传即可）
    const server: Server = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      received.push({ url: req.url ?? "", auth: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${opts.token}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/context/open") res.end(JSON.stringify({ browserContextId: "bctx_fake" }));
      else if (req.url === "/step") res.end(JSON.stringify({ status: opts.stepStatus ?? "passed", detail: "ok", consoleErrors: 1 }));
      else if (req.url === "/screenshot") res.end(JSON.stringify({ pngBase64: png.toString("base64") }));
      else if (req.url === "/context/close") res.end(JSON.stringify({ ok: true }));
      else { res.writeHead(404); res.end("{}"); }
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ origin: `http://127.0.0.1:${port}`, port, received, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

describe("verifier adapter Host 侧通道（V1-S3）", () => {
  const prevEnv = process.env.LECTERN_VERIFIER_BOOTSTRAP;
  afterAll(() => {
    if (prevEnv === undefined) delete process.env.LECTERN_VERIFIER_BOOTSTRAP;
    else process.env.LECTERN_VERIFIER_BOOTSTRAP = prevEnv;
  });

  it("env 未设 / 文件缺失 / 坏 JSON → null（dev/web 模式如实无 verifier）", () => {
    delete process.env.LECTERN_VERIFIER_BOOTSTRAP;
    expect(verifierFromEnv()).toBeNull();
    process.env.LECTERN_VERIFIER_BOOTSTRAP = path.join(base, "nope.json");
    expect(verifierFromEnv()).toBeNull();
    const bad = path.join(base, "bad.json");
    writeFileSync(bad, "{not-json");
    process.env.LECTERN_VERIFIER_BOOTSTRAP = bad;
    expect(verifierFromEnv()).toBeNull();
    expect(readVerifierBootstrap(bad)).toBeNull();
  });

  it("全链路：bootstrap → token 鉴权 → 四操作转发 → 截图落盘为 PNG", async () => {
    const boot = newVerifierBootstrap(0);
    const fake = await fakeVerifier({ token: boot.token });
    try {
      const bootstrapFile = path.join(base, "verifier.json");
      writeFileSync(bootstrapFile, JSON.stringify({ port: fake.port, token: boot.token }));
      process.env.LECTERN_VERIFIER_BOOTSTRAP = bootstrapFile;

      const adapter = verifierFromEnv();
      expect(adapter).not.toBeNull();
      if (!adapter) return;

      const opened = await adapter.openContext({ contextKey: "att_x", viewport: { width: 375, height: 812 } });
      expect(opened).toMatchObject({ ok: true, browserContextId: "bctx_fake" });
      expect(fake.received[0]).toMatchObject({ url: "/context/open", auth: `Bearer ${boot.token}` });
      expect(fake.received[0]?.body).toMatchObject({ contextKey: "att_x", viewport: { width: 375, height: 812 } });

      const step = await adapter.runStep({ browserContextId: "bctx_fake", step: { kind: "assert_dom", target: "#t", value: "v", requirement: "required" }, serviceOrigin: "http://127.0.0.1:45001" });
      expect(step).toMatchObject({ status: "passed", consoleErrors: 1 });
      expect(fake.received[1]?.body).toMatchObject({ browserContextId: "bctx_fake", serviceOrigin: "http://127.0.0.1:45001" });

      const shot = await adapter.captureScreenshot("bctx_fake");
      expect(shot.artifactRef).toBeTruthy();
      if (shot.artifactRef) {
        const pngPath = path.join(rtFixture.dir, shot.artifactRef);
        expect(existsSync(pngPath)).toBe(true);
        expect(readFileSync(pngPath).subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))).toBe(true); // PNG magic
      }

      await adapter.closeContext("bctx_fake");
      expect(fake.received.at(-1)?.url).toBe("/context/close");
    } finally {
      await fake.close();
    }
  });

  it("token 不符 → 401：openContext 失败 / step unavailable（不伪报通过）", async () => {
    const fake = await fakeVerifier({ token: "right-token" });
    try {
      const bootstrapFile = path.join(base, "verifier-wrong.json");
      writeFileSync(bootstrapFile, JSON.stringify({ port: fake.port, token: "wrong-token" }));
      process.env.LECTERN_VERIFIER_BOOTSTRAP = bootstrapFile;
      const adapter = verifierFromEnv();
      expect(adapter).not.toBeNull();
      if (!adapter) return;
      const opened = await adapter.openContext({ contextKey: "k", viewport: { width: 1, height: 1 } });
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.reason).toContain("unauthorized");
      const step = await adapter.runStep({ browserContextId: "x", step: { kind: "goto", target: "/", requirement: "required" } });
      expect(step.status).toBe("unavailable");
      expect(step.detail).toContain("401");
    } finally {
      await fake.close();
    }
  });
});
