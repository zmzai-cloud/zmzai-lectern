import { hostGateway } from "@/lib/host-gateway";
import { NextResponse, type NextRequest } from "next/server";
import { Readable } from "node:stream";

import { attachmentScopeFor } from "@/lib/attachments/scope";
import { receiptOf } from "@/lib/attachments/store";
import { withWorkflowErrors } from "@/lib/workflow-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 单个附件：读取元数据、下载/预览原始文件、删除未绑定附件（规格 §9.1 / §13）。 */

/** 可作为 `inline` 返回的类型：浏览器能安全地「就地展示」。
 *  文本/HTML/SVG 一律走 `attachment`，配合 CSP sandbox 避免在应用 origin 上执行（§13）。 */
const INLINE_TYPES = /^(image\/(png|jpeg|webp|gif)|application\/pdf)$/;

/** ASCII 回退名 + RFC 5987 UTF-8 名（中文文件名在多数浏览器里靠后者）。 */
function contentDisposition(filename: string, disposition: "inline" | "attachment"): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function handleGET(request: NextRequest, ctx: { params: Promise<{ id: string; attachmentId: string }> }) {
  const gateway = await hostGateway(request as unknown as Request);
  if (gateway) return gateway;
  const { id, attachmentId } = await ctx.params;
  const scope = attachmentScopeFor(id);
  const record = scope.store.getScoped(attachmentId, scope.sessionId);
  if (!record) return NextResponse.json({ error: "附件不存在或不属于该会话", code: "not_found" }, { status: 404 });

  const wantsRaw = request.nextUrl.searchParams.get("raw") === "1";
  if (!wantsRaw) return NextResponse.json({ attachment: receiptOf(record), availability: scope.store.blobExists(record.id) });

  const opened = scope.store.open(record.id);
  // 文件绑定后 blob 可能遗失（外部清理/磁盘损坏）：明确返回不可用，而不是让整条消息渲染失败（规格 §12）。
  if (!opened) return NextResponse.json({ error: "附件文件已不可用", code: "not_found" }, { status: 410 });

  const disposition = request.nextUrl.searchParams.get("download") === "1" || !INLINE_TYPES.test(record.mediaType) ? "attachment" : "inline";
  const body = Readable.toWeb(opened.stream) as unknown as ReadableStream<Uint8Array>;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": record.mediaType,
      "Content-Length": String(record.size),
      "Content-Disposition": contentDisposition(record.filename, disposition),
      // 附件是用户数据，不进共享缓存；同时禁止浏览器按内容猜测类型（§13）
      "Cache-Control": "private, max-age=0, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      // sandbox 让文档进入不透明 origin：即便内容是 HTML/脚本也不会在应用 origin 上执行
      "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
    },
  });
}

/** DELETE：只允许删除尚未绑定消息的附件（已发送的附件属于历史，不能从卡片里删掉）。 */
async function handleDELETE(_request: NextRequest, ctx: { params: Promise<{ id: string; attachmentId: string }> }) {
  const { id, attachmentId } = await ctx.params;
  const scope = attachmentScopeFor(id);
  const record = scope.store.getScoped(attachmentId, scope.sessionId);
  if (!record) return NextResponse.json({ error: "附件不存在或不属于该会话", code: "not_found" }, { status: 404 });
  if (record.messageId) {
    return NextResponse.json({ error: "附件已随消息发送，不能删除", code: "ownership" }, { status: 409 });
  }
  scope.store.deleteUnbound(attachmentId);
  return NextResponse.json({ ok: true });
}

export const GET = withWorkflowErrors(handleGET);
export const DELETE = withWorkflowErrors(handleDELETE);
