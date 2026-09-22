/**
 * AttachmentStore（规格 2026-09-17 §9.2 / §20.4）。
 *
 * 【为什么必须有独立存储】旧链路把文件编码成 data URL 放进 prompt JSON，随 prompt
 * 落到 event 与消息 part 里：base64 让 1MB 文件变成 1.33MB 文本，既撑爆 SQLite，
 * 也让「查看历史」要反序列化整份文件。现在二进制只落在 blob store，数据库只存
 * id / 文件名 / MIME / 大小 / digest / 状态 / 存储引用。
 *
 * 【内容寻址】blob 按 sha256 命名（`blobs/<前两位>/<sha256>`），同内容只存一份；
 * 但元数据行仍按 (session, user) 隔离授权——去重是存储优化，不是授权合并。
 *
 * 【作用域】每个项目一个库（`<dataDirFor(project)>/attachments.db`），与 zmzai.db
 * 同目录但独立文件：附件表的迁移节奏与 framework 的会话表无关，分开避免互相
 * 触发对方的 schema 升级。
 *
 * 【单用户本地的授权模型】Lectern 是可本地运行的单用户工作站，会话/项目边界才是
 * 真实隔离边界，因此授权按 session 校验（+项目天然隔离）。userId 列保留并在
 * 多用户部署时参与校验，但本地模式下不构成额外约束。
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, type ReadStream } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ATTACHMENT_LIMITS, DRAFT_SESSION_ID, type AttachmentKind } from "./limits.js";
import type { AttachmentError, AttachmentReceipt, AttachmentStatus } from "./types.js";

export type ExtractionSummary = {
  pages?: number;
  sheets?: string[];
  slides?: number;
  characters?: number;
  warnings?: string[];
};

export type AttachmentRecord = {
  id: string;
  sessionId: string;
  userId: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  kind: AttachmentKind;
  status: AttachmentStatus;
  messageId?: string;
  extraction?: ExtractionSummary;
  error?: AttachmentError;
  createdAt: string;
  updatedAt: string;
  /** 未绑定消息时的过期时刻（ISO）；绑定后为 undefined。 */
  expiresAt?: string;
};

export type AttachmentUpload = {
  sessionId: string;
  userId?: string;
  filename: string;
  mediaType: string;
  kind: AttachmentKind;
  /** 原始字节。 */
  bytes: Uint8Array;
  /** 服务端嗅探后的真实 MIME；缺省时沿用 mediaType。 */
  sniffedMediaType?: string;
  status?: AttachmentStatus;
};

const SCHEMA_VERSION = 1;

function nowIso(): string {
  return new Date().toISOString();
}

/** content-addressed blob 相对路径：前两位做目录分片，避免单目录堆几十万个文件。 */
function blobRelativePath(sha256: string): string {
  return join("blobs", sha256.slice(0, 2), sha256);
}

/** 解析结果的旁挂文件相对路径。与 blob 同样按摘要寻址——同内容只需解析一次。 */
function extractedRelativePath(sha256: string): string {
  return join("extracted", sha256.slice(0, 2), `${sha256}.json`);
}

type Row = {
  id: string;
  session_id: string;
  user_id: string;
  filename: string;
  media_type: string;
  size: number;
  sha256: string;
  kind: string;
  status: string;
  message_id: string | null;
  extraction: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
};

function toRecord(row: Row): AttachmentRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    filename: row.filename,
    mediaType: row.media_type,
    size: row.size,
    sha256: row.sha256,
    kind: row.kind as AttachmentKind,
    status: row.status as AttachmentStatus,
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.extraction ? { extraction: JSON.parse(row.extraction) as ExtractionSummary } : {}),
    ...(row.error ? { error: JSON.parse(row.error) as AttachmentError } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  };
}

/** 单个项目的附件存储：SQLite 元数据 + 内容寻址 blob。 */
export class SqliteAttachmentStore {
  readonly dataDir: string;
  private readonly db: DatabaseSync;
  private readonly blobsDir: string;
  private closed = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.blobsDir = join(dataDir, "attachments");
    mkdirSync(this.blobsDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "attachments.db"));
    // WAL：SSE 轮询/并发上传与读取互不阻塞；busy_timeout 规避瞬时竞争。
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    const current = (this.db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)?.user_version ?? 0;
    if (current >= SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        user_id     TEXT NOT NULL DEFAULT '',
        filename    TEXT NOT NULL,
        media_type  TEXT NOT NULL,
        size        INTEGER NOT NULL,
        sha256      TEXT NOT NULL,
        kind        TEXT NOT NULL,
        status      TEXT NOT NULL,
        message_id  TEXT,
        extraction  TEXT,
        error       TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        expires_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_sha ON attachments(sha256);
      CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_expires ON attachments(expires_at);
    `);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /** blob 的绝对路径。写盘与读取都经此，避免两处各拼一次路径。 */
  blobPath(sha256: string): string {
    return join(this.blobsDir, blobRelativePath(sha256));
  }

  /**
   * 解析结果缓存：**旁挂文件**而不是数据库列。
   *
   * 【为什么存文件不存库】一份 300 页 PDF 的提取正文可以有几 MB，塞进 SQLite 会让
   * 每次 `SELECT *`（列表、历史渲染）都可能拖着这份正文走。而它天然是「按文件内容
   * 寻址」的派生物——同一份文件不管从哪个会话上传都只需要解析一次，所以它跟 blob
   * 一样按 sha256 命名，并与 blob 同生命周期回收。
   *
   * 【为什么不在读取时现场解析】`read_attachment` 是模型随时会调的工具，一次 PDF
   * 解析要几秒到几十秒。工具调用卡几十秒不只是慢——它会让模型以为工具坏了。
   */
  extractedDocumentPath(sha256: string): string {
    return join(this.blobsDir, extractedRelativePath(sha256));
  }

  saveExtractedDocument(sha256: string, payload: unknown): void {
    const path = this.extractedDocumentPath(sha256);
    mkdirSync(join(this.blobsDir, "extracted", sha256.slice(0, 2)), { recursive: true });
    writeFileSync(path, JSON.stringify(payload));
  }

  /** 读缓存载荷。**只负责读**，版本判定交给调用方（它才知道当前适配器版本）。 */
  loadExtractedDocument(sha256: string): unknown | null {
    const path = this.extractedDocumentPath(sha256);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      // 缓存损坏不是用户能处理的问题：当作没有缓存，下次解析重写
      return null;
    }
  }

  dropExtractedDocument(sha256: string): void {
    try {
      const path = this.extractedDocumentPath(sha256);
      if (existsSync(path)) rmSync(path);
    } catch {
      /* 缓存删不掉不影响正确性（版本不符时会重算） */
    }
  }

  put(input: AttachmentUpload): AttachmentRecord {
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const mediaType = input.sniffedMediaType ?? input.mediaType;
    const blob = this.blobPath(sha256);
    if (!existsSync(blob)) {
      mkdirSync(join(this.blobsDir, "blobs", sha256.slice(0, 2)), { recursive: true });
      writeFileSync(blob, input.bytes);
    }
    const timestamp = nowIso();
    const record: AttachmentRecord = {
      id: `att_${randomUUID()}`,
      sessionId: input.sessionId,
      userId: input.userId ?? "",
      filename: input.filename,
      mediaType,
      size: input.bytes.byteLength,
      sha256,
      kind: input.kind,
      status: input.status ?? "processing",
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: new Date(Date.now() + ATTACHMENT_LIMITS.unboundTtlMs).toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO attachments (id, session_id, user_id, filename, media_type, size, sha256, kind, status, message_id, extraction, error, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.userId,
        record.filename,
        record.mediaType,
        record.size,
        record.sha256,
        record.kind,
        record.status,
        record.createdAt,
        record.updatedAt,
        record.expiresAt ?? null,
      );
    return record;
  }

  get(id: string): AttachmentRecord | null {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /**
   * 授权读取：只有属于该 session 的附件才能被取用。
   * 草稿（`__draft__`）在绑定到真实会话后 `session_id` 会被改写，因此草稿与
   * 真实会话之间不需要额外的白名单。
   */
  getScoped(id: string, sessionId: string): AttachmentRecord | null {
    const record = this.get(id);
    if (!record) return null;
    if (record.sessionId === sessionId) return record;
    // 未发送的草稿附件可以在会话内被绑定（发送链路会先 bind）。
    if (record.sessionId === DRAFT_SESSION_ID && !record.messageId) return record;
    return null;
  }

  list(sessionId: string): AttachmentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM attachments WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as Row[];
    return rows.map(toRecord);
  }

  /** 已绑定消息的附件（历史消息渲染用，避免逐条消息 N 次查询）。 */
  listForMessages(messageIds: readonly string[]): AttachmentRecord[] {
    if (messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM attachments WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...messageIds) as Row[];
    return rows.map(toRecord);
  }

  /**
   * 还停在 `processing` 的记录（恢复扫描用）。
   *
   * 跨会话查全库：进程重启后我们不知道是哪个会话留下了半截状态，而「谁留下的」
   * 对恢复没有意义——重建解析只需要字节与文件名。
   */
  listProcessing(): AttachmentRecord[] {
    const rows = this.db.prepare("SELECT * FROM attachments WHERE status = 'processing' ORDER BY updated_at ASC").all() as Row[];
    return rows.map(toRecord);
  }

  open(id: string): { record: AttachmentRecord; stream: ReadStream } | null {
    const record = this.get(id);
    if (!record) return null;
    const path = this.blobPath(record.sha256);
    if (!existsSync(path)) return null;
    return { record, stream: createReadStream(path) };
  }

  blobExists(id: string): boolean {
    const record = this.get(id);
    return !!record && existsSync(this.blobPath(record.sha256));
  }

  /** 绑定消息：清除 TTL，附件从此跟随会话保留策略。 */
  bind(id: string, messageId: string, sessionId?: string): AttachmentRecord | null {
    const record = this.get(id);
    if (!record) return null;
    const timestamp = nowIso();
    this.db
      .prepare("UPDATE attachments SET message_id = ?, session_id = ?, expires_at = NULL, updated_at = ? WHERE id = ?")
      .run(messageId, sessionId ?? record.sessionId, timestamp, id);
    return { ...record, messageId, sessionId: sessionId ?? record.sessionId, updatedAt: timestamp, expiresAt: undefined };
  }

  updateExtraction(id: string, patch: Partial<Pick<AttachmentRecord, "status" | "extraction" | "error">>): AttachmentRecord | null {
    const record = this.get(id);
    if (!record) return null;
    const next: AttachmentRecord = { ...record, ...patch, updatedAt: nowIso() };
    // patch 里显式给的 undefined 表示「清空该字段」（如重试成功后清掉 error）。
    if ("extraction" in patch && patch.extraction === undefined) delete next.extraction;
    if ("error" in patch && patch.error === undefined) delete next.error;
    this.db
      .prepare("UPDATE attachments SET status = ?, extraction = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(
        next.status,
        next.extraction ? JSON.stringify(next.extraction) : null,
        next.error ? JSON.stringify(next.error) : null,
        next.updatedAt,
        id,
      );
    return next;
  }

  /** 删除未绑定消息的附件（取消上传、移除卡片）。已绑定的拒绝删除。 */
  deleteUnbound(id: string): boolean {
    const record = this.get(id);
    if (!record || record.messageId) return false;
    this.db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    this.releaseBlobIfUnreferenced(record.sha256);
    return true;
  }

  /** 清理超过 TTL 的未绑定附件，返回清理条数。 */
  pruneExpired(now: Date = new Date()): number {
    const rows = this.db
      .prepare("SELECT * FROM attachments WHERE message_id IS NULL AND expires_at IS NOT NULL AND expires_at < ?")
      .all(now.toISOString()) as Row[];
    for (const row of rows) {
      this.db.prepare("DELETE FROM attachments WHERE id = ?").run(row.id);
      this.releaseBlobIfUnreferenced(row.sha256);
    }
    return rows.length;
  }

  /** 删除会话：清理其全部附件（含已绑定的），并回收无引用 blob。 */
  deleteForSession(sessionId: string): number {
    const all = this.db.prepare("SELECT * FROM attachments WHERE session_id = ?").all(sessionId) as Row[];
    if (all.length === 0) return 0;
    this.db.prepare("DELETE FROM attachments WHERE session_id = ?").run(sessionId);
    for (const hash of new Set(all.map((row) => row.sha256))) this.releaseBlobIfUnreferenced(hash);
    return all.length;
  }

  /** 只在没有任何元数据行引用该 digest 时删除 blob 与其解析缓存（去重存储的引用计数）。 */
  private releaseBlobIfUnreferenced(sha256: string): void {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE sha256 = ?").get(sha256) as { n: number } | undefined;
    if ((row?.n ?? 0) > 0) return;
    const path = this.blobPath(sha256);
    try {
      if (existsSync(path)) rmSync(path);
    } catch {
      /* blob 已被清理或权限不足：元数据行已经删掉，不让 GC 失败阻塞调用方 */
    }
    this.dropExtractedDocument(sha256);
  }

  /** 存储统计（体检/测试用）。 */
  stats(): { rows: number; blobs: number; bytes: number } {
    const row = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS total FROM attachments").get() as
      | { n: number; total: number }
      | undefined;
    const blobsRoot = join(this.blobsDir, "blobs");
    let blobs = 0;
    let bytes = 0;
    if (existsSync(blobsRoot)) {
      for (const shard of readdirSync(blobsRoot)) {
        let files: string[] = [];
        try {
          files = readdirSync(join(blobsRoot, shard));
        } catch {
          continue;
        }
        for (const file of files) {
          blobs += 1;
          try {
            bytes += statSync(join(blobsRoot, shard, file)).size;
          } catch {
            /* 并发删除：忽略 */
          }
        }
      }
    }
    return { rows: row?.n ?? 0, blobs, bytes };
  }

  /** 幂等关闭：优雅退出路径与测试可能在别处已经关过一次。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __lecternAttachmentStores: Map<string, SqliteAttachmentStore> | undefined;
}

/** 按项目 dataDir 缓存 store（dev 模块重载经 globalThis 复用，避免多份 SQLite 句柄）。 */
export function attachmentStoreFor(dataDir: string): SqliteAttachmentStore {
  const cache = (globalThis.__lecternAttachmentStores ??= new Map());
  const cached = cache.get(dataDir);
  if (cached) return cached;
  const store = new SqliteAttachmentStore(dataDir);
  cache.set(dataDir, store);
  return store;
}

/** 存储记录 → 上传回执（规格 §9.1）。刻意不含本地绝对路径与 blob 位置。 */
export function receiptOf(record: AttachmentRecord): AttachmentReceipt {
  return {
    attachmentId: record.id,
    filename: record.filename,
    mediaType: record.mediaType,
    size: record.size,
    sha256: record.sha256,
    kind: record.kind,
    status: record.status,
    ...(record.extraction ? { extraction: record.extraction } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}
