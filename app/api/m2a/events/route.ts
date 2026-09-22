import { hostBootstrap } from "@/lib/m2a-host";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** SSE 直通代理：Host 的 text/event-stream 原样回传（含 id:/data: 帧）。
 *  断线续传由 ?since= 透传到 Host。 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const since = url.searchParams.get("since") ?? "0";
  if (!sessionId) return new Response(JSON.stringify({ error: "INVALID_INPUT" }), { status: 400 });
  const bootstrap = hostBootstrap();
  const upstream = await fetch(`http://127.0.0.1:${bootstrap.port}/v1/events?sessionId=${encodeURIComponent(sessionId)}&since=${since}`, {
    headers: { authorization: `Bearer ${bootstrap.token}` },
    signal: request.signal,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
  });
}
