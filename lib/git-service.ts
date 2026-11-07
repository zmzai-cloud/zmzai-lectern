import { withWorkflowErrors, rethrowWorkflowError } from './workflow-error.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveWithinWorkspace } from './paths.js';
import { workspaceRootForSession } from './runtime.js';

/** 工作区 git 面服务（P0 2026-11-07 Host 迁移，route-ownership-matrix）：
 *  checkpoint 快照列表/打快照/回滚与 diff（未提交变更审查）。
 *  逻辑与原进程内 handler 同源；cwd 按 sessionId 持久归属解析。
 *  挂载路径：进程内 /api/git/*（legacy）与 Host /v1/git/*（armed）。 */

const run = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

const MARKER = 'harness-checkpoint:';

function gitKindFromPath(pathname: string): 'checkpoint' | 'diff' | null {
  const m = /^\/(?:api|v1)\/git\/(checkpoint|diff)$/.exec(pathname);
  return m ? (m[1] as 'checkpoint' | 'diff') : null;
}

/** GET checkpoint — 列出检查点（时间倒序，含当前 HEAD 以判断可回滚范围）。 */
async function handleCheckpointGET(url: URL): Promise<Response> {
  try {
    const sessionId = url.searchParams.get('sessionId');
    const cwd = workspaceRootForSession(sessionId);
    const log = await git(['log', '--format=%H%x00%ct%x00%s', `-n`, `30`], cwd).catch(() => '');
    const points = log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, ts, subject] = line.split('\0');
        return { hash, time: new Date(Number(ts) * 1000).toISOString(), subject, checkpoint: subject.includes(MARKER) };
      });
    return Response.json({ points });
  } catch (err) {
    rethrowWorkflowError(err);
    return Response.json({ error: err instanceof Error ? err.message : '读取检查点失败' }, { status: 400 });
  }
}

/** POST checkpoint — 打快照：工作区当前状态 commit 为检查点（无变更则跳过）。 */
async function handleCheckpointPOST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { label?: string; sessionId?: string } | null;
  const label = body?.label?.trim() || '任务前快照';
  try {
    const cwd = workspaceRootForSession(body?.sessionId);
    // 非 git 仓库时给明确错误（UI 引导 git init，不擅自初始化）
    await git(['rev-parse', '--git-dir'], cwd);
    await git(['add', '-A'], cwd);
    const dirty = (await git(['status', '--porcelain'], cwd)).length > 0;
    if (!dirty) return Response.json({ ok: true, skipped: true, reason: '工作区无变更，无需快照' });
    const out = await git(['commit', '-m', `${MARKER} ${label}`, '--allow-empty-message', '--no-verify'], cwd);
    const hash = await git(['rev-parse', '--short', 'HEAD'], cwd);
    return Response.json({ ok: true, hash, detail: out.split('\n')[0] });
  } catch (err) {
    rethrowWorkflowError(err);
    return Response.json({ error: err instanceof Error ? err.message : '创建快照失败' }, { status: 400 });
  }
}

/** PUT checkpoint — 回滚到指定检查点（硬回滚，UI 侧需二次确认）。 */
async function handleCheckpointPUT(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { hash?: string; sessionId?: string } | null;
  const hash = body?.hash?.trim();
  if (!hash || !/^[0-9a-f]{4,40}$/i.test(hash)) {
    return Response.json({ error: '缺少合法的 hash' }, { status: 400 });
  }
  try {
    const cwd = workspaceRootForSession(body?.sessionId);
    await git(['reset', '--hard', hash], cwd);
    // 未跟踪文件一并清掉，保证真正回到快照时刻的工作区
    await git(['clean', '-fd'], cwd).catch(() => undefined);
    return Response.json({ ok: true, hash });
  } catch (err) {
    rethrowWorkflowError(err);
    return Response.json({ error: err instanceof Error ? err.message : '回滚失败' }, { status: 400 });
  }
}

export type DiffFile = { path: string; additions: number; deletions: number; binary?: boolean };
export type GitDiff = { available: boolean; files: DiffFile[]; diff: string; truncated?: boolean };

const MAX_DIFF = 200_000;

/** GET diff — 工作区未提交变更的 diff（产物侧「审查」Tab 数据源）。
 *  只读白名单：git diff HEAD（tracked 变更）；非 git 仓库降级 available:false。 */
async function handleDiffGET(url: URL): Promise<Response> {
  const sessionId = url.searchParams.get('sessionId');
  const cwd = resolveWithinWorkspace(null, workspaceRootForSession(sessionId));
  const context = url.searchParams.get('path') ?? '';
  try {
    const { stdout: numstat } = await run('git', ['diff', 'HEAD', '--numstat'], { cwd, maxBuffer: 10 << 20 });
    const files: DiffFile[] = [];
    for (const line of numstat.split('\n')) {
      if (!line.trim()) continue;
      const [add, del, ...rest] = line.split('\t');
      const path = rest.join('\t');
      if (!path) continue;
      const display = path.includes(' => ') ? path.split(' => ').pop()! : path;
      files.push({
        path: display,
        additions: add === '-' ? 0 : Number(add),
        deletions: del === '-' ? 0 : Number(del),
        binary: add === '-',
      });
    }

    let diff = '';
    let truncated = false;
    if (context) {
      // 指定文件时返回该文件完整 diff（审查面板逐文件查看）
      const safePath = resolveWithinWorkspace(context, cwd).slice(cwd.length + 1);
      const { stdout } = await run('git', ['diff', 'HEAD', '--', safePath], { cwd, maxBuffer: 10 << 20 });
      diff = stdout;
    } else {
      const { stdout } = await run('git', ['diff', 'HEAD'], { cwd, maxBuffer: 10 << 20 });
      diff = stdout.length > MAX_DIFF ? stdout.slice(0, MAX_DIFF) : stdout;
      truncated = stdout.length > MAX_DIFF;
    }
    return Response.json({ available: true, files, diff, truncated } satisfies GitDiff);
  } catch {
    return Response.json({ available: false, files: [], diff: '' } satisfies GitDiff);
  }
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const kind = gitKindFromPath(url.pathname);
  if (!kind) return Response.json({ error: '未知的 git 端点' }, { status: 404 });
  if (kind === 'diff') {
    if (request.method !== 'GET') return Response.json({ error: '不支持的 method' }, { status: 405 });
    return handleDiffGET(url);
  }
  if (request.method === 'GET') return handleCheckpointGET(url);
  if (request.method === 'POST') return handleCheckpointPOST(request);
  if (request.method === 'PUT') return handleCheckpointPUT(request);
  return Response.json({ error: '不支持的 method' }, { status: 405 });
}

export const handleGitRequest = withWorkflowErrors(handle);
