import { withWorkflowErrors } from './workflow-error.js';

import { installPluginFromPath, listPlugins, uninstallPlugin } from './plugins.js';
import { mcpRescan } from './runtime.js';
import { workspaceRootFromProjectParam } from './project-scope.js';

/** 插件服务（P1 插件；P0 2026-11-07 Host 迁移，route-ownership-matrix）：
 *  GET 列已安装插件（全局 + 项目级），POST 安装/卸载并重扫该项目 MCP。
 *  项目在网关入口固定为 projectId 查询参数（异步流程前捕获）；无参数=活动项目
 *  （legacy 进程内路径）。挂载路径：进程内 /api/plugins 与 Host /v1/plugins。 */
async function handle(request: Request): Promise<Response> {
  const workspaceRoot = workspaceRootFromProjectParam(new URL(request.url));
  if (request.method === 'GET') {
    return Response.json({ plugins: listPlugins(workspaceRoot) });
  }
  if (request.method !== 'POST') return Response.json({ error: '不支持的 method' }, { status: 405 });

  const body = (await request.json().catch(() => ({}))) as { sourcePath?: string; action?: string; name?: string };
  if (body.action === 'uninstall' && body.name) {
    const removed = uninstallPlugin(body.name, workspaceRoot);
    if (removed) await mcpRescan(workspaceRoot).catch(() => undefined);
    return Response.json({ ok: removed, ...(removed ? {} : { error: '项目级插件不存在' }) });
  }

  if (!body.sourcePath) {
    return Response.json({ error: '缺少 sourcePath（本地插件目录）' }, { status: 400 });
  }
  const result = installPluginFromPath(body.sourcePath, workspaceRoot);
  if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
  // 安装后自动重扫 MCP（插件的 mcpServers 即刻生效）
  await mcpRescan(workspaceRoot).catch(() => undefined);
  return Response.json({ ok: true, plugin: result.plugin });
}

export const handlePlugins = withWorkflowErrors(handle);
