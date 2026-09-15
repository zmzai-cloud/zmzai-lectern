import { withWorkflowErrors } from "@/lib/workflow-error";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NextResponse } from "next/server";

import { resolveWithinWorkspace } from "@/lib/paths";
import { workspaceRootForSession } from "@/lib/runtime";

const run = promisify(execFile);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type DiffFile = { path: string; additions: number; deletions: number; binary?: boolean };
export type GitDiff = { available: boolean; files: DiffFile[]; diff: string; truncated?: boolean };

const MAX_DIFF = 200_000;

/** 工作区未提交变更的 diff（产物侧「审查」Tab 数据源）。
 *  只读白名单：git diff HEAD（tracked 变更）；非 git 仓库降级 available:false。 */
async function handleGET(request: Request) {
  const search = new URL(request.url).searchParams;
  const cwd = resolveWithinWorkspace(null, workspaceRootForSession(search.get("sessionId")));
  const context = search.get("path") ?? "";
  try {
    const { stdout: numstat } = await run("git", ["diff", "HEAD", "--numstat"], { cwd, maxBuffer: 10 << 20 });
    const files: DiffFile[] = [];
    for (const line of numstat.split("\n")) {
      if (!line.trim()) continue;
      const [add, del, ...rest] = line.split("\t");
      const path = rest.join("\t");
      if (!path) continue;
      const display = path.includes(" => ") ? path.split(" => ").pop()! : path;
      files.push({
        path: display,
        additions: add === "-" ? 0 : Number(add),
        deletions: del === "-" ? 0 : Number(del),
        binary: add === "-",
      });
    }

    let diff = "";
    let truncated = false;
    if (context) {
      // 指定文件时返回该文件完整 diff（审查面板逐文件查看）
      const safePath = resolveWithinWorkspace(context, cwd).slice(cwd.length + 1);
      const { stdout } = await run("git", ["diff", "HEAD", "--", safePath], { cwd, maxBuffer: 10 << 20 });
      diff = stdout;
    } else {
      const { stdout } = await run("git", ["diff", "HEAD"], { cwd, maxBuffer: 10 << 20 });
      diff = stdout.length > MAX_DIFF ? stdout.slice(0, MAX_DIFF) : stdout;
      truncated = stdout.length > MAX_DIFF;
    }
    return NextResponse.json({ available: true, files, diff, truncated } satisfies GitDiff);
  } catch {
    return NextResponse.json({ available: false, files: [], diff: "" } satisfies GitDiff);
  }
}

export const GET = withWorkflowErrors(handleGET);
