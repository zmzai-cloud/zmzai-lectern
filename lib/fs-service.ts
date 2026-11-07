import { withWorkflowErrors, rethrowWorkflowError } from './workflow-error.js';
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import { classifyFileBytes, looksBinaryHead } from './file-content.js';
import { resolveWithinWorkspace } from './paths.js';
import { workspaceRootForSession } from './runtime.js';

/** 工作区文件面服务（P0 2026-11-07 Host 迁移，route-ownership-matrix）：
 *  file 读写（编辑器预览/保存）、search（⌘P 文件快开）、tree（目录树懒加载）。
 *  逻辑与原进程内 handler 同源；根目录按 sessionId 的持久归属解析
 *  （workspaceRootForSession：隔离会话落 worktree，不随 UI 切项目漂移）。
 *
 *  挂载路径：进程内 /api/fs/*（legacy）与 Host /v1/fs/*（armed）。 */

const MAX_BYTES = 512 * 1024;
const HEAD_BYTES = 8192;

type FsKind = 'file' | 'search' | 'tree';

function fsKindFromPath(pathname: string): FsKind | null {
  const m = /^\/(?:api|v1)\/fs\/(file|search|tree)$/.exec(pathname);
  return m ? (m[1] as FsKind) : null;
}

/** 只读文件头一截；用于「超过文本上限」的分支判断它到底是二进制还是单纯太大。 */
async function readHead(abs: string, bytes: number): Promise<Buffer> {
  const handle = await open(abs, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** GET file — 读取工作区内文件做文本预览（限 512KB）。
 *  【二进制不是错误】不是文本的文件照常返回 200，binary:true、content 空串；
 *  4xx 留给真正的失败（越界、目录、读不到）。判据见 lib/file-content.ts。 */
async function handleFileGET(url: URL): Promise<Response> {
  const rel = url.searchParams.get('path');
  if (!rel) return Response.json({ error: '缺少 path 参数' }, { status: 400 });
  try {
    const abs = resolveWithinWorkspace(rel, workspaceRootForSession(url.searchParams.get('sessionId')));
    const st = await stat(abs);
    if (st.isDirectory()) return Response.json({ error: '目标是目录' }, { status: 400 });

    if (st.size > MAX_BYTES) {
      const head = await readHead(abs, HEAD_BYTES);
      if (looksBinaryHead(head)) {
        const verdict = classifyFileBytes(head);
        return Response.json({
          path: rel,
          size: st.size,
          content: '',
          binary: true,
          mediaType: verdict.text ? null : verdict.mediaType,
        });
      }
      return Response.json({ error: `文件过大（${Math.round(st.size / 1024)}KB > 512KB），请用终端查看` }, { status: 400 });
    }

    const buf = await readFile(abs);
    const verdict = classifyFileBytes(buf);
    if (!verdict.text) {
      return Response.json({ path: rel, size: st.size, content: '', binary: true, mediaType: verdict.mediaType });
    }
    return Response.json({ path: rel, size: st.size, content: buf.toString('utf8'), binary: false, mediaType: verdict.mediaType });
  } catch (err) {
    rethrowWorkflowError(err);
    return Response.json({ error: err instanceof Error ? err.message : '读取文件失败' }, { status: 400 });
  }
}

/** PUT file — 编辑器保存回写（工作区内，限制同 GET）。 */
async function handleFilePUT(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { path?: string; content?: string; sessionId?: string } | null;
  const rel = body?.path;
  if (!rel || typeof body?.content !== 'string') {
    return Response.json({ error: '缺少 path 或 content 参数' }, { status: 400 });
  }
  try {
    const abs = resolveWithinWorkspace(rel, workspaceRootForSession(body.sessionId));
    if (Buffer.byteLength(body.content, 'utf8') > MAX_BYTES) {
      return Response.json({ error: '内容超过 512KB 限制' }, { status: 400 });
    }
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body.content, 'utf8');
    return Response.json({ ok: true, size: Buffer.byteLength(body.content, 'utf8') });
  } catch (err) {
    rethrowWorkflowError(err);
    return Response.json({ error: err instanceof Error ? err.message : '写入文件失败' }, { status: 400 });
  }
}

const SEARCH_DEPTH = 5;
const SEARCH_RESULTS = 40;
const SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.workspace']);
/** 同层并发 readdir 上限：并行能把大工作区的遍历耗时压下来，但无限并发会打满文件描述符。 */
const SEARCH_CONCURRENCY = 8;
/** 遍历节点总量上限：查询词生僻时仍可能扫完整棵树，兜住超大树避免请求挂死。 */
const SEARCH_MAX_NODES = 4000;

type Hit = { path: string; type: 'dir' | 'file'; depth: number };

/** GET search — 递归文件名搜索（分层并发 BFS，浅层文件先入结果）。 */
async function handleSearchGET(url: URL): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
  const root = resolveWithinWorkspace('', workspaceRootForSession(url.searchParams.get('sessionId')));
  const out: Hit[] = [];

  let frontier: { abs: string; rel: string }[] = [{ abs: root, rel: '' }];
  let visited = 0;

  for (let depth = 1; depth <= SEARCH_DEPTH && frontier.length > 0 && out.length < SEARCH_RESULTS; depth++) {
    const next: { abs: string; rel: string }[] = [];
    for (let i = 0; i < frontier.length; i += SEARCH_CONCURRENCY) {
      if (out.length >= SEARCH_RESULTS) break;
      const batch = frontier.slice(i, i + SEARCH_CONCURRENCY);
      await Promise.all(
        batch.map(async (node) => {
          if (out.length >= SEARCH_RESULTS || visited >= SEARCH_MAX_NODES) return;
          let entries: Dirent[];
          try {
            entries = await readdir(node.abs, { withFileTypes: true });
          } catch {
            return; // 权限不足或遍历期间被删除，跳过该目录
          }
          visited += entries.length;
          for (const e of entries) {
            if (out.length >= SEARCH_RESULTS) return;
            if (e.name.startsWith('.') && e.name !== '.zmzai') continue;
            const childRel = node.rel ? `${node.rel}/${e.name}` : e.name;
            if (!q || e.name.toLowerCase().includes(q)) {
              out.push({ path: childRel, type: e.isDirectory() ? 'dir' : 'file', depth });
            }
            if (e.isDirectory() && !SEARCH_SKIP_DIRS.has(e.name)) {
              next.push({ abs: path.join(node.abs, e.name), rel: childRel });
            }
          }
        }),
      );
    }
    frontier = next;
  }

  // 并发让同层内的到达顺序不确定，按 (深度, 路径) 稳定排序保证结果可复现。
  out.sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.path.localeCompare(b.path)));
  return Response.json({
    query: q,
    results: out.slice(0, SEARCH_RESULTS).map(({ path: p, type }) => ({ path: p, type })),
  });
}

/** 目录树懒加载默认跳过的目录（噪音大 + stat 成本高，@ 引用用不到）。 */
const TREE_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.vercel',
]);

type TreeNode = {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  mtime: string;
};

/** GET tree — 列出工作区内某目录一层内容（懒加载目录树）。 */
async function handleTreeGET(url: URL): Promise<Response> {
  const dir = url.searchParams.get('path') ?? '';
  const root = workspaceRootForSession(url.searchParams.get('sessionId'));
  try {
    const abs = resolveWithinWorkspace(dir, root);
    const entries = await readdir(abs, { withFileTypes: true });

    const visible = entries.filter(
      (e) =>
        !(e.name.startsWith('.') && e.name !== '.zmzai') &&
        !(e.isDirectory() && TREE_SKIP_DIRS.has(e.name)),
    );

    const nodes = await Promise.all(
      visible.map(async (e): Promise<TreeNode> => {
        const node: TreeNode = {
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          mtime: '',
        };
        try {
          const st = await stat(path.join(abs, e.name));
          node.mtime = st.mtime.toISOString();
          if (e.isFile()) node.size = st.size;
          else if (e.isSymbolicLink()) node.type = 'dir';
        } catch {
          // stat 失败（权限等）仍保留条目
        }
        return node;
      }),
    );

    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return Response.json({ path: dir, nodes });
  } catch (err) {
    rethrowWorkflowError(err);
    return Response.json({ error: err instanceof Error ? err.message : '读取目录失败' }, { status: 400 });
  }
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const kind = fsKindFromPath(url.pathname);
  if (!kind) return Response.json({ error: '未知的 fs 端点' }, { status: 404 });
  if (kind === 'file') {
    if (request.method === 'GET') return handleFileGET(url);
    if (request.method === 'PUT') return handleFilePUT(request);
    return Response.json({ error: '不支持的 method' }, { status: 405 });
  }
  if (request.method !== 'GET') return Response.json({ error: '不支持的 method' }, { status: 405 });
  return kind === 'search' ? handleSearchGET(url) : handleTreeGET(url);
}

export const handleFsRequest = withWorkflowErrors(handle);
