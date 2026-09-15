import { withWorkflowErrors, rethrowWorkflowError } from "@/lib/workflow-error";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import { resolveWithinWorkspace } from "@/lib/paths";
import { workspaceRootForSession } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
};

/**
 * 工作区成果文件服务。
 *
 * 预览用真实 URL 而不是 srcDoc：HTML 中的 `./style.css`、`../src/index.js`
 * 等相对资源会继续落在这个路由下，因而能像普通静态站点一样解析。sessionId
 * 是路径的一部分，后续模块/样式/图片请求会继续命中同一个隔离 worktree。
 */
async function handleGET(
  _request: Request,
  ctx: { params: Promise<{ sessionId: string; filePath: string[] }> },
) {
  const { sessionId, filePath } = await ctx.params;
  const relativePath = filePath.join("/");
  const root = workspaceRootForSession(sessionId === "_" ? null : sessionId);

  try {
    const file = resolveWithinWorkspace(relativePath, root);
    const info = await stat(file);
    if (!info.isFile()) return new Response("目标不是文件", { status: 400 });

    const body = await readFile(file);
    const type = MIME_TYPES[extname(relativePath).toLowerCase()] ?? "application/octet-stream";
    return new Response(body, {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
        "content-type": type,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (cause) {
    rethrowWorkflowError(cause);
    return new Response(cause instanceof Error ? cause.message : "无法读取预览文件", { status: 404 });
  }
}

export const GET = withWorkflowErrors(handleGET);
