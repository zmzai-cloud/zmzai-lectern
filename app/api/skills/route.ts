import { withWorkflowErrors } from "@/lib/workflow-error";
import { NextResponse } from "next/server";
import { workspaceRootForSession } from "@/lib/runtime";
import { listSkills, loadSkill } from "@/lib/skills";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Lists metadata only; bodies require an explicit selected id. */
async function handleGET(request: Request) {
  const query = new URL(request.url).searchParams;
  const root = workspaceRootForSession(query.get("sessionId"));
  const id = query.get("id");
  if (id) {
    const skill = loadSkill(root, id);
    if (!skill) return NextResponse.json({ error: "Skill 不存在、不可读取或超过大小限制" }, { status: 404 });
    return NextResponse.json({ skill });
  }
  return NextResponse.json({ skills: listSkills(root) });
}

export const GET = withWorkflowErrors(handleGET);
