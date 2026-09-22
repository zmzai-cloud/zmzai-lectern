"use client";

/**
 * Composer 附件队列（规格 2 §7.2 / §7.3 / §7.4 / §8 / §14）。
 *
 * 【为什么合成一个 hook】历史上 `Composer.tsx` 里 `pickImages` 与 `pickAttachments`
 * 是两套并行的状态与处理函数，于是选择、粘贴、拖放三条路径各自演化出不同规则
 * （粘贴只认 `image/*`，拖放同时调两个函数导致同一文件被处理两次）。现在三条路径
 * 都只调 `ingestFiles`，文件名、上限、状态、错误文案从同一处来。
 *
 * 【对象 URL 生命周期】仅图片创建 `previewUrl`，移除与卸载时 `revoke`——不 revoke 会
 * 让 Blob 常驻内存直到页面关闭（规格 §17.1.8）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { client, type UploadFailure } from "../client.js";

import { validateClientFile, type ExistingAttachment } from "./classify.js";
import { DRAFT_SESSION_ID } from "./limits.js";
import type { AttachmentError, AttachmentErrorCode, ComposerAttachment } from "./types.js";

/** 受理失败的码一律不可重试（重试多少次结果都一样）；其余按瞬时故障处理。 */
const PERMANENT_CODES: ReadonlySet<string> = new Set<AttachmentErrorCode>([
  "unsupported_format",
  "too_large",
  "too_many",
  "total_too_large",
  "duplicate",
  "empty_file",
  "bad_name",
  "password_protected",
  "no_extractable_text",
  "corrupted",
  "ownership",
  "not_found",
]);

export type IngestSource = "picker" | "paste" | "drop";

const SOURCE_LABEL: Record<IngestSource, string> = { picker: "文件选择", paste: "粘贴", drop: "拖放" };

/**
 * 解析状态的轮询节奏（规格 §7.4：每张卡独立显示解析状态）。
 *
 * 起步 600ms、逐步退避到 4s、总预算 2 分钟。三个数字各有理由：间隔太短会让一份
 * 大 PDF 在解析期间产生几十次无意义请求；太长则「文本附件秒过」这件事看起来像卡住；
 * 2 分钟是给 300 页 PDF 的天花板——超过它更可能是服务端出了问题，继续等不如报错让
 * 用户重试（重试会重新入队，不会重复上传）。
 */
const POLL_FIRST_MS = 600;
const POLL_MAX_MS = 4_000;
const POLL_BUDGET_MS = 120_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function newLocalId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `att-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toAttachmentError(failure: UploadFailure): AttachmentError {
  const code = (failure.code ?? "server") as AttachmentErrorCode;
  return { code, message: failure.message, retryable: !PERMANENT_CODES.has(code) };
}

export type ComposerAttachments = ReturnType<typeof useComposerAttachments>;

export function useComposerAttachments(sessionId: string | null) {
  /** 尚未创建会话时挂到草稿作用域（规格 §9.1：附件必须属于某个 session/workspace）。 */
  const scope = sessionId ?? DRAFT_SESSION_ID;
  const [items, setItems] = useState<ComposerAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const itemsRef = useRef<ComposerAttachment[]>([]);
  const scopeRef = useRef(scope);
  const controllers = useRef(new Map<string, AbortController>());
  const previousScope = useRef(scope);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const patch = useCallback((localId: string, next: Partial<ComposerAttachment>) => {
    setItems((prev) => prev.map((item) => (item.localId === localId ? { ...item, ...next } : item)));
  }, []);

  /**
   * 跟到解析定下来为止。
   *
   * 【为什么要考虑「附件被删了」】用户在解析期间点了移除：`discard` 会 abort 这个
   * signal，`sleep` 抛 AbortError，这里直接把控制权还给 `startUpload` 的 catch——
   * 它认得 AbortError 并不写错误卡片。用同一个 signal 而不是新开一个，是为了让
   * 「移除」只有一个终止点。
   */
  const followExtraction = useCallback(
    async (localId: string, attachmentId: string, signal: AbortSignal) => {
      const started = Date.now();
      let delay = POLL_FIRST_MS;
      while (Date.now() - started < POLL_BUDGET_MS) {
        await sleep(delay, signal);
        const { attachment } = await client.getAttachment(scopeRef.current, attachmentId);
        if (attachment.status === "ready") {
          patch(localId, { status: "ready", progress: 1, error: undefined });
          return;
        }
        if (attachment.status === "error") {
          patch(localId, {
            status: "error",
            error: attachment.error ?? { code: "server", message: "解析失败", retryable: false },
          });
          return;
        }
        delay = Math.min(Math.round(delay * 1.5), POLL_MAX_MS);
      }
      patch(localId, {
        status: "error",
        error: { code: "server", message: "解析超时，请重试（不会重复上传）", retryable: true },
      });
    },
    [patch],
  );

  const startUpload = useCallback(
    async (item: ComposerAttachment) => {
      const controller = new AbortController();
      controllers.current.set(item.localId, controller);
      patch(item.localId, { status: "uploading", progress: 0, error: undefined });
      try {
        const receipt = await client.uploadAttachment(scopeRef.current, item.file, {
          signal: controller.signal,
          onProgress: (ratio) => patch(item.localId, { progress: ratio }),
        });
        patch(item.localId, {
          attachmentId: receipt.attachmentId,
          sha256: receipt.sha256,
          mediaType: receipt.mediaType,
          progress: 1,
          status: receipt.status === "ready" ? "ready" : receipt.status === "error" ? "error" : "processing",
          ...(receipt.error ? { error: receipt.error } : {}),
        });
        // 解析在服务端后台跑（PDF/Office 要几秒到几十秒），上传响应只说明「已收下」。
        // 不跟到底的话，卡片会永远停在「解析中」而发送按钮永远不可用。
        if (receipt.status === "processing") {
          await followExtraction(item.localId, receipt.attachmentId, controller.signal);
        }
      } catch (error) {
        // 用户主动移除导致的 abort 不该留下错误卡片（轮询被中止走同一条分支）
        if ((error as { name?: string })?.name === "AbortError" || (error as UploadFailure)?.code === "aborted") return;
        const failure = error as UploadFailure;
        patch(item.localId, { status: "error", error: toAttachmentError(failure) });
      } finally {
        controllers.current.delete(item.localId);
      }
    },
    [patch, followExtraction],
  );

  /**
   * 唯一入口：选择、粘贴、拖放都走这里（规格 §8）。
   * 逐文件校验而不是「先全部收下再报告」，这样每个被拒文件都有自己的具体原因，
   * 且合法的文件不会因为同批里有一个不支持的文件而一起被丢。
   */
  const ingestFiles = useCallback(
    (input: FileList | File[] | null | undefined, source: IngestSource) => {
      const files = input ? [...input] : [];
      if (files.length === 0) return;

      const rejected: string[] = [];
      const accepted: ComposerAttachment[] = [];
      let current: ExistingAttachment[] = itemsRef.current.map((item) => ({ name: item.name, size: item.size }));

      for (const file of files) {
        const verdict = validateClientFile({ name: file.name, type: file.type, size: file.size }, current);
        if (!verdict.ok) {
          rejected.push(verdict.error.message);
          continue;
        }
        const item: ComposerAttachment = {
          localId: newLocalId(),
          file,
          name: verdict.value.name,
          mediaType: verdict.value.mediaType,
          size: file.size,
          kind: verdict.value.kind,
          status: "preparing",
          // 只有图片需要缩略图；createObjectURL 的返回值必须在移除/卸载时 revoke
          ...(verdict.value.kind === "image" ? { previewUrl: URL.createObjectURL(file) } : {}),
        };
        accepted.push(item);
        current = [...current, { name: item.name, size: item.size }];
      }

      if (accepted.length > 0) {
        itemsRef.current = [...itemsRef.current, ...accepted];
        setItems((prev) => [...prev, ...accepted]);
        for (const item of accepted) void startUpload(item);
      }
      if (rejected.length > 0) {
        setNotice(rejected.join("；"));
      } else if (accepted.length === 0) {
        setNotice(`${SOURCE_LABEL[source]}没有可添加的文件`);
      }
    },
    [startUpload],
  );

  const discard = useCallback((item: ComposerAttachment) => {
    controllers.current.get(item.localId)?.abort();
    controllers.current.delete(item.localId);
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    // 已上传但未绑定消息的附件要真删掉，否则会留在存储里等 TTL 过期（规格 §14）
    if (item.attachmentId) void client.deleteAttachment(scopeRef.current, item.attachmentId).catch(() => undefined);
  }, []);

  const remove = useCallback(
    (localId: string) => {
      const item = itemsRef.current.find((candidate) => candidate.localId === localId);
      if (!item) return;
      discard(item);
      itemsRef.current = itemsRef.current.filter((candidate) => candidate.localId !== localId);
      setItems((prev) => prev.filter((candidate) => candidate.localId !== localId));
    },
    [discard],
  );

  const retry = useCallback(
    (localId: string) => {
      const item = itemsRef.current.find((candidate) => candidate.localId === localId);
      if (!item || item.status !== "error") return;
      void startUpload(item);
    },
    [startUpload],
  );

  /** 发送成功后清空（附件已绑定消息，不再删除服务端文件）。 */
  const clear = useCallback(() => {
    for (const item of itemsRef.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    controllers.current.clear();
    itemsRef.current = [];
    setItems([]);
    setNotice(null);
  }, []);

  /** 会话切换：不得把未发送附件带到另一个会话（规格 §17.1.7）。 */
  useEffect(() => {
    if (previousScope.current === scope) return;
    previousScope.current = scope;
    scopeRef.current = scope;
    const leftovers = itemsRef.current;
    controllers.current.clear();
    itemsRef.current = [];
    setItems([]);
    for (const item of leftovers) discard(item);
    if (leftovers.length > 0) setNotice("已切换会话，未发送的附件已清空");
  }, [scope, discard]);

  // 卸载：中止上传并回收对象 URL。服务端未绑定附件交给 TTL 清理（明确的清理策略）。
  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
      for (const item of itemsRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    },
    [],
  );

  // 提示 4 秒后自动消失（与既有 imgNotice 行为一致，不打断输入）
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const derived = useMemo(() => {
    const pending = items.filter((item) => item.status === "uploading" || item.status === "preparing" || item.status === "processing");
    const failed = items.filter((item) => item.status === "error");
    const ready = items.filter((item) => item.status === "ready" && item.attachmentId && item.sha256);
    const blockedReason = failed.length > 0
      ? `${failed.length} 个附件未就绪，请重试或移除后再发送`
      : pending.length > 0
        ? `正在处理 ${pending.length} 个附件，完成后才能发送`
        : null;
    return {
      pendingCount: pending.length,
      failedCount: failed.length,
      /** 已就绪的附件描述符（规格 2 §11），发送时随 onSend 传出。 */
      readyRefs: ready.map((item) => ({
        id: item.attachmentId!,
        name: item.name,
        mediaType: item.mediaType,
        size: item.size,
        sha256: item.sha256!,
        kind: item.kind,
      })),
      hasFiles: items.length > 0,
      blockedReason,
    };
  }, [items]);

  return {
    items,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),
    /** 主动播报（发送被拦、剪贴板读不出文件等）。与 ingestFiles 的拒绝提示共用
     *  同一个提示位——两条通道会让同一时刻出现两句话，用户不知道该看哪句。 */
    notify: useCallback((message: string) => setNotice(message), []),
    ingestFiles,
    remove,
    retry,
    clear,
    ...derived,
  };
}
