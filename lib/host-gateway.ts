import { hostBootstrap } from "./m2a-host.js";
import { getActiveProject } from "./projects.js";

/** M2b 网关（设计 §1.2）：静态路由表把生产路径代理到 Host。
 *  【armed 判定】仅当 LECTERN_HOST_GATEWAY 指向 host.json（验证环境由
 *  smoke/fixture 设置；生产与默认 dev 不设 → 网关休眠，旧 handler 原样
 *  服务——M2 期间不切生产入口的双写红线就靠这个开关）。
 *
 *  【T07 模式锁定（spec 2026-09-28 §4.3 / F04 / PC10-11）】armed 是**进程启动
 *  快照**（env 由 main.cjs 在 fork 前注入），运行中不因 Host 死活切换模式：
 *  - 未 armed（legacy/进程内）：一律返回 null 走旧 handler——这是启动时选定
 *    的模式，不是请求期回退；
 *  - armed 且路由命中：Host 不可达（连接失败/超时/握手文件不可读）返回
 *    **结构化 503 HOST_UNAVAILABLE**，绝不返回 null——此前 fetch 异常回落
 *    进程内会在「Host 已接受命令但响应丢失」窗口制造第二执行者（F04）。
 *    客户端带原 requestId 同键重试（Host 的命令面按 requestId 幂等，同键
 *    重试即回执查询），或经 /command/:requestId 显式查回执。
 *  - 路由未命中：返回 null 走进程内（静态非执行路径的合法回落）。 */

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
  /** passQuery 时对缺失的 key 注入默认值（与进程内 handler 的默认一致——
   *  Host 版 API 要求显式参数，浏览器裸请求不带；0.10.0 packaged armed 首跑暴露）。 */
  injectQuery?: Record<string, string>;
  /** 响应解包：Host 形状 {<key>:[...]} → 裸数组（进程内契约不变，UI 零改动）。 */
  unwrap?: string;
};

export const GATEWAY_ROUTES: GatewayRoute[] = [
  // GET /api/sessions（T09 回归网关化）：0.10.1 因 Host 单 runtime 读不到多项目
  // 会话被撤下（d416ca4）；T08 起 Host 的 listSessions 全项目聚合 + 显式
  // projectId（未知项目报错），列表回归 Host——running 态在 Host 进程的
  // activeRuns 里才是真相源（armed 下执行在 Host）。
  // 契约翻译：?all=1 → 全项目聚合；缺省 → 注入 active 项目 id（每请求重读
  // projects.json，切换项目即时生效，不依赖 Next 重启；读不到 active 时
  // 不注入 → Host 聚合全项目，宁可多列不静默空表）。
  {
    method: "GET",
    pattern: /^\/api\/sessions$/,
    hostUrl: (_g, url) => {
      const q = new URLSearchParams({ userId: "local", workspaceId: "local" });
      if (url.searchParams.get("all") !== "1") {
        try {
          const project = getActiveProject();
          q.set("projectId", project.id);
        } catch { /* projects.json 不可读：全项目聚合兜底 */ }
      }
      return new URL(`/v1/sessions?${q}`, "http://127.0.0.1");
    },
    unwrap: "sessions",
  },
  // SSE 事件流（T09）：Host 的 /v1/events（sinceSeq 重放 + CURSOR_STALE 409
  // 与进程内契约同构）；网关透传字节流与 content-type，心跳由 Host 发。
  // hostUrl 合并 sessionId + since（passQuery 会整体覆盖 search，不能用）。
  { method: "GET", pattern: /^\/api\/sessions\/([^/]+)\/events$/, hostUrl: (g, url) => {
      const q = new URLSearchParams({ sessionId: g[0] });
      const since = url.searchParams.get("since");
      if (since) q.set("since", since);
      return new URL(`/v1/events?${q}`, "http://127.0.0.1");
    } },
  { method: "GET", pattern: /^\/api\/sessions\/([^/]+)\/messages$/, hostPath: (g) => `/v1/sessions/${g[0]}/messages`, passQuery: true },
  { method: "GET", pattern: /^\/api\/sessions\/([^/]+)\/search$/, hostPath: (g) => `/v1/sessions/${g[0]}/search`, passQuery: true },
  { method: "GET", pattern: /^\/api\/sessions\/([^/]+)\/read-state$/, hostPath: (g) => `/v1/sessions/${g[0]}/read-state`, passQuery: true },
  { method: "GET", pattern: /^\/api\/sessions\/([^/]+)\/usage$/, hostPath: (g) => `/v1/sessions/${g[0]}/usage`, passQuery: true },
  // T07（PC10）：命令回执查询——结果未知时的显式核对入口（同键重试之外的第二条路）
  { method: "GET", pattern: /^\/api\/sessions\/([^/]+)\/command\/([^/]+)$/, hostUrl: (g) => new URL(`/v1/commands/receipt?sessionId=${encodeURIComponent(g[0])}&requestId=${encodeURIComponent(g[1])}`, "http://127.0.0.1") },
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
  { method: "POST", pattern: /^\/api\/terminal$/, hostPath: () => "/v1/terminal", rewriteBody: (g, b) => b },
  { method: "POST", pattern: /^\/api\/terminal\/([^/]+)\/(input|resize)$/, hostPath: (g) => `/v1/terminal/${g[0]}`, rewriteBody: (g, b) => g[1] === "input" ? { op: "write", payload: { data: b.data } } : { op: "resize", payload: { cols: b.cols, rows: b.rows } } },
  { method: "DELETE", pattern: /^\/api\/terminal\/([^/]+)$/, hostPath: (g) => `/v1/terminal/${g[0]}`, rewriteBody: (g) => ({ op: "kill" }) },
  { method: "GET", pattern: /^\/api\/terminal\/([^/]+)\/read$/, hostPath: (g) => `/v1/terminal/${g[0]}` },
  { method: "GET", pattern: /^\/api\/terminal\/read-all$/, hostPath: () => "/v1/terminal/__all__" },
  // B4：mcp 状态（GET/POST rescan）与 worktree 查询；W1-S27 起 worktree 写操作
  // （merge/discard）也走 Host——动作层与 Next 同一实现
  { method: "GET", pattern: /^\/api\/mcp$/, hostPath: () => "/v1/mcp" },
  { method: "POST", pattern: /^\/api\/mcp$/, hostPath: () => "/v1/mcp" },
  { method: "GET", pattern: /^\/api\/sessions\/([^/]+)\/worktree$/, hostPath: (g) => `/v1/sessions/${g[0]}/worktree` },
  // W1-S27：worktree 写操作（merge/discard）网关化——Host 动作层=Next 同一实现
  { method: "POST", pattern: /^\/api\/sessions\/([^/]+)\/worktree$/, hostPath: (g) => `/v1/sessions/${g[0]}/worktree` },
];

export function gatewayArmed(): boolean {
  return Boolean(process.env.LECTERN_HOST_GATEWAY);
}

/** armed 启动快照（T07 模式锁定）：模块加载期求值一次。env 由 main.cjs 在
 *  fork 前注入，进程内不会变化——显式快照让「运行中不切模式」成为结构保证
 *  而不是约定，也给测试一个明确的注入点。 */
const armedAtStartup: boolean = gatewayArmed();

/** 网关请求超时（T07）：Host 死锁/半开连接时 fetch 可能无限悬挂，客户端只看到
 *  转圈。命令面是登记即回（receipt 语义），20 秒拿不到响应按不可达处理。 */
const GATEWAY_TIMEOUT_MS = 20_000;

export function matchGatewayRoute(method: string, pathname: string): { route: GatewayRoute; groups: string[] } | null {
  for (const route of GATEWAY_ROUTES) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(pathname);
    if (m) return { route, groups: m.slice(1) };
  }
  return null;
}

/** 结构化 Host 不可达（spec §6.3 错误契约：{code,message,retryable,details}）。
 *  结果未知语义：命令类请求可能已被 Host 接受（登记与响应之间断连）——
 *  客户端必须原 requestId 同键重试或查回执，不得换新键补发（PC10）。 */
function hostUnavailable(detail: { requestId?: string; sessionId?: string; reason: string }): Response {
  const message = "Host 服务不可达，请求结果未知：请用同一 requestId 重试或查询命令回执；未收到确认前不要重复发送。";
  return Response.json(
    { error: message, detail: { code: "HOST_UNAVAILABLE", message, retryable: true, ...(detail.requestId ? { requestId: detail.requestId } : {}), ...(detail.sessionId ? { sessionId: detail.sessionId } : {}), reason: detail.reason } },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

/** 命中且网关已 armed → 代理 Host 并返回 Response。
 *  未 armed（启动锁定 legacy）或路由未命中 → null（进程内 handler 服务）。 */
export async function hostGateway(request: Request): Promise<Response | null> {
  const override = process.env.LECTERN_HOST_GATEWAY;
  if (!override || !armedAtStartup) return null;
  const url = new URL(request.url);
  const hit = matchGatewayRoute(request.method, url.pathname);
  if (!hit) return null;
  const sessionId = hit.groups[0] ?? undefined;
  // 命令类 POST 的原始 requestId：不可达响应必须带回（客户端同键重试的锚点）
  let requestId: string | undefined;
  if (hit.route.rewriteBody) {
    const raw = (await request.clone().json().catch(() => null)) as { requestId?: unknown } | null;
    if (raw && typeof raw.requestId === "string") requestId = raw.requestId;
  }
  // 验证环境：host.json 路径可被 LECTERN_HOST_GATEWAY 显式覆盖（与
  // LECTERN_HOST_BOOTSTRAP 分离，网关与 m2a 实验路由互不耦合）
  let boot: { port: number; token: string };
  try {
    const { readFileSync } = await import("node:fs");
    boot = JSON.parse(readFileSync(override, "utf8")) as { port: number; token: string };
  } catch {
    return hostUnavailable({ ...(sessionId ? { sessionId } : {}), ...(requestId ? { requestId } : {}), reason: "handshake-file-unreadable" });
  }
  const target = hit.route.hostUrl
    ? hit.route.hostUrl(hit.groups, url)
    : new URL(`http://127.0.0.1:${boot.port}${hit.route.hostPath!(hit.groups)}`);
  if (hit.route.hostUrl) target.host = `127.0.0.1:${boot.port}`;
  else if (hit.route.passQuery) {
    const q = new URLSearchParams(url.search);
    for (const [key, value] of Object.entries(hit.route.injectQuery ?? {})) {
      if (!q.get(key)) q.set(key, value);
    }
    target.search = q.toString();
  }
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
  // T07：armed 后不可达不回落（见文件头）。fetch 失败/超时 → 结构化 503；
  // 客户端信号断开（用户关页面）同样按不可达报，不再有进程内第二执行者。
  let signal: AbortSignal | undefined = request.signal;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    signal = AbortSignal.any([request.signal, AbortSignal.timeout(GATEWAY_TIMEOUT_MS)]);
  }
  let res: Response;
  try {
    res = await fetch(target, { method: request.method, headers: reqHeaders, body, signal });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "connection-failed";
    return hostUnavailable({ ...(sessionId ? { sessionId } : {}), ...(requestId ? { requestId } : {}), reason });
  }
  if (!res) {
    return hostUnavailable({ ...(sessionId ? { sessionId } : {}), ...(requestId ? { requestId } : {}), reason: "connection-failed" });
  }
  // 形状适配（unwrap）：Host 列表端点返回 {key:[...]}，进程内/UI 契约是裸数组
  if (hit.route.unwrap && (res.headers.get("content-type") ?? "").includes("application/json")) {
    const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (parsed && Array.isArray(parsed[hit.route.unwrap])) {
      return new Response(JSON.stringify(parsed[hit.route.unwrap]), {
        status: res.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  }
  const headers = new Headers({ "content-type": res.headers.get("content-type") ?? "application/json; charset=utf-8" });
  // 透传白名单：缓存策略 + 附件安全头（spec §13：nosniff/sandbox/私有缓存
  // 必须随字节流一起到达浏览器，网关不得剥掉）
  for (const name of ["cache-control", "content-disposition", "x-content-type-options", "cross-origin-resource-policy", "content-security-policy", "content-length"]) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(res.body, { status: res.status, headers });
}
