import { withWorkflowErrors } from "@/lib/workflow-error";
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { resolveWithinWorkspace } from "@/lib/paths";
import { workspaceRootForSession } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_DEPTH = 5;
const MAX_RESULTS = 40;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".workspace"]);
/** 同层并发 readdir 上限：并行能把大工作区的遍历耗时压下来，但无限并发会打满文件描述符。 */
const CONCURRENCY = 8;
/** 遍历节点总量上限：查询词生僻时仍可能扫完整棵树，兜住超大树避免请求挂死。 */
const MAX_NODES = 4000;

type Hit = { path: string; type: "dir" | "file"; depth: number };

/** GET /api/fs/search?q=main — 递归文件名搜索（⌘P 文件快开，限深限噪）。 */
async function handleGET(request: NextRequest) {
  const q = (request.nextUrl.searchParams.get("q") ?? "").toLowerCase();
  const root = resolveWithinWorkspace("", workspaceRootForSession(request.nextUrl.searchParams.get("sessionId")));
  const out: Hit[] = [];

  // 广度优先逐层推进，同层内并发 readdir。旧实现是深度优先 + 循环内 await，
  // 每个子目录都要等前一个递归走完，大工作区下耗时被逐层累加；改为分层并发后
  // 同层耗时近似等于最慢的一个目录。附带好处：浅层文件先入结果，更贴近 ⌘P 直觉。
  let frontier: { abs: string; rel: string }[] = [{ abs: root, rel: "" }];
  let visited = 0;

  for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0 && out.length < MAX_RESULTS; depth++) {
    const next: { abs: string; rel: string }[] = [];
    for (let i = 0; i < frontier.length; i += CONCURRENCY) {
      if (out.length >= MAX_RESULTS) break;
      const batch = frontier.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (node) => {
          if (out.length >= MAX_RESULTS || visited >= MAX_NODES) return;
          let entries: Dirent[];
          try {
            entries = await readdir(node.abs, { withFileTypes: true });
          } catch {
            return; // 权限不足或遍历期间被删除，跳过该目录
          }
          visited += entries.length;
          for (const e of entries) {
            if (out.length >= MAX_RESULTS) return;
            if (e.name.startsWith(".") && e.name !== ".zmzai") continue;
            const childRel = node.rel ? `${node.rel}/${e.name}` : e.name;
            if (!q || e.name.toLowerCase().includes(q)) {
              out.push({ path: childRel, type: e.isDirectory() ? "dir" : "file", depth });
            }
            if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
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
  return NextResponse.json({
    query: q,
    results: out.slice(0, MAX_RESULTS).map(({ path: p, type }) => ({ path: p, type })),
  });
}

export const GET = withWorkflowErrors(handleGET);
