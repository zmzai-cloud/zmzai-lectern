import type { Artifact, LecternEvent, Part, SelectedSkill, TranscriptMessage, SessionSummary } from "./types";

/** ChatView 消息树的数据类型与投影器。
 *
 * 原实现是「事件数组 → project() 全量重投影」：events 无限增长（delta 是
 * 字符级事件），每个 delta 到达都 O(n) 重跑投影，总计 O(n²)。
 * 现改为增量折叠器：事件到达即 O(1) 折叠进内部状态，内存 O(消息数) 而非
 * O(事件数)；调用方按需（rAF 批处理）取快照渲染。 */

export type TodoItem = { content: string; status: "pending" | "in_progress" | "completed" | "cancelled" };

export type SubagentStep = { tool: string; title?: string; state?: string };
export type SubagentActivity = { steps: SubagentStep[]; finished?: { state: string; durationMs?: number; toolCalls?: number } };
export type UiPart = { part: Part; diff?: string; subagent?: SubagentActivity };
export type UiMessage = { id: string; role: string; messageSeq?: number; parts: UiPart[]; skill?: SelectedSkill; references?: string[]; error?: { name: string; message: string } };
// Reserve room for a 50-message request and a 50-message search context.
export const MESSAGE_CACHE_LIMIT = 400;

export type ChatViewData = {
  messages: UiMessage[];
  todos: TodoItem[] | null;
  /** 上下文读取 pill（去重，最新在前，最多 8 条）。 */
  reads: string[];
  /** 本轮 Agent 编辑/写入过的文件（file.edited 去重，最新在前）——看板联动用。 */
  editedPaths: string[];
  /** 任务终态小结（session.summary，N5）：最近一次 run 收尾的 AI 总结 + 统计。 */
  summary: SessionSummary | null;
  /** 本轮 run 累积中的产物（artifact.created，最新在前，去重）。运行中实时增长；
   *  session.summary 到达时封存进 summaryArtifacts 并清空，下一轮重新累积。 */
  artifacts: Artifact[];
  /** 最近一次 run 收尾时封存的产物集（与 summary 一一对应），SummaryCard 下方展示。
   *  多轮会话每轮只挂自己的产物，不跨轮累积。 */
  summaryArtifacts: Artifact[];
  /** 长任务中途进度快照（session.checkpoint，N6）：最近一次运行中的「中间落点」，
   *  中断后据此提示「上次进行到哪」（已执行 N 个工具 · 最后一步 · 耗时）。 */
  checkpoint: SessionCheckpoint | null;
};

/** 长任务中途进度快照（N6）。 */
export type SessionCheckpoint = {
  toolCalls: number;
  lastTool?: string;
  elapsedMs: number;
};

export const EMPTY_CHAT_VIEW: ChatViewData = { messages: [], todos: null, reads: [], editedPaths: [], summary: null, artifacts: [], summaryArtifacts: [], checkpoint: null };

/** 把引擎持久化的转录（MessageWithParts[]）转换成投影器可消费的
 *  message.updated + message.part.updated 事件流，从而跨会话恢复历史。
 *  注意：转录不含运行时事件（file.edited / delta），历史消息因此没有
 *  内联 diff——与旧全量恢复行为一致。 */
export function transcriptToEvents(messages: TranscriptMessage[]): LecternEvent[] {
  const out: LecternEvent[] = [];
  for (const m of messages) {
    out.push({ type: "message.updated", data: { message: { id: m.info.id, role: m.info.role, messageSeq: m.messageSeq, ...(m.info.skill ? { skill: m.info.skill } : {}), ...(m.info.references?.length ? { references: m.info.references } : {}), ...(m.info.error ? { error: m.info.error } : {}) } } });
    for (const p of m.parts) {
      out.push({ type: "message.part.updated", data: { part: p } });
    }
  }
  return out;
}

type InternalMessage = { id: string; role: string; messageSeq?: number; parts: Map<string, UiPart>; skill?: SelectedSkill; references?: string[]; error?: { name: string; message: string } };

export class ChatProjector {
  private messages = new Map<string, InternalMessage>();
  private order: string[] = [];
  // 未消费的 file.edited：path → diff 队列（事件序在前，tool part 定稿在后）
  private pendingEdits = new Map<string, string[]>();
  // 子代理活动：childSessionId → steps/finished（part 定稿前后都能体现）
  private subagentActivity = new Map<string, SubagentActivity>();
  private todos: TodoItem[] | null = null;
  private reads: string[] = [];
  private editedPaths: string[] = [];
  /** 最近一次 run 终态小结（session.summary）。 */
  private summary: SessionSummary | null = null;
  /** 本轮 run 累积中的产物（artifact.created，最新在前，去重）。 */
  private artifacts: Artifact[] = [];
  /** 最近一次 run 收尾封存的产物集（与 summary 一一对应）。 */
  private summaryArtifacts: Artifact[] = [];
  /** 最近一次中途进度快照（session.checkpoint，N6）。 */
  private checkpoint: SessionCheckpoint | null = null;

  hasMessage(id: string): boolean { return this.messages.has(id); }

  clearMessages(): void { this.messages.clear(); this.order = []; this.pendingEdits.clear(); this.subagentActivity.clear(); }

  /** Evict only transcript data; task/todo/artifact snapshots are independent. */
  trimMessages(keep: "head" | "tail", limit = MESSAGE_CACHE_LIMIT): boolean {
    if (this.order.length <= limit) return false;
    const removed = keep === "head" ? this.order.splice(limit) : this.order.splice(0, this.order.length - limit);
    for (const id of removed) {
      const message = this.messages.get(id);
      for (const item of message?.parts.values() ?? []) if (item.part.type === "subtask") this.subagentActivity.delete(item.part.childSessionId);
      this.messages.delete(id);
    }
    this.pendingEdits.clear();
    return true;
  }

  bounds(): { first?: number; last?: number } {
    return { first: this.messages.get(this.order[0] ?? "")?.messageSeq, last: this.messages.get(this.order.at(-1) ?? "")?.messageSeq };
  }

  /** 切会话时重置（复用实例避免反复分配）。 */
  reset(): void {
    this.messages.clear();
    this.order = [];
    this.pendingEdits.clear();
    this.subagentActivity.clear();
    this.todos = null;
    this.reads = [];
    this.editedPaths = [];
    this.summary = null;
    this.artifacts = [];
    this.summaryArtifacts = [];
    this.checkpoint = null;
  }

  /** 折叠单个事件（分支逻辑与原 project() 逐条对应，行为保持不变）。 */
  ingest(ev: LecternEvent): void {
    if (ev.type === "message.updated") {
      const m = (ev.data as { message: { id: string; role: string; messageSeq?: number; skill?: SelectedSkill; references?: string[]; error?: { name: string; message: string } } }).message;
      const existing = this.messages.get(m.id);
      if (existing) {
        // 失败收尾会补发带 error 的 message.updated——保留最新错误供 UI 展示
        if (m.error) existing.error = m.error;
        if (m.messageSeq !== undefined) existing.messageSeq = m.messageSeq;
      } else {
        this.messages.set(m.id, { id: m.id, role: m.role, messageSeq: m.messageSeq, parts: new Map(), ...(m.skill ? { skill: m.skill } : {}), ...(m.references?.length ? { references: m.references } : {}), ...(m.error ? { error: m.error } : {}) });
        this.order.push(m.id);
      }
    } else if (ev.type === "message.part.updated") {
      const p = (ev.data as { part: Part }).part;
      const m = this.messages.get(p.messageId);
      if (!m) return;
      // read 类工具调用 → 上下文读取列表（去重，最新在前）
      if (p.type === "tool" && (p.tool === "read" || p.tool === "glob" || p.tool === "grep")) {
        const path = (p.state.input as { path?: string } | undefined)?.path;
        if (path) {
          const i = this.reads.indexOf(path);
          if (i >= 0) this.reads.splice(i, 1);
          this.reads.unshift(path);
        }
      }
      // edit/write 工具定稿时，把该 path 最早的未消费 diff 挂上
      let diff: string | undefined;
      if (p.type === "tool" && (p.tool === "edit" || p.tool === "write")) {
        const path = (p.state.input as { path?: string } | undefined)?.path;
        const queue = path ? this.pendingEdits.get(path) : undefined;
        if (queue?.length) diff = queue.shift();
      }
      m.parts.set(p.id, { part: p, diff, ...(p.type === "subtask" ? { subagent: this.subagentActivity.get(p.childSessionId) } : {}) });
    } else if (ev.type === "message.part.delta") {
      const d = ev.data as { messageId: string; partId: string; delta: string };
      const m = this.messages.get(d.messageId);
      if (!m) return;
      const existing = m.parts.get(d.partId);
      if (existing && existing.part.type === "text") {
        m.parts.set(d.partId, { part: { ...existing.part, text: existing.part.text + d.delta } });
      } else {
        m.parts.set(d.partId, { part: { id: d.partId, type: "text", text: d.delta, messageId: d.messageId, sessionId: "" } });
      }
    } else if (ev.type === "file.edited") {
      const d = ev.data as { path: string; diff: string };
      const queue = this.pendingEdits.get(d.path) ?? [];
      queue.push(d.diff);
      this.pendingEdits.set(d.path, queue);
      // 本轮变更集（去重，最新在前）——文件 Tab 的「本轮改动」chips 与 Git 高亮
      const i = this.editedPaths.indexOf(d.path);
      if (i >= 0) this.editedPaths.splice(i, 1);
      this.editedPaths.unshift(d.path);
    } else if (ev.type === "todo.updated") {
      this.todos = (ev.data as { todos: TodoItem[] }).todos;
    } else if (ev.type === "session.error") {
      // 会话级错误（StreamIdleTimeout 看门狗断流 / APIError 重试耗尽 / LeaseExpired
      // 服务重启等）没有对应 assistant 消息落地——挂到最后一条 assistant（无则
      // 合成一条），让错误卡与「继续」chip 有处安放，用户看得到「断了、能续跑」。
      const d = ev.data as { name: string; message: string };
      const err = { name: d.name, message: d.message };
      const lastAssistantId = [...this.order].reverse().find((id) => this.messages.get(id)?.role === "assistant");
      if (lastAssistantId) {
        const m = this.messages.get(lastAssistantId)!;
        if (!m.error || m.error.message !== err.message) m.error = err;
      } else {
        const id = `error-${d.name.toLowerCase()}-${Date.now().toString(36)}`;
        this.messages.set(id, { id, role: "assistant", parts: new Map(), error: err });
        this.order.push(id);
      }
    } else if (ev.type === "session.summary") {
      // 任务终态小结（N5）：run 收尾的 AI 一句总结 + 结构化统计。
      // 覆盖式存储——一轮任务只有一条终态小结（多次 run 只保留最新）。
      this.summary = ev.data as SessionSummary;
      // run 边界切分：把本轮累积的产物封存为「这一轮 run 的产物集」，
      // 然后清空累积器等下一轮。多轮会话每轮 summary 只挂自己的产物。
      this.summaryArtifacts = this.artifacts;
      this.artifacts = [];
    } else if (ev.type === "artifact.created") {
      // 任务产物（沙箱/工具产出的一次可交付文件）：按 artifactId 去重，
      // 最新在前。只进当前 run 的累积器，不跨轮（session.summary 会封存+清空）。
      const d = ev.data as { artifactId: string; path: string; bytes: number; contentType: string; downloadUrl: string; previewUrl?: string };
      if (!d.artifactId) return;
      const existing = this.artifacts.findIndex((a) => a.artifactId === d.artifactId);
      if (existing >= 0) this.artifacts.splice(existing, 1);
      this.artifacts.unshift({
        artifactId: d.artifactId,
        path: d.path,
        bytes: d.bytes,
        contentType: d.contentType,
        downloadUrl: d.downloadUrl,
        ...(d.previewUrl ? { previewUrl: d.previewUrl } : {}),
        createdAt: Date.now(),
      });
    } else if (ev.type === "session.checkpoint") {
      // 长任务中途进度快照（N6）：运行中的「中间落点」，覆盖式保留最新。
      this.checkpoint = ev.data as SessionCheckpoint;
    } else if (ev.type === "session.rewound") {
      // 回溯重发：宿主已截断转录，这里同步裁掉目标消息及其后的本地状态。
      // 重放场景（断线重连 from seq 0）旧事件先重建旧状态、rewound 再裁掉、
      // 新 run 事件接着建新分支——最终态与最新转录一致。目标不在当前投影
      // （如刚整页刷新、历史转录已截断）时为幂等 no-op。
      const d = ev.data as { fromMessageId: string };
      const idx = this.order.indexOf(d.fromMessageId);
      if (idx >= 0) {
        for (const id of this.order.slice(idx)) this.messages.delete(id);
        this.order = this.order.slice(0, idx);
      }
      // 被删 run 的派生状态一并清掉，避免残留旧「任务小结/断点」误导续跑
      this.summary = null;
      this.checkpoint = null;
      this.todos = null;
      this.artifacts = [];
      this.summaryArtifacts = [];
    } else if (ev.type === "subagent.started") {
      const d = ev.data as { id: string };
      this.subagentActivity.set(d.id, { steps: [] });
    } else if (ev.type === "subagent.step") {
      const d = ev.data as { id: string; tool: string; title?: string; state?: string };
      const activity = this.subagentActivity.get(d.id) ?? { steps: [] };
      activity.steps.push({ tool: d.tool, title: d.title, state: d.state });
      this.subagentActivity.set(d.id, activity);
    } else if (ev.type === "subagent.finished") {
      const d = ev.data as { id: string; state: string; durationMs?: number; toolCalls?: number };
      const activity = this.subagentActivity.get(d.id) ?? { steps: [] };
      activity.finished = { state: d.state, durationMs: d.durationMs, toolCalls: d.toolCalls };
      this.subagentActivity.set(d.id, activity);
    }
  }

  /** 折叠一批事件。prepend=true 时本批新建的消息插到时间线最前
   *  （触顶加载更早历史的场景；批内相对顺序保持，批与已加载的实时事件互不重叠）。 */
  ingestBatch(events: LecternEvent[], prepend = false): void {
    if (!prepend) {
      for (const ev of events) this.ingest(ev);
      return;
    }
    const newIds: string[] = [];
    for (const ev of events) {
      const before = this.order.length;
      this.ingest(ev);
      if (this.order.length > before) newIds.push(this.order[this.order.length - 1]!);
    }
    if (newIds.length) {
      const fresh = new Set(newIds);
      this.order = [...newIds, ...this.order.filter((id) => !fresh.has(id))];
    }
  }

  /** 生成渲染快照（数组为浅拷贝，part 对象引用共享）。 */
  data(): ChatViewData {
    return {
      messages: this.order.map((id) => {
        const m = this.messages.get(id)!;
        return { id: m.id, role: m.role, messageSeq: m.messageSeq, parts: [...m.parts.values()], ...(m.skill ? { skill: m.skill } : {}), ...(m.references?.length ? { references: m.references } : {}), ...(m.error ? { error: m.error } : {}) };
      }),
      todos: this.todos,
      reads: this.reads.slice(0, 8),
      editedPaths: [...this.editedPaths],
      summary: this.summary,
      artifacts: [...this.artifacts],
      summaryArtifacts: [...this.summaryArtifacts],
      checkpoint: this.checkpoint,
    };
  }
}
