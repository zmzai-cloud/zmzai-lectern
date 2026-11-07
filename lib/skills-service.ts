import { withWorkflowErrors } from './workflow-error.js';

import { workspaceRootForSession } from './runtime.js';
import { listSkills, loadSkill } from './skills.js';

/** Skill 列表/加载服务（P0 2026-11-07 Host 迁移，route-ownership-matrix）：
 *  列表只给元数据；正文需显式 id。根目录按 sessionId 持久归属解析。
 *  挂载路径：进程内 /api/skills（legacy）与 Host /v1/skills（armed）。 */
async function handle(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const root = workspaceRootForSession(query.get('sessionId'));
  const id = query.get('id');
  if (id) {
    const skill = loadSkill(root, id);
    if (!skill) return Response.json({ error: 'Skill 不存在、不可读取或超过大小限制' }, { status: 404 });
    return Response.json({ skill });
  }
  return Response.json({ skills: listSkills(root) });
}

export const handleSkills = withWorkflowErrors(handle);
