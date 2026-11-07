import { withWorkflowErrors } from './workflow-error.js';
import { renderRepoMap } from '@zmzai/agent-framework';

import { workspaceRootFromProjectParam } from './project-scope.js';
import { repoMapVendorDirs } from './repomap-vendor.js';

/** 项目地图服务（R1；P0 2026-11-07 Host 迁移，route-ownership-matrix）：
 *  直接调 framework 的 renderRepoMap，返回地图文本 + 统计；与 agent 的
 *  repo_map 工具同源同缓存。项目在网关入口固定为 projectId 查询参数；无参数=
 *  活动项目（legacy 进程内路径）。挂载路径：进程内 /api/repomap 与 Host /v1/repomap。 */
async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const root = workspaceRootFromProjectParam(url);
  const focus = url.searchParams.get('focus') ?? undefined;
  const paths = url.searchParams.get('paths')?.split(',').filter(Boolean);
  const tokenBudgetRaw = url.searchParams.get('tokenBudget');
  const tokenBudget = tokenBudgetRaw ? Number(tokenBudgetRaw) : undefined;

  // 被 bundler 打进产物时包内相对定位 wasm 必失败，必须显式注入真实资源目录；
  // 目录核对不到就如实不可用——绝不带着错误目录去加载（emscripten 失败会结束进程）
  const vendorDirs = repoMapVendorDirs();
  if (!vendorDirs) {
    return Response.json({ ok: false, error: '仓库地图不可用：找不到 tree-sitter wasm 资源' }, { status: 503 });
  }
  try {
    const result = await renderRepoMap({
      root,
      focus: focus || undefined,
      paths: paths?.length ? paths : undefined,
      tokenBudget: Number.isFinite(tokenBudget) && tokenBudget! >= 256 ? tokenBudget : undefined,
      vendorDirs,
    });
    return Response.json({ ok: true, text: result.text, stats: result.stats });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : '生成仓库地图失败' },
      { status: 500 },
    );
  }
}

export const handleRepomap = withWorkflowErrors(handle);
