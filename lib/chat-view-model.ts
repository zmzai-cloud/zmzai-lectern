import type { UiMessage } from "./chat-projector.js";
import type { InputAttachmentRef, Part } from "./types.js";

// 旧逐消息分组器 buildMessageSlots/MessageSlot 已删（2026-11-12 统一重构）：
// 会话流分组统一走 lib/chat-rounds.ts 的 buildRounds（DSH 式全会话轮次树），
// 本文件只保留乐观回显合并。

export type OptimisticEcho = {
  text: string;
  images: { url: string; mediaType: string }[];
  skill?: { id: string; name: string };
  references?: string[];
  attachments?: InputAttachmentRef[];
  sessionId?: string;
  requestId: string;
  userMessageId?: string;
};

export function mergeOptimisticMessage(messages: UiMessage[], echo: OptimisticEcho | null): UiMessage[] {
  if (!echo) return messages;
  if (echo.userMessageId) {
    const echoed = messages.find((message) => message.id === echo.userMessageId);
    if (echoed) {
      if (!echo.skill || echoed.skill) return messages;
      return messages.map((message) => message.id === echoed.id
        ? { ...message, skill: { ...echo.skill!, digest: "" } }
        : message);
    }
  }

  const echoMessage: UiMessage = {
    id: "__echo__",
    role: "user",
    ...(echo.skill ? { skill: { ...echo.skill, digest: "" } } : {}),
    ...(echo.references?.length ? { references: echo.references } : {}),
    parts: [
      ...echo.images.map((image, index) => ({
        part: { id: `__echo_img_${index}`, type: "image", url: image.url, mediaType: image.mediaType, messageId: "__echo__", sessionId: "" } as Part,
      })),
      ...(echo.attachments ?? []).map((ref, index) => ({
        part: {
          id: `__echo_att_${index}`,
          type: "file",
          mime: ref.mediaType,
          filename: ref.name,
          attachmentId: ref.id,
          size: ref.size,
          kind: ref.kind,
          status: "ready",
          messageId: "__echo__",
          sessionId: echo.sessionId ?? "",
        } as Part,
      })),
      ...(echo.text ? [{ part: { id: "__echo_text", type: "text", text: echo.text, messageId: "__echo__", sessionId: "" } as Part }] : []),
    ],
  };
  return [...messages, echoMessage];
}
