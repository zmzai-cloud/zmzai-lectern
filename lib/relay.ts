/**
 * relay / muzhi 的 HTTP 客户端（服务端专用，Node 环境）。
 * relay 以登录 cookie（muzhi_session）鉴权——harness 服务端把浏览器
 * 同域 cookie 透传过去，即「登录一次，全链路可用」。
 */

import { primeModelCaps } from "./model-caps.js";
import { getSettings } from "./settings.js";

// relay 端点优先级：设置页配置（settings.json）> RELAY_URL > OPENAI_BASE_URL > 本机。
// 函数形式：设置页修改后聊天/模型列表链路即时生效，无需重启。
export function relayBase(): string {
  const raw = getSettings().relayUrl ?? process.env.RELAY_URL ?? process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:3003/api/v1";
  return raw.replace(/\/$/, "");
}

/** relay 控制面基址（/api/me/* 等站点 API）：OpenAI 兼容前缀（…/api/v1 或 …/v1）反推。 */
export function relayControlBase(): string {
  const base = relayBase().replace(/\/v1$/, "");
  return base.endsWith("/api") ? base : `${base}/api`;
}
export const muzhiBase = (process.env.MUZHI_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
export const sessionCookieName = process.env.SESSION_COOKIE_NAME ?? "muzhi_session";

export type RelayModel = {
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  allowedReasoningEfforts?: string[];
};

export type ModelSelectorData = {
  featured: { id: string; name: string; description?: string; channel: string; maxInputTokens: number; maxOutputTokens: number; allowedReasoningEfforts: string[] }[];
  channels: { id: string; name: string; models: { id: string; name: string; channel?: string; meta?: Record<string, string>; maxInputTokens: number; maxOutputTokens: number; allowedReasoningEfforts: string[] }[] }[];
};

export type ModelsResponse = { models: RelayModel[]; modelSelectorData: ModelSelectorData };

/** 调 relay 的 GET 接口；cookie 为 null 时同样发请求（relay 会 401）。 */
export async function relayGet<T>(path: string, cookie: string | null): Promise<T | null> {
  try {
    const res = await fetch(`${relayBase()}${path}`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** 当前登录用户 profile（name/email，账户块展示用）；未登录/不可达返回 null。
 *  降级链：relay /api/me/profile（新部署）→ muzhi /api/auth/me（同一 session，
 *  生产 relay 旧版无 profile 端点时旧 404 会导致「登录成功但恒显未登录」）。 */
export async function relayCurrentUser(cookie: string | null): Promise<{ id: string; name: string; email: string } | null> {
  const fromJson = (j: unknown): { id: string; name: string; email: string } | null => {
    const u = (j as { user?: { id?: string; name?: string; email?: string } } | null)?.user;
    return u?.id && u.name && u.email ? { id: u.id, name: u.name, email: u.email } : null;
  };
  try {
    const res = await fetch(`${relayControlBase()}/me/profile`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
    });
    if (res.ok) return (await res.json()) as { id: string; name: string; email: string };
  } catch {
    // 落到 muzhi 降级
  }
  if (!cookie) return null;
  try {
    const res = await fetch(`${muzhiBase}/api/auth/me`, {
      headers: { cookie },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return fromJson(await res.json().catch(() => null));
  } catch {
    return null;
  }
}

/** 退出登录：转发 relay /api/logout（删除共享会话并清父域 cookie）。 */
export async function relayLogout(cookie: string | null): Promise<boolean> {
  try {
    const res = await fetch(`${relayControlBase()}/logout`, {
      method: "POST",
      headers: cookie ? { cookie } : {},
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 模型目录 + 用户配置（featured/channels），未登录返回 null。
 *  顺带把每个模型的真实上下文窗口灌进进程内缓存——provider 的 getModel 是
 *  同步契约，只能查缓存；resolveModel 链路（建会话 / prompt / rewind）都经过
 *  这里，因此真实能力在这些路径上首次即可生效，且不产生额外请求。 */
export async function relayModels(cookie: string | null): Promise<ModelsResponse | null> {
  const data = await relayGet<ModelsResponse>("/models", cookie);
  primeModelCaps(data?.models);
  return data;
}

/** 把 relay 模型目录映射为 UI 的 AgentInfo 列表：优先用户配置的 featured
 *  模型，fallback 全量模型；空目录时兜底 default。 */
export async function resolveAgents(cookie: string | null): Promise<{ name: string; description?: string; model: string }[]> {
  const data = await relayModels(cookie);
  if (data) {
    const featured = data.modelSelectorData?.featured ?? [];
    const agents = featured.length
      ? featured.map((m) => ({ name: m.id, model: m.id, description: m.description }))
      : (data.models ?? []).map((m) => ({ name: m.model, model: m.model }));
    if (agents.length) return agents;
  }
  return [{ name: "default", model: process.env.OPENAI_MODEL ?? "deepseek-chat" }];
}

/** 按 agent 名解析模型引用（服务端用，查不到走 env 默认）。 */
export async function resolveModel(agent: string | undefined, cookie: string | null): Promise<{ providerId: string; modelId: string } | undefined> {
  if (!agent) return undefined;
  const agents = await resolveAgents(cookie);
  const hit = agents.find((a) => a.name === agent);
  return hit ? { providerId: "openai", modelId: hit.model } : undefined;
}

/**
 * 转发 muzhi 登录（POST /api/auth/login）。muzhi 的 CSRF 校验要求
 * Origin 与目标同源——服务端转发时显式带上 Origin 头。
 * 成功时返回响应里的全部 Set-Cookie，由调用方写回浏览器（harness 域）。
 */
export async function muzhiLogin(email: string, password: string): Promise<{
  ok: boolean;
  status: number;
  setCookies: string[];
  body: { error?: string } | null;
}> {
  try {
    const res = await fetch(`${muzhiBase}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: muzhiBase,
      },
      body: JSON.stringify({ email, password }),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return {
      ok: res.ok,
      status: res.status,
      setCookies: res.headers.getSetCookie?.() ?? [],
      body,
    };
  } catch {
    return { ok: false, status: 502, setCookies: [], body: { error: "无法连接 muzhi，请确认服务已启动" } };
  }
}
