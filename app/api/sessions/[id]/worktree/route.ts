import { hostGateway } from "@/lib/host-gateway";
import { withWorkflowErrors } from "@/lib/workflow-error";
import { type NextRequest, NextResponse } from "next/server";

import { sessionRuntime, workspaceRootForSession } from "@/lib/runtime";
import { mergeWorktree, removeWorktree, worktreeCommits, worktreeForSession } from "@/lib/worktree";

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

/** POST /api/sessions/[id]/worktree — 合并回主工作区（merge）或丢弃副本（discard）。 */
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

  if (body.action === "discard") {
    await removeWorktree(id);
    return NextResponse.json({ ok: true, output: "隔离副本已丢弃" });
  }
  const result = await mergeWorktree(id);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}

export const GET = withWorkflowErrors(handleGET);
export const POST = withWorkflowErrors(handlePOST);
