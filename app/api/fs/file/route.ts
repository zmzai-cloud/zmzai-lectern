import { withWorkflowErrors, rethrowWorkflowError } from "@/lib/workflow-error";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { resolveWithinWorkspace } from "@/lib/paths";
import { workspaceRootForSession } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 512 * 1024;

/** GET /api/fs/file?path=README.md — 读取工作区内文本文件预览（限 512KB） */
async function handleGET(request: NextRequest) {
  const rel = request.nextUrl.searchParams.get("path");
  if (!rel) return NextResponse.json({ error: "缺少 path 参数" }, { status: 400 });
  try {
    const abs = resolveWithinWorkspace(rel, workspaceRootForSession(request.nextUrl.searchParams.get("sessionId")));
    const st = await stat(abs);
    if (st.isDirectory()) return NextResponse.json({ error: "目标是目录" }, { status: 400 });
    if (st.size > MAX_BYTES) {
      return NextResponse.json({ error: `文件过大（${Math.round(st.size / 1024)}KB > 512KB），请用终端查看` }, { status: 400 });
    }
    const buf = await readFile(abs);
    // 简易二进制嗅探：出现 NUL 字节判定为二进制，不硬塞进 JSON
    if (buf.includes(0)) {
      return NextResponse.json({ error: "二进制文件不支持预览" }, { status: 400 });
    }
    return NextResponse.json({ path: rel, size: st.size, content: buf.toString("utf8") });
  } catch (err) {
    rethrowWorkflowError(err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "读取文件失败" }, { status: 400 });
  }
}

/** PUT /api/fs/file — 编辑器保存回写（工作区内，限制同 GET）。 */
async function handlePUT(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { path?: string; content?: string; sessionId?: string } | null;
  const rel = body?.path;
  if (!rel || typeof body?.content !== "string") {
    return NextResponse.json({ error: "缺少 path 或 content 参数" }, { status: 400 });
  }
  try {
    const abs = resolveWithinWorkspace(rel, workspaceRootForSession(body.sessionId));
    if (Buffer.byteLength(body.content, "utf8") > MAX_BYTES) {
      return NextResponse.json({ error: "内容超过 512KB 限制" }, { status: 400 });
    }
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body.content, "utf8");
    return NextResponse.json({ ok: true, size: Buffer.byteLength(body.content, "utf8") });
  } catch (err) {
    rethrowWorkflowError(err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "写入文件失败" }, { status: 400 });
  }
}

export const GET = withWorkflowErrors(handleGET);
export const PUT = withWorkflowErrors(handlePUT);
