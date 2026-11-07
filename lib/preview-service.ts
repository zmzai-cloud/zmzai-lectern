import { withWorkflowErrors, rethrowWorkflowError } from './workflow-error.js';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { resolveWithinWorkspace } from './paths.js';
import { workspaceRootForSession } from './runtime.js';

/** 工作区成果预览服务（P0 2026-11-07 Host 迁移，route-ownership-matrix）：
 *  预览用真实 URL 而不是 srcDoc——HTML 中的 ./style.css 等相对资源继续落在
 *  同一路由下解析。sessionId 是路径的一部分，后续模块/样式/图片请求继续命中
 *  同一个隔离 worktree。PDF 与图片同样走这里（交给 Chromium 内建阅读器渲染，
 *  保留 Range 语义由后续按需补）。挂载路径：进程内 /api/preview/...（legacy）
 *  与 Host /v1/preview/...（armed）。 */

const MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
};

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const m = /^\/(?:api|v1)\/preview\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!m) return new Response('非法预览路径', { status: 400 });
  const sessionId = decodeURIComponent(m[1]!);
  const relativePath = decodeURIComponent(m[2] ?? '').replace(/^\//, '');
  const root = workspaceRootForSession(sessionId === '_' ? null : sessionId);

  try {
    const file = resolveWithinWorkspace(relativePath, root);
    const info = await stat(file);
    if (!info.isFile()) return new Response('目标不是文件', { status: 400 });

    const body = await readFile(file);
    const type = MIME_TYPES[extname(relativePath).toLowerCase()] ?? 'application/octet-stream';
    return new Response(body, {
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        'content-type': type,
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (cause) {
    rethrowWorkflowError(cause);
    return new Response(cause instanceof Error ? cause.message : '无法读取预览文件', { status: 404 });
  }
}

export const handlePreview = withWorkflowErrors(handle);
