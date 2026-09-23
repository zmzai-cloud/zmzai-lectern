import { withWorkflowErrors } from "@/lib/workflow-error";
import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { dataDir } from "@/lib/runtime-constants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/deliveries/browser-screenshot?ref=browser-screenshots/<file>.png —
 *  浏览器验证截图证据（V1-S6）。ref 必须解析后落在 <dataDir>/browser-screenshots/
 *  之内（防目录穿越），文件不存在 404，非 png 后缀 400。 */
async function handleGET(request: NextRequest) {
  const ref = new URL(request.url).searchParams.get("ref") ?? "";
  const root = resolve(dataDir, "browser-screenshots");
  const target = resolve(dataDir, ref);
  // 路径守卫：normalize 后必须仍在 browser-screenshots/ 下（../ 与绝对路径都拒绝）
  if (!target.startsWith(root + sep) || !target.endsWith(".png")) {
    return NextResponse.json({ error: "非法截图引用" }, { status: 400 });
  }
  if (!existsSync(target)) {
    return NextResponse.json({ error: "截图不存在" }, { status: 404 });
  }
  const bytes = readFileSync(target);
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" },
  });
}

export const GET = withWorkflowErrors(handleGET);
