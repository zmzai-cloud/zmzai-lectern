import { withWorkflowErrors } from './workflow-error.js';

import { cloudRuntime } from './runtime.js';
import { getActiveProject, listProjects, projectStore } from './projects.js';

/** 会话全文搜索服务（跨项目；P0 2026-11-07 Host 迁移，route-ownership-matrix）：
 *  遍历各会话转录做子串匹配（个人规模 LIKE 级足够；数据量到秒级再升级 FTS5），
 *  返回命中会话 + 摘要片段，每会话取第一个命中，总量上限 30。
 *  挂载路径：进程内 /api/sessions/search（legacy）与 Host /v1/session-search（armed）。 */
async function handle(request: Request): Promise<Response> {
  const q = (new URL(request.url).searchParams.get('q') ?? '').trim();
  if (!q) return Response.json({ query: q, results: [] });

  const runtime = cloudRuntime();
  const active = getActiveProject();
  const needle = q.toLowerCase();
  const results: { projectId: string; projectName: string; sessionId: string; title: string; snippet: string; updatedAt?: string }[] = [];

  for (const project of listProjects()) {
    if (results.length >= 30) break;
    let store;
    let sessions;
    try {
      store = project.id === active.id ? runtime.store : projectStore(project.id);
      sessions = await store.listSessions({ userId: 'local', workspaceId: 'local' });
    } catch {
      // A damaged or unavailable project must not hide other project results.
      continue;
    }
    for (const s of sessions) {
      let messages;
      try {
        messages = await store.getMessages(s.id);
      } catch {
        continue; // 单会话读取失败不阻塞整体
      }
      for (const m of messages) {
        const text = m.parts
          .map((p) => {
            if (p.type === 'text') return p.text;
            if (p.type === 'tool' && p.state.status === 'completed') return `${p.tool} ${p.state.title ?? ''}`;
            return '';
          })
          .join('\n');
        const idx = text.toLowerCase().indexOf(needle);
        if (idx < 0) continue;
        // 摘要：命中行前后各 60 字符
        const lineStart = text.lastIndexOf('\n', idx) + 1;
        const lineEnd = text.indexOf('\n', idx + q.length);
        const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim();
        const start = Math.max(0, idx - 60);
        const snippet = (start > 0 ? '…' : '') + text.slice(start, idx + q.length + 60).replace(/\s+/g, ' ') + (idx + q.length + 60 < text.length ? '…' : '');
        results.push({ projectId: project.id, projectName: project.name, sessionId: s.id, title: s.title || '未命名会话', snippet: line.length > 0 && line.length < 200 ? line : snippet, updatedAt: s.time?.updated });
        break; // 每会话取第一个命中
      }
      if (results.length >= 30) break; // 上限防长尾
    }
  }

  return Response.json({ query: q, results });
}

export const handleSessionGlobalSearch = withWorkflowErrors(handle);
