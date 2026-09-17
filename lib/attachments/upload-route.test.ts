import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vite 的内置模块枚举在部分 Node 版本上不含 node:sqlite。
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

/** 只替换项目与 worktree 的解析；会话归属走**真实**的 resolveSessionOwner + 真实 sqlite。 */
const state = vi.hoisted(() => ({ data: "", projects: [] as Array<{ id: string; path: string }> }));
vi.mock("@/lib/projects", () => ({
  registeredProjects: () => state.projects,
  dataDirFor: (project: { id: string }) => join(state.data, project.id),
  getActiveProject: () => state.projects[0],
}));
vi.mock("@/lib/worktree", () => ({ worktreeForSession: () => undefined }));

import { NextRequest } from "next/server";
import { DELETE as deleteAttachment, GET as getAttachment } from "../../app/api/sessions/[id]/attachments/[attachmentId]/route";
import { GET as listAttachments, POST as uploadAttachment } from "../../app/api/sessions/[id]/attachments/route";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const SESSION = "ses_upload_target";
const OTHER_SESSION = "ses_other";
const PROJECT = { id: "proj_one", path: "" };
let root: string;

const params = (id: string, attachmentId?: string) =>
  ({ params: Promise.resolve(attachmentId === undefined ? { id } : { id, attachmentId }) }) as never;

function fileRequest(sessionId: string, bytes: Uint8Array, name: string, type = "") {
  const form = new FormData();
  form.append("file", new File([bytes as BlobPart], name, { type }));
  return new NextRequest(`http://127.0.0.1/api/sessions/${sessionId}/attachments`, { method: "POST", body: form });
}

const textBytes = (text: string) => new TextEncoder().encode(text);
const pdfBytes = () => textBytes("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
/** OLE2 复合文档头（旧版 .xls/.doc 的容器签名）。 */
const oleBytes = () => new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lectern-upload-"));
  const projectPath = join(root, "workspace");
  mkdirSync(projectPath, { recursive: true });
  PROJECT.path = projectPath;
  state.projects = [PROJECT];
  state.data = join(root, "data");

  // 真实会话库：只建 resolveSessionOwner 需要的 sessions 表
  const dir = join(state.data, PROJECT.id);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "zmzai.db"));
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
  const insert = db.prepare("INSERT INTO sessions (id) VALUES (?)");
  insert.run(SESSION);
  insert.run(OTHER_SESSION);
  db.close();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("POST /api/sessions/[id]/attachments", () => {
  it("上传 PDF：MIME 由内容嗅探决定，返回 processing 交给后台解析", async () => {
    const response = await uploadAttachment(fileRequest(SESSION, pdfBytes(), "contract.pdf", "application/pdf"), params(SESSION));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; attachment: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.attachment.filename).toBe("contract.pdf");
    expect(body.attachment.mediaType).toBe("application/pdf");
    // 阶段 C：PDF 解析要几秒到几十秒，路由**不等它**——状态由后台收敛
    // （收敛行为与三种失败分类见 extract-queue.test.ts）
    expect(body.attachment.status).toBe("processing");
    expect(body.attachment.kind).toBe("document");
    expect(body.attachment.attachmentId).toMatch(/^att_/);
    expect(body.attachment.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("响应体里不含文件原文（规格 §18.5：不再把 base64 塞进 JSON）", async () => {
    const payload = textBytes("SECRET-BODY-MARKER ".repeat(2000));
    const response = await uploadAttachment(fileRequest(SESSION, payload, "note.txt", "text/plain"), params(SESSION));
    const raw = await response.text();
    expect(raw).not.toContain("SECRET-BODY-MARKER");
    expect(raw).not.toContain("base64");
    // 回执应当远小于原始文件
    expect(raw.length).toBeLessThan(payload.byteLength / 10);
    expect((JSON.parse(raw) as { attachment: { size: number } }).attachment.size).toBe(payload.byteLength);
  });

  it("文件名去掉路径与控制字符（规格 §13）", async () => {
    const response = await uploadAttachment(fileRequest(SESSION, textBytes("x"), "../../../etc/passwd.md", "text/plain"), params(SESSION));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { attachment: { filename: string } };
    expect(body.attachment.filename).toBe("passwd.md");
  });

  it("拒绝不支持格式", async () => {
    const response = await uploadAttachment(fileRequest(SESSION, textBytes("MZ"), "setup.exe", "application/octet-stream"), params(SESSION));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("unsupported_format");
  });

  it("扩展名与真实内容不符时拒绝（伪造 MIME / 改名的二进制，规格 §17.2.10）", async () => {
    // ZIP 字节（PK\x03\x04）声称是 PDF
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    const first = await uploadAttachment(fileRequest(SESSION, zip, "fake.pdf", "application/pdf"), params(SESSION));
    expect(first.status).toBe(422);
    expect(((await first.json()) as { code: string }).code).toBe("unsupported_format");

    // 把可执行文件改名成 .md（内容不是文本）
    const exe = new Uint8Array([0x4d, 0x5a, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00]);
    const second = await uploadAttachment(fileRequest(SESSION, exe, "innocent.md", "text/markdown"), params(SESSION));
    expect(second.status).toBe(422);
  });

  it("超过单格式上限被拒（文本 2MB 上限，规格 §6）", async () => {
    const big = new Uint8Array(3 * 1024 * 1024).fill(0x41);
    const response = await uploadAttachment(fileRequest(SESSION, big, "big.txt", "text/plain"), params(SESSION));
    expect(response.status).toBe(413);
    expect(((await response.json()) as { code: string }).code).toBe("too_large");
  });

  it("超过数量上限被拒", async () => {
    for (let index = 0; index < 10; index += 1) {
      const ok = await uploadAttachment(fileRequest(SESSION, textBytes(`body-${index}`), `file-${index}.txt`, "text/plain"), params(SESSION));
      expect(ok.status, `#${index}`).toBe(200);
    }
    const overflow = await uploadAttachment(fileRequest(SESSION, textBytes("one-more"), "file-11.txt", "text/plain"), params(SESSION));
    expect(overflow.status).toBe(409);
    expect(((await overflow.json()) as { code: string }).code).toBe("too_many");
  });

  it("同名同大小视为重复", async () => {
    await uploadAttachment(fileRequest(SESSION, textBytes("same"), "dup.txt", "text/plain"), params(SESSION));
    const again = await uploadAttachment(fileRequest(SESSION, textBytes("same"), "dup.txt", "text/plain"), params(SESSION));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("duplicate");
  });

  it("旧版 .xls 被接受但带出不可提取的 warning（规格 §10.3，明确不假装读到内容）", async () => {
    const response = await uploadAttachment(fileRequest(SESSION, oleBytes(), "legacy.xls", "application/vnd.ms-excel"), params(SESSION));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { attachment: { status: string; extraction?: { warnings?: string[] } } };
    expect(body.attachment.status).toBe("ready");
    expect(body.attachment.extraction?.warnings?.[0]).toContain(".xlsx");
  });

  it("不存在的会话返回 404（归属校验）", async () => {
    const response = await uploadAttachment(fileRequest("ses_missing", textBytes("x"), "a.txt", "text/plain"), params("ses_missing"));
    expect(response.status).toBe(404);
  });

  it("非法的会话 id 形式被拒", async () => {
    const response = await uploadAttachment(fileRequest("has space", textBytes("x"), "a.txt", "text/plain"), params("has space"));
    expect(response.status).toBe(422);
  });

  it("缺少 file 字段时返回 400", async () => {
    const form = new FormData();
    form.append("other", "value");
    const request = new NextRequest(`http://127.0.0.1/api/sessions/${SESSION}/attachments`, { method: "POST", body: form });
    const response = await uploadAttachment(request, params(SESSION));
    expect(response.status).toBe(400);
  });
});

describe("GET /api/sessions/[id]/attachments", () => {
  it("只列出所属会话的附件", async () => {
    await uploadAttachment(fileRequest(SESSION, textBytes("mine"), "mine.txt", "text/plain"), params(SESSION));
    await uploadAttachment(fileRequest(OTHER_SESSION, textBytes("theirs"), "theirs.txt", "text/plain"), params(OTHER_SESSION));

    const mine = (await (await listAttachments(new NextRequest("http://127.0.0.1/x"), params(SESSION))).json()) as {
      attachments: { filename: string }[];
      scope: string;
    };
    expect(mine.attachments.map((a) => a.filename)).toEqual(["mine.txt"]);
    expect(mine.scope).toBe("session");
  });
});

describe("GET /api/sessions/[id]/attachments/[attachmentId]", () => {
  it("返回元数据与可用性", async () => {
    const created = (await (
      await uploadAttachment(fileRequest(SESSION, pdfBytes(), "doc.pdf", "application/pdf"), params(SESSION))
    ).json()) as { attachment: { attachmentId: string } };

    const response = await getAttachment(new NextRequest("http://127.0.0.1/x"), params(SESSION, created.attachment.attachmentId));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { attachment: { filename: string }; availability: boolean };
    expect(body.attachment.filename).toBe("doc.pdf");
    expect(body.availability).toBe(true);
  });

  it("raw 下载带安全头：nosniff、CSP sandbox、私有缓存（规格 §13）", async () => {
    const created = (await (
      await uploadAttachment(fileRequest(SESSION, textBytes("<script>alert(1)</script>"), "page.html", "text/html"), params(SESSION))
    ).json()) as { attachment: { attachmentId: string } };

    const response = await getAttachment(new NextRequest("http://127.0.0.1/x?raw=1"), params(SESSION, created.attachment.attachmentId));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("cache-control")).toContain("private");
    // HTML 不能就地渲染（否则会在应用 origin 上执行）
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(await response.text()).toContain("<script>");
  });

  it("图片与 PDF 允许 inline 预览", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const created = (await (
      await uploadAttachment(fileRequest(SESSION, png, "shot.png", "image/png"), params(SESSION))
    ).json()) as { attachment: { attachmentId: string } };
    const response = await getAttachment(new NextRequest("http://127.0.0.1/x?raw=1"), params(SESSION, created.attachment.attachmentId));
    expect(response.headers.get("content-disposition")).toContain("inline");
  });

  it("跨会话读取被拒（越权访问附件，规格 §17.2.2）", async () => {
    const created = (await (
      await uploadAttachment(fileRequest(SESSION, textBytes("private"), "private.txt", "text/plain"), params(SESSION))
    ).json()) as { attachment: { attachmentId: string } };

    const response = await getAttachment(new NextRequest("http://127.0.0.1/x"), params(OTHER_SESSION, created.attachment.attachmentId));
    expect(response.status).toBe(404);
  });

  it("不存在的 attachmentId 返回 404", async () => {
    const response = await getAttachment(new NextRequest("http://127.0.0.1/x"), params(SESSION, "att_nope"));
    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/sessions/[id]/attachments/[attachmentId]", () => {
  it("未绑定的附件可以删除，删除后无法再读取", async () => {
    const created = (await (
      await uploadAttachment(fileRequest(SESSION, textBytes("bye"), "bye.txt", "text/plain"), params(SESSION))
    ).json()) as { attachment: { attachmentId: string } };

    const removed = await deleteAttachment(new NextRequest("http://127.0.0.1/x"), params(SESSION, created.attachment.attachmentId));
    expect(removed.status).toBe(200);
    expect((await getAttachment(new NextRequest("http://127.0.0.1/x"), params(SESSION, created.attachment.attachmentId))).status).toBe(404);
  });

  it("跨会话删除被拒", async () => {
    const created = (await (
      await uploadAttachment(fileRequest(SESSION, textBytes("keep"), "keep.txt", "text/plain"), params(SESSION))
    ).json()) as { attachment: { attachmentId: string } };
    const response = await deleteAttachment(new NextRequest("http://127.0.0.1/x"), params(OTHER_SESSION, created.attachment.attachmentId));
    expect(response.status).toBe(404);
  });
});
