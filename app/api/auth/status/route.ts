import { NextResponse, type NextRequest } from "next/server";

import { relayCurrentUser, sessionCookieName } from "@/lib/relay";
import { clearMemoryPat, memoryAccountUserId } from "@/lib/settings";
import { resetMemoryCacheForTest } from "@/lib/memory/service";
import { resetMemoryWorkerForTest } from "@/lib/memory/outbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 登录态 + 当前用户 profile（name/email，账户块展示用）。 */
export async function GET(request: NextRequest) {
  const cookie = request.cookies.get(sessionCookieName)?.value;
  const cookieHeader = cookie ? `${sessionCookieName}=${cookie}` : null;
  const user = await relayCurrentUser(cookieHeader);
  const previous = memoryAccountUserId();
  if (!user || (previous && previous !== user.id)) {
    // Logout/account switch clears the credential and runtime caches, but keeps
    // account-bound bindings and pending records for same-account resume.
    clearMemoryPat();
    resetMemoryCacheForTest();
    resetMemoryWorkerForTest();
  }
  return NextResponse.json({
    loggedIn: user !== null,
    cookieName: sessionCookieName,
    user: user ? { id: user.id, name: user.name, email: user.email } : null,
  });
}
