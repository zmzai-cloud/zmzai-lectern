import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vite 的内置模块枚举在部分 Node 版本上不含 node:sqlite（与 session-owner.test.ts 同一处理）。
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

import { DRAFT_SESSION_ID } from "./limits";
import { SqliteAttachmentStore } from "./store";

let dir: string;
let store: SqliteAttachmentStore;

const bytesOf = (text: string) => new TextEncoder().encode(text);

function upload(overrides: Partial<Parameters<SqliteAttachmentStore["put"]>[0]> = {}) {
  return {
    sessionId: "ses_one",
    filename: "notes.md",
    mediaType: "text/markdown",
    kind: "text" as const,
    bytes: bytesOf("# hello"),
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lectern-att-"));
  store = new SqliteAttachmentStore(dir);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SqliteAttachmentStore", () => {
  it("写入后可按 id 读回元数据与正文", async () => {
    const record = store.put(upload());
    expect(record.id.startsWith("att_")).toBe(true);
    expect(record.size).toBe(7);
    expect(record.status).toBe("processing");
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);

    const fetched = store.get(record.id);
    expect(fetched?.filename).toBe("notes.md");

    const opened = store.open(record.id);
    expect(opened).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of opened!.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("# hello");
  });

  it("内容寻址：同内容只落一份 blob，但元数据行各自独立", () => {
    const first = store.put(upload({ sessionId: "ses_a" }));
    const second = store.put(upload({ sessionId: "ses_b", filename: "copy.md" }));
    expect(second.sha256).toBe(first.sha256);
    expect(store.stats().blobs).toBe(1);
    expect(store.stats().rows).toBe(2);
  });

  it("blob 落在内容寻址路径上，正文与上传字节一致", () => {
    const record = store.put(upload({ bytes: bytesOf("payload") }));
    const path = store.blobPath(record.sha256);
    expect(readFileSync(path).toString("utf8")).toBe("payload");
    // 目录按 digest 前两位分片
    expect(path).toContain(join("attachments", "blobs", record.sha256.slice(0, 2)));
  });

  it("bind 清除 TTL 并把附件挂到消息上", () => {
    const record = store.put(upload());
    expect(record.expiresAt).toBeDefined();
    const bound = store.bind(record.id, "msg_1", "ses_real");
    expect(bound?.messageId).toBe("msg_1");
    expect(bound?.sessionId).toBe("ses_real");
    expect(bound?.expiresAt).toBeUndefined();
    expect(store.get(record.id)?.expiresAt).toBeUndefined();
  });

  it("getScoped 只放行本会话；草稿可在未绑定时被会话取用", () => {
    const draft = store.put(upload({ sessionId: DRAFT_SESSION_ID }));
    const other = store.put(upload({ sessionId: "ses_other", filename: "other.md" }));
    expect(store.getScoped(draft.id, "ses_one")?.id).toBe(draft.id);
    expect(store.getScoped(other.id, "ses_one")).toBeNull();
    // 绑定后草稿不再对外放行
    store.bind(draft.id, "msg_9", "ses_one");
    expect(store.getScoped(draft.id, "ses_two")).toBeNull();
  });

  it("已绑定的附件拒绝删除，未绑定的可删并在无引用时回收 blob", () => {
    const bound = store.put(upload());
    store.bind(bound.id, "msg_1");
    expect(store.deleteUnbound(bound.id)).toBe(false);
    expect(store.get(bound.id)).not.toBeNull();

    // 内容必须与上一份不同，否则 blob 仍被 bound 引用，回收断言会假通过
    const loose = store.put(upload({ filename: "loose.md", bytes: bytesOf("loose payload") }));
    const blob = store.blobPath(loose.sha256);
    expect(store.deleteUnbound(loose.id)).toBe(true);
    expect(store.get(loose.id)).toBeNull();
    expect(() => readFileSync(blob)).toThrow();
    // 被引用的 blob 仍在
    expect(readFileSync(store.blobPath(bound.sha256)).toString("utf8")).toBe("# hello");
  });

  it("删掉一份副本不会回收仍被引用的 blob（引用计数）", () => {
    const first = store.put(upload({ sessionId: "ses_a" }));
    const second = store.put(upload({ sessionId: "ses_b" }));
    expect(store.deleteUnbound(first.id)).toBe(true);
    expect(readFileSync(store.blobPath(second.sha256)).toString("utf8")).toBe("# hello");
    expect(store.deleteUnbound(second.id)).toBe(true);
    expect(() => readFileSync(store.blobPath(second.sha256))).toThrow();
  });

  it("pruneExpired 只清理过期且未绑定的附件", () => {
    const expired = store.put(upload());
    const bound = store.put(upload({ filename: "bound.md" }));
    store.bind(bound.id, "msg_1");
    // 直接把过期时间改到过去（等价于 TTL 到期）
    (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE attachments SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), expired.id);

    expect(store.pruneExpired()).toBe(1);
    expect(store.get(expired.id)).toBeNull();
    expect(store.get(bound.id)).not.toBeNull();
  });

  it("deleteForSession 连带回收该会话独占的 blob", () => {
    store.put(upload({ sessionId: "ses_a" }));
    store.put(upload({ sessionId: "ses_b", bytes: bytesOf("other") }));
    expect(store.deleteForSession("ses_a")).toBe(1);
    expect(store.list("ses_a")).toHaveLength(0);
    expect(store.stats().blobs).toBe(1);
  });

  it("updateExtraction 可写入与清空提取结果", () => {
    const record = store.put(upload());
    const ready = store.updateExtraction(record.id, {
      status: "ready",
      extraction: { characters: 7, warnings: ["部分页无文本"] },
    });
    expect(ready?.status).toBe("ready");
    expect(store.get(record.id)?.extraction?.characters).toBe(7);

    const failed = store.updateExtraction(record.id, {
      status: "error",
      error: { code: "corrupted", message: "文件损坏", retryable: false },
    });
    expect(failed?.error?.code).toBe("corrupted");
    // 重试成功后清空 error
    store.updateExtraction(record.id, { status: "ready", error: undefined });
    expect(store.get(record.id)?.error).toBeUndefined();
  });

  it("listForMessages 批量取回（历史消息渲染，避免 N+1）", () => {
    const a = store.put(upload({ filename: "a.md" }));
    const b = store.put(upload({ filename: "b.md", bytes: bytesOf("b") }));
    store.bind(a.id, "msg_1");
    store.bind(b.id, "msg_2");
    expect(store.listForMessages(["msg_1", "msg_2"]).map((r) => r.filename)).toEqual(["a.md", "b.md"]);
    expect(store.listForMessages([])).toHaveLength(0);
  });

  it("重开同一目录时迁移幂等，数据不丢", () => {
    const record = store.put(upload());
    store.close();
    const reopened = new SqliteAttachmentStore(dir);
    expect(reopened.get(record.id)?.filename).toBe("notes.md");
    expect(readdirSync(join(dir, "attachments", "blobs")).length).toBeGreaterThan(0);
    reopened.close();
  });

  it("已绑定附件在 blob 丢失时仍可查询（历史卡片显示不可用而不是渲染失败）", () => {
    const record = store.put(upload());
    store.bind(record.id, "msg_1");
    rmSync(store.blobPath(record.sha256));
    expect(store.get(record.id)?.filename).toBe("notes.md");
    expect(store.blobExists(record.id)).toBe(false);
    expect(store.open(record.id)).toBeNull();
  });

  it("不存在的 id 安全返回 null", () => {
    expect(store.get("att_missing")).toBeNull();
    expect(store.open("att_missing")).toBeNull();
    expect(store.bind("att_missing", "msg_1")).toBeNull();
    expect(store.deleteUnbound("att_missing")).toBe(false);
  });
});

/** 保证测试夹具本身没有把临时目录写到仓库内。 */
describe("测试隔离", () => {
  it("使用系统临时目录", () => {
    writeFileSync(join(dir, "probe"), "x");
    expect(dir.startsWith(tmpdir())).toBe(true);
  });
});
