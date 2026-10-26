/**
 * memory.zmzai.cloud 的最小 API 客户端（K1）。
 *
 * 鉴权：PAT Bearer（settings 惰性现读——verifier 模式，接通/换签即时生效）。
 * 结果形状：所有调用返回 discriminated result，401 → kind:"unauthenticated"
 * （触发自动重签自愈），网络异常 → kind:"network"，其余非 2xx → kind:"server"。
 * 调用方（memory-service）对失败一律旁路降级，永不阻塞任务。
 */
import { clearMemoryPat, memoryAccountUserId, memoryPat, memoryPatForAccount } from "../settings.js";
import { memoryApiBase } from "./origin.js";

export type MemoryFailure =
  | { ok: false; kind: "unauthenticated"; status: 401 }
  | { ok: false; kind: "network"; message?: string }
  | { ok: false; kind: "server"; status: number; message?: string };

export type MemoryResult<T> = { ok: true; data: T } | MemoryFailure;

export type MemoryRecallHit = { memoryId?: string; text: string; kind?: string; score?: number };

export type MemoryBankRow = { bankId: string; name: string; memoryCount: number | null; canDelete: boolean };

export type MemoryCapabilities = {
  protocolVersion: number;
  auth: { pat: boolean };
  recall: { maxTokensCap: number; param: string };
  retain: { idempotency: boolean; async: boolean };
  revise: { expectedVersion: boolean };
  bankIdPrefixes: { agent: string; lectern: string };
};

export interface MemoryClientDeps {
  /** 注入测试用；默认每次现读 settings（PAT 惰性语义） */
  patProvider?: () => string | null;
  /** Current authenticated account; absent means fail closed. */
  accountUserIdProvider?: () => string | null;
  /** Called once on 401 to trigger cookie-based PAT re-sign. */
  onUnauthorized?: () => Promise<boolean>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

async function call<T>(
  deps: MemoryClientDeps,
  path: string,
  init: { method: string; body?: unknown; timeoutMs: number },
  retried = false,
): Promise<MemoryResult<T>> {
  const account = (deps.accountUserIdProvider ?? memoryAccountUserId)();
  const pat = deps.patProvider ? deps.patProvider() : memoryPatForAccount(account);
  if (!pat || (!deps.patProvider && !account)) return { ok: false, kind: "unauthenticated", status: 401 };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${deps.baseUrl ?? memoryApiBase()}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${pat}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
    if (res.status === 401) {
      clearMemoryPat();
      if (!retried && deps.onUnauthorized && await deps.onUnauthorized()) return call(deps, path, init, true);
      return { ok: false, kind: "unauthenticated", status: 401 };
    }
    if (!res.ok) {
      const message = await res.text().catch(() => "");
      return { ok: false, kind: "server", status: res.status, message: message.slice(0, 200) };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (error) {
    return { ok: false, kind: "network", message: error instanceof Error ? error.message : "network error" };
  } finally {
    clearTimeout(timer);
  }
}

export function createMemoryClient(deps: MemoryClientDeps = {}) {
  return {
    capabilities(timeoutMs = 3000): Promise<MemoryResult<MemoryCapabilities>> {
      return call<MemoryCapabilities>(deps, "/api/capabilities", { method: "GET", timeoutMs });
    },

    listBanks(timeoutMs = 5000): Promise<MemoryResult<{ banks: MemoryBankRow[] }>> {
      return call<{ banks: MemoryBankRow[] }>(deps, "/api/banks", { method: "GET", timeoutMs });
    },

    /** lec_ 前缀 bankId 同 owner 幂等（T17a 服务端语义），重试安全。 */
    createBank(bankId: string, name: string, timeoutMs = 5000): Promise<MemoryResult<{ ok: true; bankId: string; idempotent?: boolean }>> {
      return call(deps, "/api/banks", { method: "POST", body: { bankId, name }, timeoutMs });
    },

    recall(
      bankId: string,
      query: string,
      opts: { maxTokens?: number; timeoutMs?: number; source?: "web" | "tool" | "injection" | "eval" } = {},
    ): Promise<MemoryResult<{ hits: MemoryRecallHit[] }>> {
      const timeoutMs = opts.timeoutMs ?? 800;
      return call<{ results?: Array<Record<string, unknown>> }>(
        deps,
        `/api/banks/${encodeURIComponent(bankId)}/recall`,
        {
          method: "POST",
          body: {
            query,
            ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
            ...(opts.source ? { source: opts.source } : {}),
          },
          timeoutMs,
        },
      ).then((result) => {
        if (!result.ok) return result;
        const hits: MemoryRecallHit[] = (result.data.results ?? [])
          .map((r) => {
            const text = typeof r.text === "string" ? r.text.trim() : "";
            if (!text) return null;
            const scores = r.scores as { final?: number } | undefined;
            const score = typeof scores?.final === "number" ? scores.final : (r.score as number | undefined);
            return {
              ...(typeof r.id === "string" && r.id ? { memoryId: r.id } : {}),
              text,
              ...(typeof r.type === "string" && r.type ? { kind: r.type } : {}),
              ...(typeof score === "number" && Number.isFinite(score) ? { score } : {}),
            };
          })
          .filter((h): h is MemoryRecallHit => h !== null);
        return { ok: true as const, data: { hits } };
      });
    },

    /** T19 写入链用（T18b 前服务端忽略 idempotencyKey，不破坏兼容）。 */
    retain(
      bankId: string,
      content: string,
      opts: { context?: string; tags?: string[]; idempotencyKey?: string; async?: boolean; timeoutMs?: number } = {},
    ): Promise<MemoryResult<Record<string, unknown>>> {
      return call<Record<string, unknown>>(deps, `/api/banks/${encodeURIComponent(bankId)}/memories`, {
        method: "POST",
        body: { content, ...(opts.context ? { context: opts.context } : {}), ...(opts.tags?.length ? { tags: opts.tags } : {}), ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}), ...(opts.async ? { async: true } : {}) },
        timeoutMs: opts.timeoutMs ?? 5000,
      });
    },

    operationStatus(bankId: string, operationId: string, timeoutMs = 5000): Promise<MemoryResult<Record<string, unknown>>> {
      return call<Record<string, unknown>>(deps, `/api/banks/${encodeURIComponent(bankId)}/operations/${encodeURIComponent(operationId)}`, {
        method: "GET",
        timeoutMs,
      });
    },
  };
}

export type MemoryClient = ReturnType<typeof createMemoryClient>;
