import type { UiPart } from "./chat-projector.js";
import type { Part } from "./types.js";

/** DSH 式会话流分组（docs/dsh-ui-reference/RULES.md，2026-11-11）。
 *
 *  与旧 buildMessageSlots 的本质区别——分组不按"消息"也不按"工具间叙述"，
 *  而是按 DSH 的过程段规则在**整个会话**上工作：
 *  - 过程内容（reasoning / tool / 中途叙述）按相邻性聚成组；
 *  - **回复（后面没有工具的正文）终结前一个组**，自己是独立 response；
 *  - 换工具类型不分组、step 序号变化不分组；
 *  - 用户消息开启新轮（新过程段）；
 *  - run 进行中，最后一条消息的尾部 text 是「流式回复」：不终结过程组，
 *    后续工具到达时被吸收回同一组（避免组分裂重挂载引发的展开/收起震荡）。
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
  | { kind: "process"; id: string; anchorMessageId: string; items: UiPart[]; tools: string[]; running: boolean; summary: string }
  | { kind: "reply"; id: string; item: UiPart; final: boolean; /** 流式尾部（run 进行中、无法预知后续是否还有工具） */ streaming?: boolean };

export type Round = {
  id: string;
  /** 用户输入（气泡）；null = 会话首轮之前 */
  user: UiPart[] | null;
  nodes: RoundNode[];
};

function toolRunning(part: Part): boolean {
  return part.type === "tool" && (part.state.status === "running" || part.state.status === "pending");
}

/** 全会话分组主入口：visible 消息序列 → 轮次树。
 *
 *  `running`（session 运行中）改变**尾部 text** 的归类：流式过程中无法预知
 *  后面还会不会有工具——若按静止规则判成 reply 并 closeProcess，后续工具一到
 *  text 又被重新归类进组，组节点 id 变化导致 WorkflowGroup 重挂载（用户手动
 *  收起状态丢失、组反复展开收起）。故 running 时最后一条消息的尾部 text 以
 *  streaming reply 形态渲染且**不终结过程组**：后续真来工具，text 被吸收进
 *  同一个组（组 id 不变，无重挂载）；run 结束后重算，text 落为最终回复。 */
export function buildRounds(messages: { id: string; role: string; parts: UiPart[] }[], opts?: { running?: boolean }): Round[] {
  const running = opts?.running ?? false;
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

  // 信号工具不算"后续工作"——task_deliver 标记交付完成、todo 更新计划，
  // 结论 text 后面跟它们不构成"中途叙述"，照常显示为正文
  const isWorkTool = (p: { type: string; tool?: string }): boolean =>
    p.type === "tool" && p.tool !== "task_deliver" && p.tool !== "todo";

  // 「后面还有没有工作工具」判定在**全会话后续**上做（不只本消息）：跨消息的
  // 后续工具同样使 text 成为中途叙述（pi 每 turn 一条消息，下一条消息的工具
  // 很常见）。逐 text 切片扫描是 O(P²) 且流式每帧重算——一次反向扫描预计算：
  // 每消息内部的 part 后缀标志 + 每消息之后的消息级标志，合并即 O(1) 查询。
  const suffixInMessage: boolean[][] = messages.map((message) => {
    const flags = new Array<boolean>(message.parts.length).fill(false);
    for (let i = message.parts.length - 2; i >= 0; i -= 1) {
      flags[i] = flags[i + 1]! || isWorkTool(message.parts[i + 1]!.part);
    }
    return flags;
  });
  const suffixAfterMessage: boolean[] = new Array<boolean>(messages.length).fill(false);
  for (let i = messages.length - 2; i >= 0; i -= 1) {
    suffixAfterMessage[i] = suffixAfterMessage[i + 1]! || messages[i + 1]!.parts.some((p) => isWorkTool(p.part));
  }

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
    const isStreamingTailMessage = running && messageIndex === messages.length - 1;
    for (let i = 0; i < parts.length; i++) {
      const item = parts[i]!;
      const part = item.part;
      if (part.type === "reasoning" || (part.type === "tool" && isWorkTool(part))) {
        if (!openProcess) {
          openProcess = { kind: "process", id: part.id, anchorMessageId: message.id, items: [], tools: [], running: false, summary: "" };
          round.nodes.push(openProcess);
        }
        openProcess.items.push(item);
        if (part.type === "tool") {
          openProcess.tools.push(part.tool);
          if (toolRunning(part)) openProcess.running = true;
        }
      } else if (part.type === "tool") {
        // 信号工具（task_deliver/todo）：如有过程组则收入展示，不参与分组判定
        if (openProcess) openProcess.items.push(item);
        else round.nodes.push({ kind: "reply", id: part.id, item, final: false });
      } else if (part.type === "text" && part.text.trim()) {
        const hasToolAfter = suffixInMessage[messageIndex]![i] || suffixAfterMessage[messageIndex]!;
        if (hasToolAfter) {
          if (!openProcess) {
            openProcess = { kind: "process", id: part.id, anchorMessageId: message.id, items: [], tools: [], running: false, summary: "" };
            round.nodes.push(openProcess);
          }
          openProcess.items.push(item);
        } else if (isStreamingTailMessage) {
          // 流式尾部：不终结过程组（保持组开着、text 在组下方流式渲染）。
          // 后续工具到达 → 重算时 text 因 hasToolAfter 被吸收进**同一个**组。
          round.nodes.push({ kind: "reply", id: part.id, item, final: false, streaming: true });
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
