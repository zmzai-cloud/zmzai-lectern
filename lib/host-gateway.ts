import { hostBootstrap } from "./m2a-host.js";

/** M2b 网关（设计 §1.2）：静态路由表把生产路径代理到 Host。
 *  【armed 判定】仅当 LECTERN_HOST_GATEWAY 指向 host.json（验证环境由
 *  smoke/fixture 设置；生产与默认 dev 不设 → 网关休眠，旧 handler 原样
 *  服务——M2 期间不切生产入口的双写红线就靠这个开关）。
 *  未命中表的路径一律返回 null（调用方回落旧 handler）。 */

export type GatewayRoute = { method: string; pattern: RegExp; hostPath: (groups: string[]) => string; passQuery: true };

export const GATEWAY_ROUTES: GatewayRoute[] = [
  { method: "GET", pattern: /^\/api\/sessions$/, hostPath: () => "/v1/sessions", passQuery: true },
  { method: "GET", pattern: /^\/api\/sessions\/([^/]+)\/messages$/, hostPath: (g) => `/v1/sessions/${g[0]}/messages`, passQuery: true },
  { method: "GET", pattern: /^\/api\/sessions\/([^/]+)\/search$/, hostPath: (g) => `/v1/sessions/${g[0]}/search`, passQuery: true },
  { method: "GET", pattern: /^\/api\/sessions\/([^/]+)\/read-state$/, hostPath: (g) => `/v1/sessions/${g[0]}/read-state`, passQuery: true },
  { method: "GET", pattern: /^\/api\/sessions\/([^/]+)\/usage$/, hostPath: (g) => `/v1/sessions/${g[0]}/usage`, passQuery: true },
];

export function gatewayArmed(): boolean {
  return Boolean(process.env.LECTERN_HOST_GATEWAY);
}

export function matchGatewayRoute(method: string, pathname: string): { route: GatewayRoute; groups: string[] } | null {
  for (const route of GATEWAY_ROUTES) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(pathname);
    if (m) return { route, groups: m.slice(1) };
  }
  return null;
}

/** 命中且网关已 armed → 代理 Host 并返回 Response；否则 null（回落旧 handler）。 */
export async function hostGateway(request: Request): Promise<Response | null> {
  const override = process.env.LECTERN_HOST_GATEWAY;
  if (!override) return null;
  const url = new URL(request.url);
  const hit = matchGatewayRoute(request.method, url.pathname);
  if (!hit) return null;
  // 验证环境：host.json 路径可被 LECTERN_HOST_GATEWAY 显式覆盖（与
  // LECTERN_HOST_BOOTSTRAP 分离，网关与 m2a 实验路由互不耦合）
  const boot = JSON.parse((await import("node:fs")).readFileSync(override, "utf8")) as { port: number; token: string };
  const target = new URL(`http://127.0.0.1:${boot.port}${hit.route.hostPath(hit.groups)}`);
  if (hit.route.passQuery) target.search = url.search;
  const res = await fetch(target, { headers: { authorization: `Bearer ${boot.token}` }, signal: request.signal });
  const headers = new Headers({ "content-type": res.headers.get("content-type") ?? "application/json; charset=utf-8" });
  if (res.headers.get("cache-control")) headers.set("cache-control", res.headers.get("cache-control")!);
  return new Response(res.body, { status: res.status, headers });
}
