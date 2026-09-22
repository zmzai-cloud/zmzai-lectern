import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vite 的内置模块枚举在部分 Node 版本上不含 node:sqlite（与 session-owner.test.ts 同一处理）。
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

import { docxOf, paragraph, pdfOf } from "./extract/fixtures.js";
import { extractAttachment } from "./extract/queue.js";
import { EXTRACTOR_VERSION } from "./extract/index.js";
import { SqliteAttachmentStore } from "./store.js";

let dir: string;
let store: SqliteAttachmentStore;

const bytesOf = (text: string) => new TextEncoder().encode(text);

function put(filename: string, bytes: Uint8Array, kind: "text" | "document" | "image" | "spreadsheet" = "text") {
  return store.put({ sessionId: "ses_one", filename, mediaType: "application/octet-stream", kind, bytes });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lectern-extract-"));
  store = new SqliteAttachmentStore(dir);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("extractAttachment 的状态收敛（规格 §10.3）", () => {
  it("文本附件解析成功 → ready，并写入分节摘要", async () => {
    const record = put("note.txt", bytesOf("第一行\n第二行\n第三行"));
    expect(record.status).toBe("processing");
    await extractAttachment(store, record.id);
    const settled = store.get(record.id)!;
    expect(settled.status).toBe("ready");
    expect(settled.extraction?.characters).toBeGreaterThan(0);
    expect(settled.error).toBeUndefined();
  });

  it("解析结果落旁挂缓存，缓存里带适配器版本", async () => {
    const record = put("note.txt", bytesOf("内容"));
    await extractAttachment(store, record.id);
    const payload = store.loadExtractedDocument(record.sha256) as { extractorVersion: number; document: { sections: { text: string }[] } };
    expect(payload.extractorVersion).toBe(EXTRACTOR_VERSION);
    expect(payload.document.sections[0]!.text).toBe("内容");
  });

  it("同内容只存一份缓存（按摘要寻址）", async () => {
    const first = put("a.txt", bytesOf("同样的内容"));
    const second = put("b.txt", bytesOf("同样的内容"));
    await extractAttachment(store, first.id);
    const payload = store.loadExtractedDocument(second.sha256) as { document: { attachmentId: string } };
    // 缓存按内容共享，但里面的 attachmentId 是「第一次写进去的那条」——
    // 这不影响使用（工具按 id 校验归属，正文与 id 的对应由调用方保证）
    expect(payload.document.attachmentId).toBe(first.id);
  });

  it("图片不需要文本提取，直接 ready 且不带警告", async () => {
    const record = put("shot.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image");
    await extractAttachment(store, record.id);
    const settled = store.get(record.id)!;
    expect(settled.status).toBe("ready");
    expect(settled.extraction).toBeUndefined();
  });

  it("旧版 .xls 明确告知「只保存、不提取正文」", async () => {
    const record = put("legacy.xls", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), "spreadsheet");
    await extractAttachment(store, record.id);
    const settled = store.get(record.id)!;
    expect(settled.status).toBe("ready");
    expect(settled.extraction?.warnings?.[0]).toContain("不提取正文");
  });

  it("扫描件 PDF 报 no_extractable_text 且不可重试（重试一百次结果都一样）", async () => {
    const record = put("scan.pdf", pdfOf([[]]), "document");
    await extractAttachment(store, record.id);
    const settled = store.get(record.id)!;
    expect(settled.status).toBe("error");
    expect(settled.error?.code).toBe("no_extractable_text");
    expect(settled.error?.retryable).toBe(false);
    expect(settled.extraction).toBeUndefined();
  });

  it("损坏的 docx：直接定论为 corrupted 且不可重试（解析是纯函数，重试不会改变结果）", async () => {
    const record = put("broken.docx", bytesOf("这不是 zip"), "document");
    await extractAttachment(store, record.id);
    const settled = store.get(record.id)!;
    expect(settled.status).toBe("error");
    expect(settled.error?.code).toBe("corrupted");
    expect(settled.error?.retryable).toBe(false);
  });

  it("blob 丢失时给明确原因而不是静默卡住", async () => {
    const record = put("gone.txt", bytesOf("会被删掉"));
    rmSync(store.blobPath(record.sha256), { force: true });
    await extractAttachment(store, record.id);
    const settled = store.get(record.id)!;
    expect(settled.status).toBe("error");
    expect(settled.error?.message).toContain("不可用");
  });

  it("已定论的记录不会被重复解析覆盖（陈旧任务不该改写结果）", async () => {
    const record = put("note.txt", bytesOf("第一版"));
    await extractAttachment(store, record.id);
    // 模拟「队列里还挂着一个陈旧任务」：状态已经是 ready，再跑一次必须原样返回
    await extractAttachment(store, record.id);
    expect(store.get(record.id)!.status).toBe("ready");
  });

  it("排队期间被删除的附件不会被写回（避免复活已删记录）", async () => {
    const record = put("note.txt", bytesOf("内容"));
    store.deleteUnbound(record.id);
    await extractAttachment(store, record.id);
    expect(store.get(record.id)).toBeNull();
  });

  it("解析成功会清掉上一次留下的错误信息", async () => {
    const broken = put("note.docx", bytesOf("坏文件"), "document");
    await extractAttachment(store, broken.id);
    expect(store.get(broken.id)!.error).toBeDefined();
    // 用户换成一份好的文件重新添加：新记录必须从干净状态开始
    const good = put("good.docx", docxOf(paragraph("正文")), "document");
    await extractAttachment(store, good.id);
    const settled = store.get(good.id)!;
    expect(settled.status).toBe("ready");
    expect(settled.error).toBeUndefined();
  });
});

describe("恢复扫描（规格 §14：应用重启后卡住的附件）", () => {
  it("listProcessing 能找出还没定下来的记录", () => {
    put("a.txt", bytesOf("一"));
    const done = put("b.txt", bytesOf("二"));
    store.updateExtraction(done.id, { status: "ready" });
    expect(store.listProcessing().map((record) => record.filename)).toEqual(["a.txt"]);
  });
});
