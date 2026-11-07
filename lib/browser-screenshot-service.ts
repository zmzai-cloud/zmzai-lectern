import { withWorkflowErrors } from './workflow-error.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { dataDir } from './runtime-constants.js';

/** 浏览器验证截图证据服务（V1-S6；P0 2026-11-07 Host 迁移）：
 *  ref 必须解析后落在 <dataDir>/browser-screenshots/ 之内（防目录穿越），
 *  文件不存在 404，非 png 后缀 400。挂载路径：进程内 /api/deliveries/browser-screenshot
 *  （legacy）与 Host /v1/browser-screenshot（armed）。 */
async function handle(request: Request): Promise<Response> {
  const ref = new URL(request.url).searchParams.get('ref') ?? '';
  const root = resolve(dataDir, 'browser-screenshots');
  const target = resolve(dataDir, ref);
  // 路径守卫：normalize 后必须仍在 browser-screenshots/ 下（../ 与绝对路径都拒绝）
  if (!target.startsWith(root + sep) || !target.endsWith('.png')) {
    return Response.json({ error: '非法截图引用' }, { status: 400 });
  }
  if (!existsSync(target)) {
    return Response.json({ error: '截图不存在' }, { status: 404 });
  }
  const bytes = readFileSync(target);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' },
  });
}

export const handleBrowserScreenshot = withWorkflowErrors(handle);
