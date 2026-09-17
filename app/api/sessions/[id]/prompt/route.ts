import { withWorkflowErrors, rethrowWorkflowError, WorkflowError } from "@/lib/workflow-error";
import { NextResponse, type NextRequest } from "next/server";

import { resolveModel, sessionCookieName } from "@/lib/relay";
import { sessionRuntime, workspaceRootForSession } from "@/lib/runtime";
import { withRequestCookie } from "@/lib/request-cookie";
import { generateSessionTitle } from "@/lib/session-title";
import { loadSkill } from "@/lib/skills";
import { attachmentScopeFor, resolveAttachmentRefs } from "@/lib/attachments/scope";
import { MAX_ATTACHMENT_REFS } from "@zmzai/agent-framework";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 推理力度档位（N3）：与 framework ThinkingEffort 对齐；off = 不发字段。 */
const EFFORTS = ["off", "minimal", "low", "medium", "high"] as const;
type Effort = (typeof EFFORTS)[number];

/**
 * 指纹要读的附件 id 串。
 *
 * 【为什么要认两种形状】客户端请求体里是 `attachmentIds`（只给 id），而 workflow
 * 里存下来的是 runner 的输入，那里叫 `attachmentRefs`（已解析的描述符）。只读
 * `attachmentIds` 的话，重发时拿到的永远是空数组，与请求体一比对就不相等 →
 * **带附件的消息只要重发（双击发送、超时重试）就返回 409「requestId 已用于不同的
 * 消息内容」**，而那条消息其实早就发出去了。用户看到的是一个凭空冒出来的错误。
 *
 * 两种形状里 id 的顺序都与请求体一致（`resolveAttachmentRefs` 按序解析），所以
 * 归一成一串 id 就能正确比较。
 */
function attachmentIdList(input: {
  attachmentIds?: readonly string[];
  attachmentRefs?: readonly { id: string }[];
}): readonly string[] {
  if (input.attachmentIds) return input.attachmentIds;
  return input.attachmentRefs?.map((ref) => ref.id) ?? [];
}

/**
 * 幂等指纹。**只含 attachment id，不含文件内容**——旧实现把整份 base64 写进指纹，
 * 一次发送会让 requestId 去重表里多存一份完整文件（规格 2 §18.5）。
 */
function requestShape(input: {
  text?: string; agent?: string; model?: { providerId: string; modelId: string };
  images?: readonly { url: string; mediaType: string }[]; effort?: string;
  skillId?: string; skill?: { id: string }; references?: readonly string[];
  attachmentIds?: readonly string[]; attachmentRefs?: readonly { id: string }[];
}, includeModel: boolean) {
  return JSON.stringify({
    text: input.text ?? "",agent: input.agent ?? null,model: includeModel ? input.model ?? null : null,
    images: input.images ?? [],effort: input.effort ?? null,skillId: input.skillId ?? input.skill?.id ?? null,
    references: input.references ?? [],attachmentIds: attachmentIdList(input),
  });
}

/** 发送提示词：进入 agent-framework runner，推理经 relay（cookie 透传）。
 *  附件只收 id（规格 2 §9.1），内容由附件存储持有并绑定到本条用户消息。 */
async function handlePOST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as {
    text?: string;
    agent?: string;
    model?: { providerId: string; modelId: string };
    images?: { url: string; mediaType: string }[];
    effort?: string;
    skillId?: string;
    references?: string[];
    requestId?: string;
    attachmentIds?: string[];
  } | null;
  const text = body?.text?.trim() ?? "";
  const effort = (EFFORTS as readonly string[]).includes(body?.effort ?? "") ? (body?.effort as Effort) : undefined;
  const images = (body?.images ?? []).filter(
    (im) => typeof im?.url === "string" && im.url.length > 0 && im.url.length < 8_000_000 && /^image\//.test(im.mediaType ?? ""),
  );
  const references = [...new Set((body?.references ?? []).filter((path): path is string => typeof path === "string" && path.length > 0 && path.length <= 1024 && !path.includes("\0")))].slice(0, 32);
  if (body?.requestId !== undefined && (typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId))) {
    throw new WorkflowError("INVALID_INPUT", "非法 requestId", 422);
  }
  const requestId = body?.requestId ?? randomUUID();

  // 附件 id → 描述符。归属校验在这里做（规格 §9.1 / §19：不接受任意 id）。
  const attachmentIds = [...new Set((body?.attachmentIds ?? []).filter((value): value is string => typeof value === "string" && value.length > 0))].slice(0, MAX_ATTACHMENT_REFS);
  const scope = attachmentScopeFor(id);
  const resolved = resolveAttachmentRefs(scope, attachmentIds);
  if (resolved.missing.length > 0) {
    return NextResponse.json({ error: "附件不存在、不属于该会话或已被清理，请重新添加", code: "not_found" }, { status: 422 });
  }
  if (resolved.notReady.length > 0) {
    return NextResponse.json({ error: "还有附件未就绪，请等待解析完成或重试失败的附件", code: "not_ready" }, { status: 409 });
  }
  const attachmentRefs = resolved.refs;

  if (!text && images.length === 0 && attachmentRefs.length === 0) {
    return NextResponse.json({ error: "消息不能为空" }, { status: 400 });
  }

  const cookie = request.cookies.get(sessionCookieName)?.value;
  const cookieHeader = cookie ? `${sessionCookieName}=${cookie}` : null;
  const runtime = sessionRuntime(id);
  const prior = await runtime.store.workflow?.findPrompt(id,requestId);
  if (prior) {
    const incoming = { text,agent: body?.agent,model: body?.model,images,effort,skillId: body?.skillId,references,attachmentIds };
    if (requestShape(incoming,body?.model !== undefined) !== requestShape(prior.input,body?.model !== undefined)) {
      throw new WorkflowError("CONFLICT","requestId 已用于不同的消息内容",409);
    }
    const replay = await withRequestCookie(cookieHeader,() => runtime.runner.prompt(id,prior.input));
    return NextResponse.json({ ...replay,requestId });
  }
  const model = body?.model ?? (await resolveModel(body?.agent, cookieHeader));
  const selected = body?.skillId ? loadSkill(workspaceRootForSession(id), body.skillId) : null;
  if (body?.skillId && !selected) return NextResponse.json({ error: "选中的 Skill 不存在、不可读取或超过大小限制" }, { status: 422 });

  // 自动标题（两段式）：①先落占位标题（首条消息摘要，立即生效不叫「新会话」）；
  // ②prompt 发出后异步调 LLM 生成 AI 摘要标题覆盖（见 lib/session-title.ts）。
  // 生成失败保留占位；用户已手动改名则不覆盖。
  // file-only 消息用文件名做标题种子，但正文不插入任何伪文字（规格 2 §7.5）。
  let autoTitleSeed: string | null = null;
  try {
    const ses = await runtime.store.getSession(id);
    if (ses && (!ses.title || ses.title === "新会话")) {
      const seed = text || (attachmentRefs.length ? attachmentRefs[0]!.name : images.length ? "[图片消息]" : "");
      if (seed) {
        autoTitleSeed = seed.replace(/\s+/g, " ").slice(0, 30);
        await runtime.store.updateSession(id, { title: autoTitleSeed });
      }
    }
  } catch {
    /* 占位标题失败不阻塞发送 */
  }

  try {
    const result = await withRequestCookie(cookieHeader, () =>
      runtime.runner.prompt(id, { requestId, text, agent: body?.agent, model, images, ...(attachmentRefs.length ? { attachmentRefs } : {}), ...(effort ? { effort } : {}), ...(references.length ? { references } : {}), ...(selected ? { skill: { id: selected.id, name: selected.name, digest: selected.digest } } : {}) }),
    );
    // 绑定：附件从「草稿」变成「已发送历史」，同时清除 TTL（规格 §9.2）。
    // 绑定失败不阻塞发送——消息已经落地，附件最多按草稿 TTL 被清理，
    // 而历史卡片对「blob 不可用」已有降级表现（规格 §12）。
    if (result.userMessageId) {
      for (const ref of attachmentRefs) scope.store.bind(ref.id, result.userMessageId, id);
    }
    // AI 摘要标题：后台生成不阻塞响应；仅当标题仍是占位时覆盖。
    // 显式带上本轮实际模型：runner 会在 runLoop 回写 session.model，但
    // 生成是异步的，传参不依赖回写时序，且 prompt 未落库时更可靠。
    if (autoTitleSeed && text) {
      void generateSessionTitle(runtime, id, text, model)
        .then((title) => {
          if (!title) return undefined;
          return runtime.store.getSession(id).then((ses) => {
            if (ses && ses.title === autoTitleSeed) return runtime.store.updateSession(id, { title });
            return undefined;
          });
        })
        .catch(() => undefined);
    }
    return NextResponse.json({ ...result, requestId });
  } catch (e) {
    if (e instanceof Error && e.message === "REQUEST_ID_REUSED") throw new WorkflowError("CONFLICT","requestId 已用于不同的消息内容",409);
    if (e instanceof Error && e.message === "RECOVERY_REQUIRED") throw new WorkflowError("RECOVERY_REQUIRED","上一任务的外部副作用尚未确认，请先核对后再继续",409);
    rethrowWorkflowError(e);
    const message = e instanceof Error ? e.message : "发送失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = withWorkflowErrors(handlePOST);
