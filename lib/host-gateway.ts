import { hostBootstrap } from "./m2a-host.js";

/** M2b 网关（设计 §1.2）：静态路由表把生产路径代理到 Host。
 *  【armed 判定】仅当 LECTERN_HOST_GATEWAY 指向 host.json（验证环境由
 *  smoke/fixture 设置；生产与默认 dev 不设 → 网关休眠，旧 handler 原样
 *  服务——M2 期间不切生产入口的双写红线就靠这个开关）。
 *  未命中表的路径一律返回 null（调用方回落旧 handler）。 */

export type GatewayRoute = {
  method: string;
  pattern: RegExp;
  hostPath?: (groups: string[]) => string;
  passQuery?: boolean;
  /** 完整 URL 构造（含 query 注入）；返回后强制指向 Host 端口。 */
  hostUrl?: (groups: string[], url: URL) => URL;
  /** POST 路由：把路径参数并入 body（Host 命令面以 sessionId 为准）。 */
  rewriteBody?: (groups: string[], body: Record<string, unknown>) => Record<string, unknown>;
  /** true = 从请求 Cookie 提取 muzhi_session 单值，以 x-lectern-credential
   *  转发（spec §5.3：不转发全部 cookie）。 */
  withCredential?: boolean;
};

export const GATEWAY_ROUTES: GatewayRoute[] = [
  { method: "GET", pattern: /^\/api\/sessions$/, hostPath: () => "/v1/sessions", passQuery: true },
  { method: "GET", pattern: /^\/api\/sessions\/([^/]+)\/messages$/, hostPath: (g) => `/v1/sessions/${g[0]}/messages`, passQuery: true },
  { method: "GET", pattern: /^\/api\/sessions\/([^/]+)\/search$/, hostPath: (g) => `/v1/sessions/${g[0]}/search`, passQuery: true },
  { method: "GET", pattern: /^\/api\/sessions\/([^/]+)\/read-state$/, hostPath: (g) => `/v1/sessions/${g[0]}/read-state`, passQuery: true },
  { method: "GET", pattern: /^\/api\/sessions\/([^/]+)\/usage$/, hostPath: (g) => `/v1/sessions/${g[0]}/usage`, passQuery: true },
  // B2 命令族（POST）：路径 sessionId 并入 body；prompt 带凭据通道
  { method: "POST", pattern: /^\/api\/sessions\/([^/]+)\/prompt$/, hostPath: () => "/v1/commands/prompt", rewriteBody: (g, b) => ({ ...b, sessionId: g[0] }), withCredential: true },
  { method: "POST", pattern: /^\/api\/sessions\/([^/]+)\/abort$/, hostPath: () => "/v1/commands/abort", rewriteBody: (g, b) => ({ ...b, sessionId: g[0] }) },
  { method: "POST", pattern: /^\/api\/sessions\/([^/]+)\/permission$/, hostPath: () => "/v1/commands/permission", rewriteBody: (g, b) => ({ ...b, sessionId: g[0] }) },
  { method: "POST", pattern: /^\/api\/sessions\/([^/]+)\/task$/, hostPath: () => "/v1/commands/task", rewriteBody: (g, b) => ({ action: b.action, sessionId: g[0] }) },
  { method: "POST", pattern: /^\/api\/sessions\/([^/]+)\/compact$/, hostPath: () => "/v1/commands/compact", rewriteBody: (g) => ({ sessionId: g[0] }) },
  { method: "POST", pattern: /^\/api\/sessions\/([^/]+)\/read-state$/, hostPath: () => "/v1/commands/read-state", rewriteBody: (g, b) => ({ messageSeq: b.messageSeq, revision: b.revision, sessionId: g[0] }) },
  // B4：附件（下载字节流直通；Next 的 ?raw=1 转为 Host /raw 路径）
  { method: "GET", pattern: /^\/api\/sessions\/([^/]+)\/attachments\/([^/]+)$/, hostUrl: (g, url) => {
      const raw = url.searchParams.get("raw") === "1";
      const q = new URLSearchParams({ sessionId: g[0] });
      if (url.searchParams.get("download") === "1") q.set("download", "1");
      return new URL(`/v1/attachments/${g[1]}${raw ? "/raw" : ""}?${q}`, "http://127.0.0.1");
    } },
  // B4：终端族（list/create/POST op/GET read）
  { method: "GET", pattern: /^\/api\/terminal$/, hostPath: () => "/v1/terminal" },
  { method: "POST", pattern: /^\/api\/terminal$/, hostPath: () => "/v1/terminal" },
  { method: "POST", pattern: /^\/api\/terminal\/([^/]+)\/(input|resize)$/, hostPath: (g) => `/v1/terminal/${g[0]}`, rewriteBody: (g, b) => g[1] === "input" ? { op: "write", payload: { data: b.data } } : { op: "resize", payload: { cols: b.cols, rows: b.rows } } },
  { method: "DELETE", pattern: /^\/api\/terminal\/([^/]+)$/, hostPath: (g) => `/v1/terminal/${g[0]}`, rewriteBody: (g) => ({ op: "kill" }) },
  { method: "GET", pattern: /^\/api\/terminal\/([^/]+)\/read$/, hostPath: (g) => `/v1/terminal/${g[0]}` },
  { method: "GET", pattern: /^\/api\/terminal\/read-all$/, hostPath: () => "/v1/terminal/__all__" },
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
  const target = hit.route.hostUrl
    ? hit.route.hostUrl(hit.groups, url)
    : new URL(`http://127.0.0.1:${boot.port}${hit.route.hostPath!(hit.groups)}`);
  if (hit.route.hostUrl) target.host = `127.0.0.1:${boot.port}`;
  else if (hit.route.passQuery) target.search = url.search;
  const reqHeaders: Record<string, string> = { authorization: `Bearer ${boot.token}` };
  let body: string | undefined;
  if (hit.route.rewriteBody) {
    reqHeaders["content-type"] = "application/json";
    const raw: Record<string, unknown> = await request.clone().json().catch(() => ({}));
    body = JSON.stringify(hit.route.rewriteBody(hit.groups, raw));
  }
  if (hit.route.withCredential) {
    // 只提取 muzhi_session 单值（spec §5.3：不转发全部浏览器 cookie）
    const cookie = request.headers.get("cookie") ?? "";
    const match = /(?:^|;\s*)muzhi_session=([^;]+)/.exec(cookie);
    // 全 header 形式转发（与 ALS 存储一致，authHeaders/resolveModel 直接可用）
    if (match) reqHeaders["x-lectern-credential"] = `muzhi_session=${decodeURIComponent(match[1]!)}`;
  }
  const res = await fetch(target, { method: request.method, headers: reqHeaders, body, signal: request.signal });
  const headers = new Headers({ "content-type": res.headers.get("content-type") ?? "application/json; charset=utf-8" });
  // 透传白名单：缓存策略 + 附件安全头（spec §13：nosniff/sandbox/私有缓存
  // 必须随字节流一起到达浏览器，网关不得剥掉）
  for (const name of ["cache-control", "content-disposition", "x-content-type-options", "cross-origin-resource-policy", "content-security-policy", "content-length"]) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(res.body, { status: res.status, headers });
}
