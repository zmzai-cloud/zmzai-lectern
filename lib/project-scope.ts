import { WorkflowError } from './workflow-error.js';
import { activeWorkspaceRoot } from './runtime.js';
import { registeredProjects } from './projects.js';

/** P0 收口（route-ownership-matrix）：项目级路由（plugins/repomap 等）在网关
 *  入口把 active 项目固定成 projectId 查询参数（异步流程开始前捕获，spec
 *  2026-09-28 §4.3「用户切换 UI 项目不改变在途任务归属」）。Host 服务侧按
 *  该参数解析项目根；未知项目 404，不静默回落当前项目。
 *
 *  无 projectId（legacy 进程内路径/旧客户端）= 活动项目。 */
export function workspaceRootFromProjectParam(url: URL): string {
  const projectId = url.searchParams.get('projectId');
  if (!projectId) return activeWorkspaceRoot();
  const project = registeredProjects().find((p) => p.id === projectId);
  if (!project) throw new WorkflowError('NOT_FOUND', '项目不存在', 404);
  return project.path;
}
