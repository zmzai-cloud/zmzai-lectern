import { NextResponse, type NextRequest } from "next/server";

import { sessionCookieFrom } from "@/lib/request-cookie";
import { clearMemoryPat, ensureMemoryDeviceId, memoryPatPrefix, saveMemoryPat } from "@/lib/settings";
import { memoryApiBase } from "@/lib/memory/origin";

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
    connected: prefix !== null,
    prefix,
    deviceId: ensureMemoryDeviceId(),
  });
}

export async function POST(request: NextRequest) {
  const cookie = sessionCookieFrom(request);
  if (!cookie) return NextResponse.json({ loggedIn: false }, { status: 401 });

  const deviceId = ensureMemoryDeviceId();
  try {
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
    saveMemoryPat(body.token);
    return NextResponse.json({ connected: true, prefix: memoryPatPrefix(), deviceId });
  } catch {
    return NextResponse.json({ error: "无法连接记忆服务" }, { status: 502 });
  }
}

export async function DELETE() {
  clearMemoryPat();
  return NextResponse.json({ connected: false });
}
