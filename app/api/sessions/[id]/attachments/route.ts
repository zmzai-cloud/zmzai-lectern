import { NextResponse, type NextRequest } from "next/server";

import { classifyFile } from "@/lib/attachments/classify";
import { extractAttachment, resumeStaleExtractions, scheduleExtraction } from "@/lib/attachments/extract/queue";
import { extractionKindFor } from "@/lib/attachments/extract";
import { ATTACHMENT_LIMITS, DRAFT_SESSION_ID } from "@/lib/attachments/limits";
import { attachmentScopeFor } from "@/lib/attachments/scope";
import { receiptOf } from "@/lib/attachments/store";
import { verifyContent } from "@/lib/attachments/sniff";
import { withWorkflowErrors } from "@/lib/workflow-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 规格 §9.1：`POST /api/sessions/:sessionId/attachments`（multipart/form-data）。
 *
 * 【为什么一次只收一个文件】规格 §7.4 要求每个附件独立显示上传/解析状态，
 * §14 要求「单文件重试」。批量上传要么共用一个响应（无法区分谁失败），要么
 * 在客户端拆成 N 个请求——那就等于逐文件上传。直接把协议定成逐文件，让
 * 取消（AbortController）和重试天然是单文件的。
 *
 * 【为什么服务端要重做一遍校验】客户端校验只为体验（尽早给出原因）；
 * 按规格 §19，服务端不得信任客户端的大小、文件名、MIME 与数量结论。
 */

const DRAFT = DRAFT_SESSION_ID;

async function handlePOST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const scope = attachmentScopeFor(id);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "请求不是合法的 multipart/form-data", code: "unsupported_format" }, { status: 400 });
  }
  const files = form.getAll("file").filter((entry): entry is File => typeof entry === "object" && entry !== null && "arrayBuffer" in entry);
  if (files.length === 0) return NextResponse.json({ error: "缺少 file 字段", code: "unsupported_format" }, { status: 400 });
  if (files.length > 1) return NextResponse.json({ error: "一次只能上传一个文件", code: "too_many" }, { status: 400 });
  const file = files[0]!;

  // ① 文件名净化 + 按扩展名归属格式（服务端独立判定，不看客户端结论）
  const classified = classifyFile({ name: file.name, type: file.type, size: file.size });
  if (!classified.ok) return NextResponse.json({ error: classified.error.message, code: classified.error.code }, { status: 422 });
  const { value } = classified;

  // ② 单文件大小（先用声明大小拦一道，避免为超大文件无谓读入内存）
  if (file.size > value.format.maxBytes) {
    return NextResponse.json(
      { error: `「${value.name}」超过 ${value.format.label} 的 ${Math.round(value.format.maxBytes / (1024 * 1024))}MB 上限`, code: "too_large" },
      { status: 413 },
    );
  }

  // ③ 数量与总量：只统计**未绑定消息**的附件（= 当前这条草稿）
  const unbound = scope.store.list(scope.sessionId).filter((record) => !record.messageId);
  if (unbound.length >= ATTACHMENT_LIMITS.maxLocalPerMessage) {
    return NextResponse.json({ error: `每条消息最多 ${ATTACHMENT_LIMITS.maxLocalPerMessage} 个附件`, code: "too_many" }, { status: 409 });
  }
  if (unbound.some((record) => record.filename === value.name && record.size === file.size)) {
    return NextResponse.json({ error: `「${value.name}」已在附件列表中`, code: "duplicate" }, { status: 409 });
  }
  const totalBytes = unbound.reduce((sum, record) => sum + record.size, 0) + file.size;
  if (totalBytes > ATTACHMENT_LIMITS.maxTotalBytesPerMessage) {
    return NextResponse.json(
      { error: `本条消息附件合计超过 ${Math.round(ATTACHMENT_LIMITS.maxTotalBytesPerMessage / (1024 * 1024))}MB 上限`, code: "total_too_large" },
      { status: 413 },
    );
  }

  // ④ 内容嗅探：扩展名与真实字节必须相容（规格 §6 / §13 / §17.2.10）
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) return NextResponse.json({ error: "文件为空", code: "empty_file" }, { status: 422 });
  if (bytes.byteLength > value.format.maxBytes) {
    return NextResponse.json({ error: `「${value.name}」实际大小超过上限`, code: "too_large" }, { status: 413 });
  }
  const verdict = verifyContent(value.format, bytes);
  if (!verdict.ok) return NextResponse.json({ error: verdict.message, code: verdict.code }, { status: 422 });

  // ⑤ 落库：二进制进内容寻址 blob，数据库只留元数据（规格 §9.2 / §19）
  const record = scope.store.put({
    sessionId: scope.sessionId,
    filename: value.name,
    mediaType: value.mediaType,
    sniffedMediaType: verdict.mediaType,
    kind: value.kind,
    bytes,
  });

  // ⑥ 解析：便宜路径在请求内做完，重活排后台（规格 §10.3 / §7.4）
  //
  // 【为什么分两条路径】文本/CSV 的提取是纯字符串处理（毫秒级），同步做完能让
  // 「拖进来立刻可发」。PDF/Office 要几秒到几十秒，放请求里会让用户对着没有反馈的
  // 进度条等、还会占住连接。分界的依据是**实测成本**，不是格式分类本身：
  // 图片与不解析正文的旧格式（extractor 为 null）也走同步路径，状态立刻定下来。
  const kind = extractionKindFor(value.name);
  if (kind === "text" || kind === "csv" || kind === "none") {
    await extractAttachment(scope.store, record.id);
  } else {
    scheduleExtraction(scope.store, record.id);
  }
  // 上一轮进程死在中途留下的 processing 记录在这里被重新排队（规格 §14）
  resumeStaleExtractions(scope.store);

  const settled = scope.store.get(record.id) ?? record;
  return NextResponse.json({ ok: true, attachment: receiptOf(settled) });
}

/** GET /api/sessions/:sessionId/attachments — 列出会话附件（草稿恢复与历史卡片共用）。 */
async function handleGET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const scope = attachmentScopeFor(id);
  resumeStaleExtractions(scope.store);
  return NextResponse.json({
    attachments: scope.store.list(scope.sessionId).map(receiptOf),
    scope: scope.sessionId === DRAFT ? "draft" : "session",
  });
}

export const POST = withWorkflowErrors(handlePOST);
export const GET = withWorkflowErrors(handleGET);
