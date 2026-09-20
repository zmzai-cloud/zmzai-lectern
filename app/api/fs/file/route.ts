import { withWorkflowErrors, rethrowWorkflowError } from "@/lib/workflow-error";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { classifyFileBytes, looksBinaryHead } from "@/lib/file-content";
import { resolveWithinWorkspace } from "@/lib/paths";
import { workspaceRootForSession } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 512 * 1024;
const HEAD_BYTES = 8192;

/** 只读文件头一截；用于「超过文本上限」的分支判断它到底是二进制还是单纯太大。 */
async function readHead(abs: string, bytes: number): Promise<Buffer> {
  const handle = await open(abs, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * GET /api/fs/file?path=README.md — 读取工作区内文件做文本预览（限 512KB）。
 *
 * 【二进制不是错误】不是文本的文件**照常返回 200**，只是 `binary: true`、
 * `content` 为空串——文件确实存在、也确实读到了，只是它的内容不适合放进编辑器。
 * 用 4xx 表达这件事会让调用方只能拿到一句文案（`lib/client.ts` 的 `j()` 只抛
 * 消息），而界面需要的是「该怎么处理它」：送进成果预览，还是根本没得看。
 * 所以判断结论放在响应体里，4xx 留给真正的失败（越界、目录、读不到）。
 *
 * 【判据】见 `lib/file-content.ts`：看文件头，不看有没有 NUL 字节。
 */
async function handleGET(request: NextRequest) {
  const rel = request.nextUrl.searchParams.get("path");
  if (!rel) return NextResponse.json({ error: "缺少 path 参数" }, { status: 400 });
  try {
    const abs = resolveWithinWorkspace(rel, workspaceRootForSession(request.nextUrl.searchParams.get("sessionId")));
    const st = await stat(abs);
    if (st.isDirectory()) return NextResponse.json({ error: "目标是目录" }, { status: 400 });

    if (st.size > MAX_BYTES) {
      // 超过上限时不再整份读：先看头一截。二进制就说「是二进制」——比「太大」
      // 准确（也省得用户为一份 PDF 去想办法「变小」）；否则仍然是「太大」。
      const head = await readHead(abs, HEAD_BYTES);
      if (looksBinaryHead(head)) {
        const verdict = classifyFileBytes(head);
        return NextResponse.json({
          path: rel,
          size: st.size,
          content: "",
          binary: true,
          mediaType: verdict.text ? null : verdict.mediaType,
        });
      }
      return NextResponse.json({ error: `文件过大（${Math.round(st.size / 1024)}KB > 512KB），请用终端查看` }, { status: 400 });
    }

    const buf = await readFile(abs);
    const verdict = classifyFileBytes(buf);
    if (!verdict.text) {
      return NextResponse.json({ path: rel, size: st.size, content: "", binary: true, mediaType: verdict.mediaType });
    }
    return NextResponse.json({ path: rel, size: st.size, content: buf.toString("utf8"), binary: false, mediaType: verdict.mediaType });
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
