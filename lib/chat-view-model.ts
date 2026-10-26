import type { UiMessage, UiPart } from "./chat-projector.js";
import type { InputAttachmentRef, Part } from "./types.js";

export type MessageSlot =
  | { kind: "flow"; id: string; items: UiPart[] }
  | { kind: "part"; id: string; item: UiPart };

function isFlowPart(item: UiPart): boolean {
  return item.part.type === "reasoning" || item.part.type === "subtask" || (item.part.type === "tool" && !item.diff);
}

export function buildMessageSlots(parts: UiPart[]): MessageSlot[] {
  const slots: MessageSlot[] = [];
  for (const item of parts) {
    const previous = slots[slots.length - 1];
    if (isFlowPart(item)) {
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
