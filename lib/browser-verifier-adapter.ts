/** W1 后 V1-S3：浏览器驱动 adapter 的 Host 侧通道（V1 设计 §1.2）。
 *
 *  形态：Electron 主进程起 verifier HTTP endpoint（electron/verifier.cjs，
 *  随机端口+32B token，bootstrap 文件 hostDataDir/verifier.json——host.json
 *  同款模式）；Main fork Host 时注入 env LECTERN_VERIFIER_BOOTSTRAP 指向该
 *  文件。本模块**惰性**读 bootstrap：每次创建 adapter 时现读文件（Main 起晚
 *  于 Host 首次验证请求也不炸，读不到 → null → run 如实 unavailable，R-1）。
 *
 *  dev/web（无 Electron）→ env 未设 → verifierFromEnv() 返回 null，
 *  startBrowserVerificationRun 无 verifier → unavailable（不算通过）。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { dataDir } from "./runtime-constants.js";
import type { BrowserVerifierAdapter, VerificationStep, VerifierStepResult } from "./browser-verification.js";

export type VerifierBootstrap = { port: number; token: string };

/** 读 bootstrap 文件（不存在/坏 JSON → null，不抛）。 */
export function readVerifierBootstrap(envBootstrap?: string): VerifierBootstrap | null {
  const p = envBootstrap ?? process.env.LECTERN_VERIFIER_BOOTSTRAP;
  if (!p) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as VerifierBootstrap;
    return typeof parsed.port === "number" && typeof parsed.token === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** 截图落盘（<dataDir>/browser-screenshots/），返回相对 dataDir 的引用路径。 */
function saveScreenshot(runTag: string, pngBase64: string): string | null {
  try {
    const dir = join(resolve(dataDir), "browser-screenshots");
    mkdirSync(dir, { recursive: true });
    const rel = `browser-screenshots/${runTag}-${Date.now().toString(36)}.png`;
    writeFileSync(join(resolve(dataDir), rel), Buffer.from(pngBase64, "base64"));
    return rel;
  } catch {
    return null;
  }
}

type VerifyHttpResponse = { status: number; body: Record<string, unknown> };

async function verifyHttp(boot: VerifierBootstrap, path: string, body: Record<string, unknown>, timeoutMs = 60_000): Promise<VerifyHttpResponse> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${boot.port}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${boot.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body: parsed };
  } catch (error) {
    return { status: 0, body: { error: error instanceof Error ? error.name : String(error) } };
  } finally {
    clearTimeout(timer);
  }
}

/** 从 env bootstrap 建 adapter；不可用（无 Electron/文件缺失/服务未起）→ null。
 *  每次调用现读 bootstrap 文件——Main 后起/重启换端口都能跟上（R-1 时序）。 */
export function verifierFromEnv(): BrowserVerifierAdapter | null {
  const boot = readVerifierBootstrap();
  if (!boot) return null;
  const baseUrl = { port: boot.port, token: boot.token };
  return {
    openContext: async ({ contextKey, viewport }) => {
      const r = await verifyHttp(baseUrl, "/context/open", { contextKey, viewport });
      if (r.status === 200 && typeof r.body.browserContextId === "string") {
        return { ok: true, browserContextId: r.body.browserContextId };
      }
      return { ok: false, reason: String(r.body.reason ?? r.body.error ?? `http-${r.status}`) };
    },
    runStep: async ({ browserContextId, step, serviceOrigin }) => {
      const r = await verifyHttp(baseUrl, "/step", {
        browserContextId, serviceOrigin, step: step satisfies VerificationStep,
      });
      if (r.status !== 200) {
        const result: VerifierStepResult = { status: "unavailable", detail: `verifier 通道错误 http-${r.status}: ${String(r.body.error ?? "")}`.slice(0, 200) };
        return result;
      }
      const status = r.body.status === "passed" || r.body.status === "failed" ? r.body.status : "unavailable";
      return {
        status,
        ...(typeof r.body.detail === "string" ? { detail: r.body.detail } : {}),
        ...(typeof r.body.consoleErrors === "number" ? { consoleErrors: r.body.consoleErrors } : {}),
      };
    },
    captureScreenshot: async (browserContextId) => {
      const r = await verifyHttp(baseUrl, "/screenshot", { browserContextId }, 30_000);
      if (r.status === 200 && typeof r.body.pngBase64 === "string") {
        const ref = saveScreenshot(`ctx-${browserContextId.slice(-8)}`, r.body.pngBase64);
        return ref ? { artifactRef: ref } : { failed: "save-failed" };
      }
      return { failed: `http-${r.status}: ${String(r.body.error ?? "")}`.slice(0, 120) };
    },
    closeContext: async (browserContextId) => {
      await verifyHttp(baseUrl, "/context/close", { browserContextId }, 15_000);
    },
  };
}

/** 生成 bootstrap 内容（Electron 侧与测试假 server 共用的 token 形状）。 */
export function newVerifierBootstrap(port: number): VerifierBootstrap {
  return { port, token: randomBytes(32).toString("hex") };
}
