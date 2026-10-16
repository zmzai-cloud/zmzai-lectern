import { NextResponse, type NextRequest } from "next/server";

import { sessionCookieFrom } from "@/lib/request-cookie";
import { resetMemoryCacheForTest } from "@/lib/memory/service";
import { resetMemoryWorkerForTest } from "@/lib/memory/outbox";
import { clearMemoryPat, ensureMemoryDeviceId, memoryAutoConnectDisabled, memoryPatPrefix, saveMemoryPat, setMemoryAutoConnectDisabled } from "@/lib/settings";
import { memoryApiBase } from "@/lib/memory/origin";
import { relayCurrentUser } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 记忆服务接通状态（K1 自动接通，设计 §2.4）：
 * - GET    状态（origin/连接态/prefix/设备标识）——设置页纯展示，无连接按钮
 * - POST   自动接通：登录 cookie 透传签发 lectern-<设备id> PAT（服务端 upsert-by-name），
 *          明文一次返回即加密落盘。cookie 只在这一步出现，运行期全走 PAT。
 * - DELETE 清除本地 PAT（撤销本设备凭据；服务端吊销走网页 tokens 管理页）
 */
export async function GET() {
  const prefix = memoryPatPrefix();
  return NextResponse.json({
    origin: memoryApiBase(),
    connected: prefix !== null && !memoryAutoConnectDisabled(),
    status: memoryAutoConnectDisabled() ? "disabled" : prefix !== null ? "connected" : "signed_out",
    prefix,
    deviceId: ensureMemoryDeviceId(),
  });
}

export async function POST(request: NextRequest) {
  const enabling = request.nextUrl.searchParams.get("enable") === "1";
  if (memoryAutoConnectDisabled() && !enabling) {
    return NextResponse.json({ error: "记忆已由用户停用", status: "disabled" }, { status: 409 });
  }
  const cookie = sessionCookieFrom(request);
  if (!cookie) return NextResponse.json({ loggedIn: false }, { status: 401 });

  const deviceId = ensureMemoryDeviceId();
  try {
    const identityRes = await fetch(`${memoryApiBase()}/api/me`, { headers: { cookie }, cache: "no-store" });
    const identity = (await identityRes.json().catch(() => null)) as { userId?: string } | null;
    const relayUser = await relayCurrentUser(cookie);
    if (!identityRes.ok || !identity?.userId || !relayUser || relayUser.id !== identity.userId) {
      clearMemoryPat();
      resetMemoryCacheForTest();
      resetMemoryWorkerForTest();
      return NextResponse.json({ error: "无法验证记忆账户身份", status: "reauth_required" }, { status: 401 });
    }
    const res = await fetch(`${memoryApiBase()}/api/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: `lectern-${deviceId}` }),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
    if (!res.ok || !body?.token) {
      return NextResponse.json({ error: body?.error ?? `记忆服务签发失败（${res.status}）` }, { status: 502 });
    }
    // 明文只在服务端内存中转一次，立即加密落盘（.secret / AES-256-GCM）
    saveMemoryPat(body.token, identity.userId);
    if (enabling) setMemoryAutoConnectDisabled(false);
    return NextResponse.json({ connected: true, status: "connected", prefix: memoryPatPrefix(), deviceId, userId: identity.userId });
  } catch {
    return NextResponse.json({ error: "无法连接记忆服务" }, { status: 502 });
  }
}

export async function DELETE(request: NextRequest) {
  const cookie = sessionCookieFrom(request);
  if (!cookie) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const prefix = memoryPatPrefix();
  const deviceId = ensureMemoryDeviceId();
  try {
    const list = await fetch(`${memoryApiBase()}/api/tokens`, { headers: { cookie }, cache: "no-store" });
    if (!list.ok) return NextResponse.json({ error: "无法核实远端令牌" }, { status: 502 });
    const body = (await list.json()) as { tokens?: Array<{ id: string; name: string; prefix: string; status: string }> };
    const token = body.tokens?.find((t) => t.name === `lectern-${deviceId}` && t.prefix === prefix && t.status === "active");
    if (!token) return NextResponse.json({ error: "远端令牌不匹配，请在 Tome 管理页核实" }, { status: 409 });
    const revoked = await fetch(`${memoryApiBase()}/api/tokens/${encodeURIComponent(token.id)}`, {
      method: "DELETE", headers: { cookie }, cache: "no-store",
    });
    if (!revoked.ok) return NextResponse.json({ error: "远端撤销失败" }, { status: 502 });
    clearMemoryPat();
    setMemoryAutoConnectDisabled(true);
    resetMemoryCacheForTest();
    resetMemoryWorkerForTest();
    return NextResponse.json({ connected: false, status: "disabled", ok: true });
  } catch {
    return NextResponse.json({ error: "记忆服务不可达，令牌尚未撤销" }, { status: 502 });
  }
}
