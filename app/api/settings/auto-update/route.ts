import { NextResponse, type NextRequest } from "next/server";

import { getAutoUpdate, saveAutoUpdate } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 应用内自动更新偏好（electron main 读同一份 settings.json）：
 * - GET  { enabled }
 * - POST { enabled } 保存即生效——检查/后台下载/退出时安装共用这一个开关；
 *   关闭后仍可从账户菜单手动检查/下载/重启更新。
 */
export async function GET() {
  return NextResponse.json({ enabled: getAutoUpdate() });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "VALIDATION", message: "需要 boolean enabled" }, { status: 400 });
  }
  saveAutoUpdate(body.enabled);
  return NextResponse.json({ enabled: getAutoUpdate() });
}
