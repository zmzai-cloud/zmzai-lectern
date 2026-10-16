/**
 * 记忆候选管线（K1 §2.3 写入链前半）：
 * task_delivered 后异步小模型提炼 → syncPolicy 门控 → memory_candidates 表
 * （manual=pending 待审 / auto=approved 直通）。outbox 入队在 T19b 消费 approved。
 *
 * 提炼输入=本次 run 新增的纯文本 transcript（框架 extractRunTranscript 已排除
 * thinking/toolCall/合成占位），不依赖 Next 侧 deliveries.db——Host 进程独立可跑。
 * 模型输出容错解析（剥 code fence、截取首个 JSON 数组），单条校验失败跳过不整批作废。
 */
import { openMemoryDb } from "./binding.js";

export type MemoryCandidateKind = "convention" | "command" | "decision" | "pitfall";
export type MemoryCandidateStatus = "pending" | "approved" | "discarded";

const KINDS: readonly MemoryCandidateKind[] = ["convention", "command", "decision", "pitfall"];
const MAX_CANDIDATES = 5;
const MAX_STATEMENT_CHARS = 500;
const MAX_TRANSCRIPT_CHARS = 6000;

export type MemoryCandidateRow = {
  id: number;
  projectId: string;
  statement: string;
  kind: MemoryCandidateKind;
  evidence: unknown;
  scope: string;
  status: MemoryCandidateStatus;
  createdAt: string;
};

export type ExtractedCandidate = {
  statement: string;
  kind: MemoryCandidateKind;
  evidence?: { files?: string[]; commit?: string };
  scope: "project" | "branch";
};

export function listCandidates(projectId: string, status?: MemoryCandidateStatus): MemoryCandidateRow[] {
  const rows = (
    status
      ? openMemoryDb(projectId).prepare("SELECT * FROM memory_candidates WHERE projectId = ? AND status = ? ORDER BY id DESC").all(projectId, status)
      : openMemoryDb(projectId).prepare("SELECT * FROM memory_candidates WHERE projectId = ? ORDER BY id DESC").all(projectId)
  ) as Array<Record<string, unknown>>;
  return rows.map(rowToCandidate);
}

export function actCandidate(
  projectId: string,
  id: number,
  action: "approve" | "discard",
  statement?: string,
): MemoryCandidateRow | null {
  const db = openMemoryDb(projectId);
  const next = action === "approve" ? "approved" : "discarded";
  if (statement !== undefined) {
    const trimmed = statement.trim();
    if (trimmed.length < 4 || trimmed.length > MAX_STATEMENT_CHARS) return null;
    const changed = db.prepare("UPDATE memory_candidates SET statement = ?, status = ? WHERE id = ? AND projectId = ? AND status = 'pending'").run(trimmed, next, id, projectId);
    if (changed.changes !== 1) return null;
  } else {
    const changed = db.prepare("UPDATE memory_candidates SET status = ? WHERE id = ? AND projectId = ? AND status = 'pending'").run(next, id, projectId);
    if (changed.changes !== 1) return null;
  }
  const row = db.prepare("SELECT * FROM memory_candidates WHERE id = ? AND projectId = ?").get(id, projectId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToCandidate(row) : null;
}

function rowToCandidate(row: Record<string, unknown>): MemoryCandidateRow {
  return {
    id: Number(row.id),
    projectId: String(row.projectId),
    statement: String(row.statement),
    kind: String(row.kind) as MemoryCandidateKind,
    evidence: row.evidence ? JSON.parse(String(row.evidence)) : null,
    scope: String(row.scope),
    status: String(row.status) as MemoryCandidateStatus,
    createdAt: String(row.createdAt),
  };
}

/** 系统提示（zh 产品语境）。只收 JSON 数组，规则钉死「交付中明确成立的事实」。 */
export function buildExtractionPrompt(transcript: Array<{ role: "user" | "assistant"; text: string }>): string {
  const label = (role: "user" | "assistant") => (role === "user" ? "【用户】" : "【助手】");
  const lines: string[] = [];
  let used = 0;
  for (const message of [...transcript].reverse()) {
    const line = `${label(message.role)}${message.text}`;
    if (used + line.length > MAX_TRANSCRIPT_CHARS && lines.length > 0) break;
    lines.unshift(line);
    used += line.length;
  }
  return [
    "你是项目记忆提炼器。从下面的任务交付对话中提炼值得长期记住的项目知识候选。",
    '只输出一个 JSON 数组（不要其他文字），每项形如 {"statement":"一句中文陈述","kind":"convention|command|decision|pitfall","evidence":{"files":["..."],"commit":"..."},"scope":"project|branch"}。',
    "规则：只提炼对话中明确成立的事实——项目约定(convention)/有效命令(command)/架构决策(decision)/故障结论(pitfall)；最多 5 条；泛泛而谈、一次性信息、凭据或个人数据不要；scope 用 branch 当结论仅适用于未合并分支。",
    "",
    "交付对话：",
    ...lines,
  ].join("\n");
}

/** 容错解析：剥 code fence → 截取首个 [ 到最后一个 ] → JSON.parse → 逐条校验。 */
export function parseCandidateOutput(raw: string | null): ExtractedCandidate[] {
  if (!raw) return [];
  const unfenced = raw.replace(/```(?:json)?/g, "").trim();
  const start = unfenced.indexOf("[");
  const end = unfenced.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ExtractedCandidate[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const statement = typeof record.statement === "string" ? record.statement.trim() : "";
    if (statement.length < 4 || statement.length > MAX_STATEMENT_CHARS) continue;
    const kind = KINDS.includes(record.kind as MemoryCandidateKind) ? (record.kind as MemoryCandidateKind) : null;
    if (!kind) continue;
    const scope = record.scope === "branch" ? "branch" : "project";
    const key = `${kind}:${statement}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const evidenceRaw = record.evidence;
    const evidence =
      evidenceRaw && typeof evidenceRaw === "object"
        ? {
            ...(Array.isArray((evidenceRaw as { files?: unknown }).files)
              ? { files: ((evidenceRaw as { files: unknown[] }).files).filter((f): f is string => typeof f === "string").slice(0, 8) }
              : {}),
            ...(typeof (evidenceRaw as { commit?: unknown }).commit === "string"
              ? { commit: (evidenceRaw as { commit: string }).commit }
              : {}),
          }
        : undefined;
    out.push({ statement, kind, ...(evidence && Object.keys(evidence).length > 0 ? { evidence } : {}), scope });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

export type GenerateResult = { skipped: boolean; inserted: number; approvedDirectly: number };

export async function generateMemoryCandidates(
  input: {
    projectId: string;
    sessionId: string;
    transcript: Array<{ role: "user" | "assistant"; text: string }>;
    syncPolicy: "off" | "manual" | "auto";
  },
  deps: { callModel?: (prompt: string) => Promise<string | null> } = {},
): Promise<GenerateResult> {
  if (input.syncPolicy === "off") return { skipped: true, inserted: 0, approvedDirectly: 0 };
  const meaningful = input.transcript.filter((m) => m.text.trim().length > 0);
  if (meaningful.length === 0) return { skipped: true, inserted: 0, approvedDirectly: 0 };

  const callModel =
    deps.callModel ??
    (() => Promise.resolve(null)); // 默认无注入=不可提炼（接线方注入 relay 通道）
  const raw = await callModel(buildExtractionPrompt(meaningful));
  const candidates = parseCandidateOutput(raw);
  if (candidates.length === 0) return { skipped: false, inserted: 0, approvedDirectly: 0 };

  const db = openMemoryDb(input.projectId);
  const existing = new Set(
    (db.prepare("SELECT statement FROM memory_candidates WHERE projectId = ? AND status IN ('pending','approved')").all(input.projectId) as Array<{ statement: string }>).map((r) => r.statement),
  );

  const status = input.syncPolicy === "auto" ? "approved" : "pending";
  const now = new Date().toISOString();
  let inserted = 0;
  for (const candidate of candidates) {
    if (existing.has(candidate.statement)) continue;
    db.prepare(
      "INSERT INTO memory_candidates (projectId, statement, kind, evidence, scope, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      input.projectId,
      candidate.statement,
      candidate.kind,
      candidate.evidence ? JSON.stringify(candidate.evidence) : null,
      candidate.scope,
      status,
      now,
    );
    existing.add(candidate.statement);
    inserted += 1;
  }
  return { skipped: false, inserted, approvedDirectly: status === "approved" ? inserted : 0 };
}
