import { withWorkflowErrors } from "@/lib/workflow-error";
import { NextResponse, type NextRequest } from "next/server";

import {
  getActiveAttempt,
  getDeliveryForSession,
  listCommandRuns,
  resolveOwner,
} from "@/lib/delivery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/deliveries?sessionId=xxx
 * 返回当前 session 的交付概览：delivery + active attempt + 命令记录。
 * owner 由 sessionId 在服务端推导，不接受客户端提交 projectId/root。
 */
async function handleGET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "缺少 sessionId" }, { status: 400 });

  const owner = resolveOwner(sessionId);
  if (!owner) return NextResponse.json({ error: "会话不存在或无法推导归属" }, { status: 404 });

  const delivery = getDeliveryForSession(sessionId);
  const attempt = delivery ? getActiveAttempt(delivery.id) : null;
  const runs = attempt ? listCommandRuns(attempt.id) : [];

  return NextResponse.json({
    delivery,
    attempt,
    runs,
  });
}

export const GET = withWorkflowErrors(handleGET);
