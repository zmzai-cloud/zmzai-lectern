/**
 * 附件作用域解析（规格 §9.1 / §13 / §17.2.2）。
 *
 * 把「URL 上的 session 参数」解析成「哪个项目的附件库 + 哪个授权作用域」，是上传、
 * 读取、删除、绑定四条路径共用的唯一入口。刻意不做缓存：会话删除、项目移动、重复
 * 会话 id 都必须立刻被观察到（与 `resolveSessionOwner` 同一条原则）。
 */

import { dataDirFor, getActiveProject } from "@/lib/projects";
import { resolveSessionOwner } from "@/lib/session-owner";

import { DRAFT_SESSION_ID } from "./limits";
import { attachmentStoreFor, type SqliteAttachmentStore } from "./store";

export type AttachmentScope = {
  /** 实际作用域：真实会话 id，或草稿作用域 `__draft__`。 */
  sessionId: string;
  projectId: string;
  store: SqliteAttachmentStore;
};

/**
 * 解析作用域。
 * - 真实会话：必须已存在（`resolveSessionOwner` 找不到就 404），附件库取该会话所属项目；
 * - `__draft__`：尚未创建会话时的草稿作用域，落在**当前活动项目**上——因为惰性建会话
 *   也会建在活动项目里，两者必须一致，否则发送时无法绑定。
 */
export function attachmentScopeFor(sessionId: string): AttachmentScope {
  if (sessionId === DRAFT_SESSION_ID) {
    const project = getActiveProject();
    return { sessionId, projectId: project.id, store: attachmentStoreFor(dataDirFor(project)) };
  }
  const owner = resolveSessionOwner(sessionId);
  return { sessionId, projectId: owner.project.id, store: attachmentStoreFor(dataDirFor(owner.project)) };
}
