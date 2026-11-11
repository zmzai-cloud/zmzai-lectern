import type { UiPart } from "./chat-projector.js";
import type { Part } from "./types.js";

/** DSH 式会话流分组（docs/dsh-ui-reference/RULES.md，2026-11-11）。
 *
 *  与旧 buildMessageSlots 的本质区别——分组不按"消息"也不按"工具间叙述"，
 *  而是按 DSH 的过程段规则在**整个会话**上工作：
 *  - 过程内容（reasoning / tool / 中途叙述）按相邻性聚成组；
 *  - **回复（后面没有工具的正文）终结前一个组**，自己是独立 response；
 *  - 换工具类型不分组、step 序号变化不分组；
 *  - 用户消息开启新轮（新过程段）。
 *
 *  输出是一棵轮次树：每轮 = { groups: 过程组[], reply: 回复 | null }，
 *  渲染层不再需要跨消息归并的补丁逻辑。 */

export type FlowCategory =
  | "read" | "search" | "write" | "edit" | "commands" | "webSearch" | "webFetch"
  | "subagents" | "plan" | "memory" | "verify" | "tools";

/** DSH 分类表（按工具名精确匹配 + Lectern 自有工具映射）。 */
export function categoryOfTool(tool: string): FlowCategory {
  if (tool === "read" || tool === "read_attachment" || tool === "search_attachments") return "read";
  if (tool === "grep" || tool === "glob") return "search";
  if (tool === "write") return "write";
  if (tool === "edit" || tool === "apply_patch") return "edit";
  if (tool === "bash" || tool.startsWith("terminal")) return "commands";
  if (tool === "websearch") return "webSearch";
  if (tool === "webfetch" || tool === "web_fetch") return "webFetch";
  if (tool === "agent_spawn" || tool === "agent_send" || tool === "agent_wait" || tool === "agent_list" || tool === "agent_cancel") return "subagents";
  if (tool === "todo") return "plan";
  if (tool === "memory_search") return "memory";
  if (tool === "browser_verify") return "verify";
  return "tools";
}

/** 分类中文标签（DSH 关闭态用语：已…）。 */
export const CATEGORY_LABELS: Record<FlowCategory, string> = {
  read: "读取文件",
  search: "搜索代码",
  write: "写入文件",
  edit: "编辑文件",
  commands: "运行命令",
  webSearch: "联网检索",
  webFetch: "抓取网页",
  subagents: "子代理",
  plan: "更新计划",
  memory: "检索记忆",
  verify: "浏览器验收",
  tools: "调用工具",
};

/** 组摘要：分类计数排名，供关闭态标题（前三连接 + "等"）。 */
export function summarizeGroups(tools: string[]): { label: string; counts: { kind: FlowCategory; count: number }[] } {
  const byKind = new Map<FlowCategory, number>();
  for (const tool of tools) {
    const kind = categoryOfTool(tool);
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
  const counts = [...byKind.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => (b.count - a.count) || 0);
  const top = counts.slice(0, 3).map((c) => CATEGORY_LABELS[c.kind]);
  const label = top.length === 0 ? "分析请求"
    : counts.length > 3 ? `${top.join("、")}等`
    : top.join("、");
  return { label, counts };
}

export type RoundNode =
  | { kind: "user"; id: string; item: UiPart[] }
  | { kind: "process"; id: string; items: UiPart[]; tools: string[]; running: boolean; summary: string }
  | { kind: "reply"; id: string; item: UiPart; final: boolean };

export type Round = {
  id: string;
  /** 用户输入（气泡）；null = 会话首轮之前 */
  user: UiPart[] | null;
  nodes: RoundNode[];
};

function toolRunning(part: Part): boolean {
  return part.type === "tool" && (part.state.status === "running" || part.state.status === "pending");
}

/** 全会话分组主入口：visible 消息序列 → 轮次树。 */
export function buildRounds(messages: { id: string; role: string; parts: UiPart[] }[]): Round[] {
  const rounds: Round[] = [];
  let current: Round | null = null;
  let openProcess: RoundNode & { kind: "process" } | null = null;

  const closeProcess = () => { openProcess = null; };

  const ensureRound = (id: string): Round => {
    if (!current) {
      current = { id, user: null, nodes: [] };
      rounds.push(current);
    }
    return current;
  };

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    if (message.role !== "assistant") {
      // 用户消息：结束当前轮，开启新轮
      closeProcess();
      current = { id: message.id, user: message.parts, nodes: [] };
      rounds.push(current);
      continue;
    }
    const round = ensureRound(message.id);
    const parts = message.parts;
    // 叙述判定在**全会话后续**上做（不只本消息）：跨消息的后续工具同样使
    // 该 text 成为中途叙述（pi 每 turn 一条消息，下一条消息的工具很常见）
    const laterMessages = messages.slice(messageIndex + 1);
    const hasToolAfterAnywhere = (index: number): boolean => {
      if (parts.slice(index + 1).some((later) => later.part.type === "tool")) return true;
      return laterMessages.some((later) => later.parts.some((p2) => p2.part.type === "tool"));
    };
    for (let i = 0; i < parts.length; i++) {
      const item = parts[i]!;
      const part = item.part;
      if (part.type === "tool" || part.type === "reasoning") {
        if (!openProcess) {
          openProcess = { kind: "process", id: part.id, items: [], tools: [], running: false, summary: "" };
          round.nodes.push(openProcess);
        }
        openProcess.items.push(item);
        if (part.type === "tool") {
          openProcess.tools.push(part.tool);
          if (toolRunning(part)) openProcess.running = true;
        }
      } else if (part.type === "text" && part.text.trim()) {
        if (hasToolAfterAnywhere(i)) {
          if (!openProcess) {
            openProcess = { kind: "process", id: part.id, items: [], tools: [], running: false, summary: "" };
            round.nodes.push(openProcess);
          }
          openProcess.items.push(item);
        } else {
          closeProcess();
          round.nodes.push({ kind: "reply", id: part.id, item, final: true });
        }
      } else {
        if (openProcess) openProcess.items.push(item);
        else round.nodes.push({ kind: "reply", id: part.id, item, final: false });
      }
    }
  }
  // 组摘要
  for (const r of rounds) {
    for (const node of r.nodes) {
      if (node.kind === "process") node.summary = summarizeGroups(node.tools).label;
    }
  }
  return rounds;
}
