import { withWorkflowErrors, rethrowWorkflowError } from "@/lib/workflow-error";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { resolveWithinWorkspace } from "@/lib/paths";
import { workspaceRootForSession } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type TreeNode = {
  name: string;
  type: "dir" | "file";
  size?: number;
  mtime: string;
};

/** 目录树懒加载默认跳过的目录（噪音大 + stat 成本高，@ 引用用不到）。 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "coverage",
  ".vercel",
]);

/** GET /api/fs/tree?path=src/lib — 列出工作区内某目录一层内容（懒加载目录树） */
async function handleGET(request: NextRequest) {
  const dir = request.nextUrl.searchParams.get("path") ?? "";
  const root = workspaceRootForSession(request.nextUrl.searchParams.get("sessionId"));
  try {
    const abs = resolveWithinWorkspace(dir, root);
    const entries = await readdir(abs, { withFileTypes: true });

    // 过滤 + 并行 stat：避免串行逐个系统调用拖慢大目录
    const visible = entries.filter(
      (e) =>
        !(e.name.startsWith(".") && e.name !== ".zmzai") &&
        !(e.isDirectory() && SKIP_DIRS.has(e.name)),
    );

    const nodes = await Promise.all(
      visible.map(async (e): Promise<TreeNode> => {
        const node: TreeNode = {
          name: e.name,
          type: e.isDirectory() ? "dir" : "file",
          mtime: "",
        };
        try {
          const st = await stat(join(abs, e.name));
          node.mtime = st.mtime.toISOString();
          if (e.isFile()) node.size = st.size;
          else if (e.isSymbolicLink()) node.type = "dir";
        } catch {
          // stat 失败（权限等）仍保留条目
        }
        return node;
      }),
    );

    // 目录在前，各自按名称排序
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return NextResponse.json({ path: dir, nodes });
  } catch (err) {
    rethrowWorkflowError(err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "读取目录失败" }, { status: 400 });
  }
}

export const GET = withWorkflowErrors(handleGET);
