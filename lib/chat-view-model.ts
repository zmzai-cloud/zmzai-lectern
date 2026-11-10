import type { UiMessage, UiPart } from "./chat-projector.js";
import type { InputAttachmentRef, Part } from "./types.js";

export type MessageSlot =
  | { kind: "flow"; id: string; items: UiPart[] }
  | { kind: "part"; id: string; item: UiPart };

function isFlowPart(item: UiPart): boolean {
  return item.part.type === "reasoning" || item.part.type === "subtask" || (item.part.type === "tool" && !item.diff);
}

/** 工具间的短叙述（模型边做边写的过场文字）也归过程块（2026-11-10 对齐 dsh/Codex）：
 *  规则与 ChatView 的 passthrough 一致——text 段之后仍有工具调用。归组后不再
 *  把消息切成 [过程组][text][过程组][text] 的碎片流，过程是连续一块。 */
function isPassthroughText(parts: UiPart[], index: number): boolean {
  const item = parts[index]!;
  if (item.part.type !== "text" || !item.part.text.trim()) return false;
  return parts.slice(index + 1).some((later) => later.part.type === "tool");
}

export function buildMessageSlots(parts: UiPart[]): MessageSlot[] {
  const slots: MessageSlot[] = [];
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i]!;
    const previous = slots[slots.length - 1];
    if (isFlowPart(item) || isPassthroughText(parts, i)) {
      if (previous?.kind === "flow") previous.items.push(item);
      else slots.push({ kind: "flow", id: item.part.id, items: [item] });
    } else {
      slots.push({ kind: "part", id: item.part.id, item });
    }
  }
  return slots;
}

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
