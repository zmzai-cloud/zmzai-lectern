import { isSessionActive, notifyEventLogListeners } from "@zmzai/agent-framework";
import { resolveModel } from "./relay.js";
import { withRequestCookie } from "./request-cookie.js";
import { attachmentScopeFor, resolveAttachmentRefs } from "./attachments/scope.js";

/** 回溯重发（rewind）核心流（M2b-B3 自路由抽出，路由与 Host 共用）。
 *
 *  时序：守卫（运行/租约/排队/未结算）→ 取目标用户消息（文本/图片/附件）
 *  → truncateFrom + session.rewound 事件 → 以原消息环境重发 prompt →
 *  附件重绑新消息 id。模型上下文每轮由 rebuildMessages 现场重建，截断
 *  持久层即对下一轮生效。
 *
 *  返回值是数据（ok 或 {status,error,code}），HTTP 映射由调用方负责——
 *  Next 路由与 Host 命令端点各自包装。cookieHeader 为完整头形式
 *  （"muzhi_session=..."），Next 侧来自请求 cookie，Host 侧来自
 *  credentialRef 内存表。 */
export type RewindOutcome = { ok: true } | { ok: false; status: number; error: string; code?: string };

export async function executeRewind(input: {
  sessionId: string;
  messageId: string;
  text?: string;
  cookieHeader: string | null;
  runtime: {
    store: import("@zmzai/agent-framework").SessionStore & { eventLog?: unknown } & Record<string, unknown>;
    runner: { prompt(sessionId: string, input2: unknown): Promise<{ userMessageId?: string }> };
    eventLog: import("@zmzai/agent-framework").EventLog;
  };
}): Promise<RewindOutcome> {
  const { sessionId, messageId } = input;
  const runtime = input.runtime;
  const session = await runtime.store.getSession(sessionId);
  if (!session) return { ok: false, status: 404, error: "会话不存在" };
  if (isSessionActive(sessionId)) return { ok: false, status: 409, error: "会话正在运行，请先停止再回溯" };
  if (session.leaseOwner && session.leaseExpiresAt && Date.parse(session.leaseExpiresAt) > Date.now()) {
    return { ok: false, status: 409, error: "会话存在未恢复的运行租约，请稍后再试" };
  }
  if (session.queuedPrompts.length > 0) return { ok: false, status: 409, error: "会话有排队中的消息，请先停止再回溯" };
  const workflowRuns = (await runtime.store.workflow?.workflowRuns(sessionId)) ?? [];
  if (workflowRuns.some((run) => run.status === "queued" || run.status === "running" || run.status === "recovery_required")) {
    return { ok: false, status: 409, error: "会话存在未结算或待确认的任务，请先处理后再回溯" };
  }

  const entries = await runtime.store.getMessages(sessionId);
  const target = entries.find((entry) => entry.info.id === messageId);
  if (!target || target.info.role !== "user") return { ok: false, status: 404, error: "目标消息不存在或不是用户消息" };
  const selectedSkill = target.info.skill;
  const references = target.info.references;
  const originalText = target.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  const images = target.parts.filter((p) => p.type === "image").map((p) => ({ url: p.url, mediaType: p.mediaType }));
  const text = input.text?.trim() || originalText;
  // 旧链路历史：data URL part 原样透传（否则升级后无法重发老消息）
  const attachments = target.parts.flatMap((p) => {
    if (p.type !== "file") return [];
    const url = p.url;
    if (typeof url !== "string" || !url.startsWith("data:")) return [];
    return [{ name: p.filename, mediaType: p.mime, data: url, size: Buffer.from(url.slice(url.indexOf(",") + 1), "base64").length }];
  });
  // 新链路：复用 attachment id（规格 2 §11）；截断与重发之间用户可能已删数据，
  // 带失效 id 重发只会得到一条空消息——就绪性在此复查。
  const scope = attachmentScopeFor(sessionId);
  const resolved = resolveAttachmentRefs(scope, target.parts.flatMap((p) => (p.type === "file" && p.attachmentId ? [p.attachmentId] : [])));
  if (resolved.missing.length > 0) return { ok: false, status: 409, error: "原消息的附件已不可用，请重新添加后再发送", code: "not_found" };
  if (resolved.notReady.length > 0) return { ok: false, status: 409, error: "原消息的附件未就绪，请稍后重试", code: "not_ready" };
  const attachmentRefs = resolved.refs;
  if (!text && images.length === 0 && attachments.length === 0 && attachmentRefs.length === 0) {
    return { ok: false, status: 400, error: "消息不能为空" };
  }

  const store = runtime.store as { truncateFrom?(id: string, mid: string): Promise<void>; rewind?(id: string, mid: string): Promise<unknown> };
  if (!store.truncateFrom) return { ok: false, status: 500, error: "当前存储后端不支持回溯" };
  let rewound;
  if (store.rewind) rewound = await store.rewind(sessionId, messageId);
  else {
    await store.truncateFrom(sessionId, messageId);
    rewound = await runtime.eventLog.append({ type: "session.rewound", sessionId, data: { fromMessageId: messageId } });
  }
  notifyEventLogListeners(rewound as never);

  const model = await resolveModel(target.info.agent ?? "default", input.cookieHeader).catch(() => undefined);
  const result = await withRequestCookie(input.cookieHeader, () =>
    runtime.runner.prompt(sessionId, {
      text,
      agent: target.info.agent,
      ...(model ? { model } : {}),
      attachments,
      ...(attachmentRefs.length ? { attachmentRefs } : {}),
      ...(images.length > 0 ? { images } : {}),
      ...(selectedSkill ? { skill: selectedSkill } : {}),
      ...(references?.length ? { references } : {}),
    }),
  );
  // 附件重绑新用户消息：旧消息已随截断删除，不重绑会指向不存在的消息
  if (result.userMessageId) {
    for (const ref of attachmentRefs) scope.store.bind(ref.id, result.userMessageId, sessionId);
  }
  return { ok: true };
}
