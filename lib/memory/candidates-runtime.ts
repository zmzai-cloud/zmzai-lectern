/**
 * 候选管线的 runtime 挂点（K1 T19a）：交付打标 + onRunEnd 异步提炼。
 * 独立模块隔离 relay 直调与凭据 ALS 依赖，runtime.ts 只注入 sessionId→credential 解析器。
 */
import type { LifecycleHook } from "@zmzai/agent-framework";

import { currentCookieHeader, withSessionCredential } from "../request-cookie.js";
import { relayBase } from "../relay.js";
import { authHeaders } from "../settings.js";
import { generateMemoryCandidates } from "./candidates.js";
import { getMemoryBinding } from "./binding.js";

/** 框架内置交付工具（TASK_DELIVER_TOOL_ID 未从包索引导出，字面量钉住）。 */
const TASK_DELIVER_TOOL = "task_deliver";
const EXTRACT_TIMEOUT_MS = 20_000;

function extractModel(): string {
  return process.env.LECTERN_MEMORY_EXTRACT_MODEL ?? "glm-5.3-flash";
}

async function relayChatCompletion(sessionCredential: string | null | undefined, prompt: string): Promise<string | null> {
  const run = async (): Promise<string | null> => {
    try {
      const res = await fetch(`${relayBase()}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(currentCookieHeader()) },
        body: JSON.stringify({
          model: extractModel(),
          messages: [{ role: "user", content: prompt }],
          max_tokens: 800,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string } }>;
      } | null;
      return data?.choices?.[0]?.message?.content ?? null;
    } catch {
      return null; // 网络/超时：提炼是旁路，静默放弃本次
    }
  };
  // Host 进程无请求态 cookie——用 credentialRef 包 ALS（与模型流同一条凭据通道）
  return sessionCredential ? withSessionCredential(sessionCredential, run) : run();
}

/**
 * 交付型 run 判定：run 内成功调用过 task_deliver（onRunStart 清标，
 * onAfterToolCall 打标，onRunEnd 消费）。fire-and-forget，抛错只吞。
 */
export function memoryCandidateHooks(
  project: { id: string; name: string },
  resolveCredential: (sessionId: string) => string | null | undefined,
): LifecycleHook {
  const delivered = new Set<string>();
  return {
    name: "memory-candidates",
    onRunStart: ({ sessionId }) => {
      delivered.delete(sessionId);
    },
    onAfterToolCall: ({ sessionId, tool, isError }) => {
      if (tool === TASK_DELIVER_TOOL && !isError) delivered.add(sessionId);
    },
    onRunEnd: ({ sessionId, ok, aborted, newMessages }) => {
      if (!delivered.delete(sessionId)) return; // 非交付型 run（纯问答）不提炼
      if (!ok || aborted || !newMessages?.length) return;
      const binding = getMemoryBinding(project.id);
      const policy = binding && binding.enabled === 1 ? binding.syncPolicy : "off";
      if (policy === "off") return;
      const credential = resolveCredential(sessionId);
      void generateMemoryCandidates(
        { projectId: project.id, sessionId, transcript: newMessages, syncPolicy: policy },
        { callModel: (prompt) => relayChatCompletion(credential, prompt) },
      ).catch(() => undefined);
    },
  };
}
