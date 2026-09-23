import { hostGateway } from "@/lib/host-gateway";
import { withWorkflowErrors } from "@/lib/workflow-error";
import { type NextRequest, NextResponse } from "next/server";

import { sessionRuntime, workspaceRootForSession } from "@/lib/runtime";
import { discardSessionWorkspace, mergeSessionWorkspace } from "@/lib/workspace-actions";
import { worktreeCommits, worktreeForSession } from "@/lib/worktree";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** GET /api/sessions/[id]/worktree — 隔离副本状态（enabled/路径/分支/领先提交数）。 */
async function handleGET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gateway = await hostGateway(request as unknown as Request);
  if (gateway) return gateway;
  const { id } = await ctx.params;
  if (!SAFE_ID.test(id)) return NextResponse.json({ error: "非法会话 id" }, { status: 400 });
  workspaceRootForSession(id);
  const wt = worktreeForSession(id);
  if (!wt) return NextResponse.json({ enabled: false });
  const commits = await worktreeCommits(id);
  return NextResponse.json({ enabled: true, path: wt.path, branch: wt.branch, commits });
}

/** POST /api/sessions/[id]/worktree — 合并回目标分支（merge）或丢弃副本（discard）。
 *  W1-S27：写路径收敛进 WorkspaceService（交付门 + 整合序列 + 删序查返回码），
 *  旧 mergeWorktree（跟随主目录当前分支/成功即删目录）不再被调用。 */
async function handlePOST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!SAFE_ID.test(id)) return NextResponse.json({ error: "非法会话 id" }, { status: 400 });
  const body = (await request.json().catch(() => null)) as { action?: "merge" | "discard" } | null;
  if (body?.action !== "merge" && body?.action !== "discard") {
    return NextResponse.json({ error: "action 必须是 merge 或 discard" }, { status: 400 });
  }
  // 会话必须存在（防对陌生 id 误操作 git）
  const runtime = sessionRuntime(id);
  const existing = await runtime.store.getSession(id);
  if (!existing) return NextResponse.json({ error: "会话不存在" }, { status: 404 });

  const result = body.action === "merge"
    ? await mergeSessionWorkspace(id)
    : await discardSessionWorkspace(id);
  return NextResponse.json(result, { status: result.status });
}

export const GET = withWorkflowErrors(handleGET);
export const POST = withWorkflowErrors(handlePOST);
