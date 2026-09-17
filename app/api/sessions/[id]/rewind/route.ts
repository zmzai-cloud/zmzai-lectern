import { withWorkflowErrors, rethrowWorkflowError } from "@/lib/workflow-error";
import { NextResponse, type NextRequest } from "next/server";

import { isSessionActive, notifyEventLogListeners } from "@zmzai/agent-framework";

import { resolveModel, sessionCookieName } from "@/lib/relay";
import { sessionRuntime } from "@/lib/runtime";
import { withRequestCookie } from "@/lib/request-cookie";
import { attachmentScopeFor, resolveAttachmentRefs } from "@/lib/attachments/scope";

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
async function handlePOST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
  const workflowRuns = await runtime.store.workflow?.workflowRuns(id) ?? [];
  if (workflowRuns.some(run => run.status === "queued" || run.status === "running" || run.status === "recovery_required")) {
    return NextResponse.json({ error: "会话存在未结算或待确认的任务，请先处理后再回溯" }, { status: 409 });
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
  // 旧链路历史：data URL part 原样透传（否则升级后无法重发老消息）
  const attachments = target.parts.flatMap((p) => {
    if (p.type !== "file") return [];
    const url = p.url;
    if (typeof url !== "string" || !url.startsWith("data:")) return [];
    return [{ name: p.filename, mediaType: p.mime, data: url, size: Buffer.from(url.slice(url.indexOf(",") + 1), "base64").length }];
  });
  // 新链路：**复用** attachment id，不重新上传（规格 2 §11）。这里再次确认附件仍存在且
  // 就绪——截断与重发之间用户可能已经删过会话数据，带着失效 id 重发只会得到一条空消息。
  const scope = attachmentScopeFor(id);
  const resolved = resolveAttachmentRefs(scope, target.parts.flatMap((p) => (p.type === "file" && p.attachmentId ? [p.attachmentId] : [])));
  if (resolved.missing.length > 0) {
    return NextResponse.json({ error: "原消息的附件已不可用，请重新添加后再发送", code: "not_found" }, { status: 409 });
  }
  // 未就绪的也要挡住，理由与 prompt 路由一致：`refs` 里只有就绪的那些，放过去
  // 等于**静默丢掉**这个附件——用户看到的是一条少了一个文件的重发消息，而没有任何提示。
  if (resolved.notReady.length > 0) {
    return NextResponse.json({ error: "原消息的附件未就绪，请稍后重试", code: "not_ready" }, { status: 409 });
  }
  const attachmentRefs = resolved.refs;
  if (!text && images.length === 0 && attachments.length === 0 && attachmentRefs.length === 0) {
    return NextResponse.json({ error: "消息不能为空" }, { status: 400 });
  }

  try {
    if (!runtime.store.truncateFrom) {
      return NextResponse.json({ error: "当前存储后端不支持回溯" }, { status: 500 });
    }
    let rewound;
    if (runtime.store.rewind) rewound = await runtime.store.rewind(id,messageId);
    else {
      await runtime.store.truncateFrom(id,messageId);
      rewound = await runtime.eventLog.append({ type: "session.rewound",sessionId: id,data: { fromMessageId: messageId } });
    }
    notifyEventLogListeners(rewound);

    const cookie = request.cookies.get(sessionCookieName)?.value;
    const cookieHeader = cookie ? `${sessionCookieName}=${cookie}` : null;
    const model = await resolveModel(target.info.agent, cookieHeader);
    const result = await withRequestCookie(cookieHeader, () =>
      runtime.runner.prompt(id, {
        text,
        agent: target.info.agent,
        model,
        attachments,
        ...(attachmentRefs.length ? { attachmentRefs } : {}),
        ...(images.length > 0 ? { images } : {}),
        ...(selectedSkill ? { skill: selectedSkill } : {}),
        ...(references?.length ? { references } : {}),
      }),
    );
    // 重新绑定到新的用户消息：旧消息已随截断删除，不重绑的话附件会一直指向
    // 一条不存在的消息，既不会被清理也不会跟新的历史卡片对上。
    if (result.userMessageId) {
      for (const ref of attachmentRefs) scope.store.bind(ref.id, result.userMessageId, id);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    rethrowWorkflowError(e);
    const message = e instanceof Error ? e.message : "回溯失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = withWorkflowErrors(handlePOST);
