import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vite 的内置模块枚举在部分 Node 版本上不含 node:sqlite（与 session-owner.test.ts 同一处理）。
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

/**
 * 端到端：上传 → 解析 → 模型按定位读取（规格 2 §10.1 / §10.2 / §18）。
 *
 * 【为什么这条用例必须存在】前面的单测各自证明了「适配器能读出文本」「store 能落库」
 * 「工具能按 locator 取块」，但没有一条证明**它们连起来是通的**——而分节 locator 的
 * 意义恰恰在于「模型说第 4 页，用户翻开第 4 页能看到同一段话」。这条用例走的是真实
 * 的 store、真实的解析器、真实由 host 注入的工具。
 */

const state = vi.hoisted(() => ({ data: "", projects: [] as Array<{ id: string; path: string }> }));
vi.mock("@/lib/projects", () => ({
  registeredProjects: () => state.projects,
  dataDirFor: (project: { id: string }) => join(state.data, project.id),
  getActiveProject: () => state.projects[0],
}));
vi.mock("@/lib/worktree", () => ({ worktreeForSession: () => undefined }));

import type { AttachmentProvider } from "@zmzai/agent-framework";
import { createAttachmentTools } from "@zmzai/agent-framework";

import { pdfOf } from "./extract/fixtures.js";
import { extractAttachment } from "./extract/queue.js";
import { attachmentProviderFor } from "./scope.js";
import { attachmentStoreFor, type SqliteAttachmentStore } from "./store.js";

const SESSION = "ses_pipeline";
let root: string;
let store: SqliteAttachmentStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lectern-pipeline-"));
  const projectPath = join(root, "workspace");
  mkdirSync(projectPath, { recursive: true });
  state.projects = [{ id: "proj_one", path: projectPath }];
  state.data = join(root, "data");
  store = attachmentStoreFor(join(state.data, "proj_one"));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

async function ready(filename: string, bytes: Uint8Array, kind: "document" | "text" | "spreadsheet" = "document") {
  const record = store.put({ sessionId: SESSION, filename, mediaType: "application/octet-stream", kind, bytes });
  await extractAttachment(store, record.id);
  return store.get(record.id)!;
}

function tool(id: string, provider: AttachmentProvider) {
  const found = createAttachmentTools(provider).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`工具 ${id} 没有注册`);
  return found;
}

const scope = { sessionId: SESSION };

describe("上传 → 解析 → 按定位读取", () => {
  it("PDF：read_attachment 按页码取回同一页，输出带 locator", async () => {
    const record = await ready("合同.pdf", pdfOf([["第一页 甲方"], ["第二页 乙方"], ["第三页 价款 700 万"]]));
    expect(record.status).toBe("ready");
    expect(record.extraction?.pages).toBe(3);

    const provider = attachmentProviderFor(join(state.data, "proj_one"));
    const read = tool("read_attachment", provider);
    const result = await read.execute({ attachmentId: record.id, page: 3 } as never, { sessionId: SESSION } as never);
    expect(result.output).toContain("第 3 页");
    expect(result.output).toContain("价款 700 万");
    // 只要了第 3 页，就不该把第 1 页的正文也带出来
    expect(result.output).not.toContain("第一页 甲方");
  });

  it("不带定位时先给大纲，让模型知道有哪些位置可读（而不是盲试页码）", async () => {
    const record = await ready("合同.pdf", pdfOf([["甲"], ["乙"]]));
    const provider = attachmentProviderFor(join(state.data, "proj_one"));
    const result = await tool("read_attachment", provider).execute({ attachmentId: record.id } as never, { sessionId: SESSION } as never);
    expect(result.output).toContain("p1");
    expect(result.output).toContain("p2");
    expect(result.output).toContain("第 1 页");
  });

  it("search_attachments 找到的是字面量命中，并回报定位", async () => {
    const record = await ready("合同.pdf", pdfOf([["第一条 标的"], ["第二条 价款 700 万"], ["第三条 期限"]]));
    const provider = attachmentProviderFor(join(state.data, "proj_one"));
    const result = await tool("search_attachments", provider).execute({ query: "700 万" } as never, { sessionId: SESSION } as never);
    expect(result.output).toContain("第 2 页");
    expect(result.output).toContain("700 万");
  });

  it("定位不匹配时明确说没找到，不回落成整份文件", async () => {
    const record = await ready("合同.pdf", pdfOf([["只有一页"]]));
    const provider = attachmentProviderFor(join(state.data, "proj_one"));
    const result = await tool("read_attachment", provider).execute({ attachmentId: record.id, page: 99 } as never, { sessionId: SESSION } as never);
    expect(result.output).toMatch(/没找到|没有/);
    expect(result.output).not.toContain("只有一页");
  });

  it("文本附件的行号就是真实行号", async () => {
    const lines = Array.from({ length: 250 }, (_, index) => `line-${index + 1}`);
    const record = await ready("notes.txt", new TextEncoder().encode(lines.join("\n")), "text");
    const provider = attachmentProviderFor(join(state.data, "proj_one"));
    const result = await tool("read_attachment", provider).execute({ attachmentId: record.id, lineStart: 201, lineEnd: 210 } as never, { sessionId: SESSION } as never);
    expect(result.output).toContain("line-201");
    expect(result.output).not.toContain("line-1\n");
  });
});

describe("跨会话隔离（规格 §13）", () => {
  it("别的会话拿不到这份附件——包括结构化正文", async () => {
    const record = await ready("合同.pdf", pdfOf([["机密内容"]]));
    const provider = attachmentProviderFor(join(state.data, "proj_one"));
    expect(await provider.read(record.id, { sessionId: "ses_other" })).toBeNull();
    // `extract` 在 provider 契约里是可选的（没有它 framework 就不注册工具），
    // 这里断言 lectern 的 provider 一定实现了它
    expect(await provider.extract!(record.id, { sessionId: "ses_other" })).toBeNull();
    const result = await tool("read_attachment", provider).execute({ attachmentId: record.id } as never, { sessionId: "ses_other" } as never);
    expect(result.output).toContain("没有可用的结构化正文");
    expect(result.output).not.toContain("机密内容");
  });

  it("search_attachments 只搜本会话（没有 attachmentId 时也不跨会话）", async () => {
    await ready("合同.pdf", pdfOf([["本会话的内容"]]));
    const provider = attachmentProviderFor(join(state.data, "proj_one"));
    const result = await tool("search_attachments", provider).execute({ query: "本会话" } as never, { sessionId: "ses_other" } as never);
    expect(result.output).not.toContain("本会话的内容");
  });
});

describe("解析未完成时的行为", () => {
  it("processing 状态的附件不给正文（工具如实说明，而不是给半截内容）", async () => {
    const record = store.put({ sessionId: SESSION, filename: "big.pdf", mediaType: "application/pdf", kind: "document", bytes: pdfOf([["稍后才解析完"]]) });
    const provider = attachmentProviderFor(join(state.data, "proj_one"));
    expect(await provider.extract!(record.id, scope)).toBeNull();
    // 未就绪的不进清单：搜一个还没解析完的文件只会返回「没找到」，那是在误导模型
    const list = await provider.list!(scope);
    expect(list.map((item) => item.id)).not.toContain(record.id);
  });

  it("解析失败的附件（no_extractable_text）也不给正文", async () => {
    const record = await ready("scan.pdf", pdfOf([[]]));
    expect(record.status).toBe("error");
    const provider = attachmentProviderFor(join(state.data, "proj_one"));
    expect(await provider.extract!(record.id, scope)).toBeNull();
  });
});
