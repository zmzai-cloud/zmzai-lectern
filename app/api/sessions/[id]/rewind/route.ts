import { NextResponse, type NextRequest } from "next/server";

import { isSessionActive, notifyEventLogListeners } from "@zmzai/agent-framework";

import { resolveModel, sessionCookieName } from "@/lib/relay";
import { sessionRuntime } from "@/lib/runtime";
import { withRequestCookie } from "@/lib/request-cookie";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 回溯重发（rewind）：删除目标用户消息及其后的全部消息，再以（可编辑后的）
 *  文本重新发送一次 prompt。模型上下文每轮 run 由 rebuildMessages 从 store
 *  现场重建，截断持久层即对下一轮生效。
 *
 *  时序：truncateFrom → eventLog 落 session.rewound（SSE 推送，订阅端投影
 *  裁掉其后状态；重放场景下「旧事件 → rewound → 新 run 事件」最终态正确）
 *  → runner.prompt 走标准管道（消息落库/事件流/UI 增量渲染全部复用）。
 *  图片附件原样透传；agent/model 取原消息所用值，保证重跑环境一致。 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as { messageId?: string; text?: string } | null;
  const messageId = body?.messageId;
  if (!messageId) {
    return NextResponse.json({ error: "缺少 messageId" }, { status: 400 });
  }

  const runtime = sessionRuntime(id);
  const session = await runtime.store.getSession(id);
  if (!session) {
    return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  }
  // 守卫：运行中 / 租约未清（崩溃恢复前）/ 有排队 prompt，都不允许截断
  if (isSessionActive(id)) {
    return NextResponse.json({ error: "会话正在运行，请先停止再回溯" }, { status: 409 });
  }
  if (session.leaseOwner && session.leaseExpiresAt && Date.parse(session.leaseExpiresAt) > Date.now()) {
    return NextResponse.json({ error: "会话存在未恢复的运行租约，请稍后再试" }, { status: 409 });
  }
  if (session.queuedPrompts.length > 0) {
    return NextResponse.json({ error: "会话有排队中的消息，请先停止再回溯" }, { status: 409 });
  }

  const entries = await runtime.store.getMessages(id);
  const target = entries.find((entry) => entry.info.id === messageId);
  if (!target || target.info.role !== "user") {
    return NextResponse.json({ error: "目标消息不存在或不是用户消息" }, { status: 404 });
  }
  const selectedSkill = target.info.skill;
  const references = target.info.references;
  const originalText = target.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  const images = target.parts
    .filter((p) => p.type === "image")
    .map((p) => ({ url: p.url, mediaType: p.mediaType }));
  const text = body?.text?.trim() || originalText;
  const attachments = target.parts.filter((p) => p.type === "file" && p.url.startsWith("data:")).map((p) => {
    if (p.type !== "file") throw new Error("Invalid attachment");
    return { name: p.filename, mediaType: p.mime, data: p.url, size: Buffer.from(p.url.slice(p.url.indexOf(",") + 1), "base64").length };
  });
  if (!text && images.length === 0 && attachments.length === 0) {
    return NextResponse.json({ error: "消息不能为空" }, { status: 400 });
  }

  try {
    if (!runtime.store.truncateFrom) {
      return NextResponse.json({ error: "当前存储后端不支持回溯" }, { status: 500 });
    }
    await runtime.store.truncateFrom(id, messageId);

    const rewound = await runtime.eventLog.append({
      type: "session.rewound",
      sessionId: id,
      data: { fromMessageId: messageId },
    });
    notifyEventLogListeners(rewound);

    const cookie = request.cookies.get(sessionCookieName)?.value;
    const cookieHeader = cookie ? `${sessionCookieName}=${cookie}` : null;
    const model = await resolveModel(target.info.agent, cookieHeader);
    await withRequestCookie(cookieHeader, () =>
      runtime.runner.prompt(id, {
        text,
        agent: target.info.agent,
        model,
        attachments,
        ...(images.length > 0 ? { images } : {}),
        ...(selectedSkill ? { skill: selectedSkill } : {}),
        ...(references?.length ? { references } : {}),
      }),
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "回溯失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
