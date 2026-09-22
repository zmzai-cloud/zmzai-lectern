/**
 * 附件作用域解析（规格 §9.1 / §13 / §17.2.2）。
 *
 * 把「URL 上的 session 参数」解析成「哪个项目的附件库 + 哪个授权作用域」，是上传、
 * 读取、删除、绑定四条路径共用的唯一入口。刻意不做缓存：会话删除、项目移动、重复
 * 会话 id 都必须立刻被观察到（与 `resolveSessionOwner` 同一条原则）。
 */

import { dataDirFor, getActiveProject } from "../projects.js";
import { resolveSessionOwner } from "../session-owner.js";
import { validateExtractedDocument, type AttachmentProvider, type InputAttachmentRef } from "@zmzai/agent-framework";

import { EXTRACTOR_VERSION, type ExtractionCachePayload } from "./extract/index.js";
import { DRAFT_SESSION_ID } from "./limits.js";
import { attachmentStoreFor, type SqliteAttachmentStore } from "./store.js";

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

/** 附件读取器（规格 §9.2 / §13）：framework 需要正文时经此回调，framework 自身不碰文件系统。
 *  按项目 dataDir 建一次并复用——同一项目下的 worktree 隔离 runtime 共享同一个 store。
 *
 *  **必须按 scope 校验归属**：一个项目的附件库装的是该项目**所有会话**的附件，
 *  而 runner 是「一个 project 一个实例、轮流服务多个会话」。只按 id 取（`store.get`）
 *  就等于让 A 会话的消息能读到 B 会话的文件——HTTP 路径早就用 `getScoped` 挡住了，
 *  执行路径不能是另一个口子。 */
export function attachmentProviderFor(dataDir: string): AttachmentProvider {
  const store = attachmentStoreFor(dataDir);
  return {
    async read(id: string, scope: { sessionId: string }) {
      const record = store.getScoped(id, scope.sessionId);
      if (!record) return null;
      const opened = store.open(id);
      // blob 丢失（外部清理/磁盘损坏）时返回 null：历史消息仍要能重放（规格 §12）
      if (!opened) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
      return {
        ref: {
          id: record.id,
          name: record.filename,
          mediaType: record.mediaType,
          size: record.size,
          sha256: record.sha256,
          kind: record.kind,
        },
        bytes: Buffer.concat(chunks),
      };
    },
    /** 会话内已就绪的附件（供跨附件搜索）。未就绪的不列——搜索一个还没解析完的
     *  文件只会返回「没找到」，那是在误导模型。 */
    async list(scope: { sessionId: string }) {
      return store
        .list(scope.sessionId)
        .filter((record) => record.status === "ready")
        .map((record) => ({ id: record.id, name: record.filename, kind: record.kind }));
    },
    /**
     * 结构化正文（规格 §10.1）。从**解析缓存**读，不现场解析：
     * `read_attachment` 是模型随时会调的工具，而一次 PDF 解析要几秒到几十秒——
     * 卡住的工具调用会让模型以为工具坏了。
     *
     * 三种情况返回 null（都表示「这次拿不到结构化正文」）：
     * 附件不属于该会话、还没解析完/解析失败（无缓存）、缓存是别的适配器版本写的
     * （适配器改了行为，老结果不再可信）。
     */
    async extract(id: string, scope: { sessionId: string }) {
      const record = store.getScoped(id, scope.sessionId);
      if (!record || record.status !== "ready") return null;
      const payload = store.loadExtractedDocument(record.sha256);
      if (!payload || typeof payload !== "object") return null;
      const cached = payload as Partial<ExtractionCachePayload>;
      if (cached.extractorVersion !== EXTRACTOR_VERSION) return null;
      // 缓存同样是不可信输入（磁盘上的 JSON 可以被改），走同一条校验
      try {
        return validateExtractedDocument(cached.document);
      } catch {
        return null;
      }
    },
  };
}

export type ResolvedAttachmentRefs = {
  refs: InputAttachmentRef[];
  /** 不存在或不属于该会话的 id：客户端可能带了别的会话/已被清理的附件。 */
  missing: string[];
  /** 存在但尚未就绪（解析中/失败）的 id：发送必须被拒绝，否则消息里会挂个空附件。 */
  notReady: string[];
};

/**
 * 把客户端给的 attachment id 解析成描述符（规格 §9.1 / §17.2.2）。
 * 逐一经 `getScoped` 校验归属——**不接受任意 id**，这是附件越权的唯一关口。
 */
export function resolveAttachmentRefs(scope: AttachmentScope, ids: readonly string[]): ResolvedAttachmentRefs {
  const refs: InputAttachmentRef[] = [];
  const missing: string[] = [];
  const notReady: string[] = [];
  for (const id of ids) {
    const record = scope.store.getScoped(id, scope.sessionId);
    if (!record) {
      missing.push(id);
      continue;
    }
    if (record.status !== "ready") {
      notReady.push(id);
      continue;
    }
    refs.push({
      id: record.id,
      name: record.filename,
      mediaType: record.mediaType,
      size: record.size,
      sha256: record.sha256,
      kind: record.kind,
    });
  }
  return { refs, missing, notReady };
}
