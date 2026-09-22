import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

/**
 * 附件经 prompt 链路的归属校验、幂等与绑定（规格 2 §9.1 / §17.2.2 / §17.2.3 / §19）。
 *
 * 【为什么必须单独测这一条路径】上传接口的归属校验（`getScoped`）早就有测试，但
 * 「模型真能读到这份文件」走的是**另一条路**：客户端在 prompt 请求体里给一串 id，
 * 服务端把它们解析成描述符、交给 runner、再绑定到用户消息。这条路上任何一步放松，
 * 后果都不是「上传失败」而是「A 会话的消息读到了 B 会话的文件」——一个静默的越权。
 *
 * 只替换项目/worktree 解析、runtime、relay 与标题生成；**会话归属、附件库、绑定
 * 都走真实实现**，否则测的就不是这条链路本身了。
 */

/** 按需模拟「workflow 里已经存过这个 requestId」；不改就是没存过。 */
type FindPrompt = (sessionId: string, requestId: string) => { input: unknown } | null;

const state = vi.hoisted(() => ({
  data: "",
  projects: [] as Array<{ id: string; path: string }>,
  prompts: [] as Array<Record<string, unknown>>,
  sessions: new Map<string, { id: string; title?: string }>(),
  findPrompt: null as null | FindPrompt,
}));

vi.mock("@/lib/projects", () => ({
  registeredProjects: () => state.projects,
  dataDirFor: (project: { id: string }) => join(state.data, project.id),
  getActiveProject: () => state.projects[0],
}));
vi.mock("@/lib/worktree", () => ({ worktreeForSession: () => undefined }));
vi.mock("@/lib/relay", () => ({
  sessionCookieName: "muzhi_session",
  resolveModel: async () => ({ providerId: "openai", modelId: "gpt-test" }),
}));
vi.mock("@/lib/session-title", () => ({ generateSessionTitle: async () => null }));
vi.mock("@/lib/runtime", () => ({
  workspaceRootForSession: () => state.projects[0]!.path,
  sessionRuntime: () => ({
    store: {
      workflow: { findPrompt: (sessionId: string, requestId: string) => Promise.resolve(state.findPrompt?.(sessionId, requestId) ?? null) },
      getSession: (id: string) => Promise.resolve(state.sessions.get(id) ?? null),
      updateSession: (id: string, patch: { title?: string }) => {
        const session = state.sessions.get(id);
        if (session) state.sessions.set(id, { ...session, ...patch });
        return Promise.resolve(state.sessions.get(id) ?? null);
      },
    },
    runner: {
      prompt: (_id: string, input: Record<string, unknown>) => {
        state.prompts.push(input);
        return Promise.resolve({ userMessageId: `msg_${state.prompts.length}` });
      },
    },
  }),
}));

import { NextRequest } from "next/server";
import { POST as sendPromptRoute } from "../../app/api/sessions/[id]/prompt/route.js";
import { attachmentStoreFor, type SqliteAttachmentStore } from "./store.js";

const SESSION = "ses_prompt_target";
const OTHER_SESSION = "ses_prompt_other";
const PROJECT = { id: "proj_one", path: "" };
let root: string;
let store: SqliteAttachmentStore;

const params = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

function promptRequest(sessionId: string, body: Record<string, unknown>) {
  return new NextRequest(`http://127.0.0.1/api/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 就绪的文本附件（走真实 store；解析正文不是这条路径要测的东西）。 */
function readyAttachment(sessionId: string, name: string, text = "正文") {
  const record = store.put({
    sessionId,
    filename: name,
    mediaType: "text/plain",
    kind: "text",
    status: "ready",
    bytes: new TextEncoder().encode(text),
  });
  return record;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lectern-prompt-"));
  const projectPath = join(root, "workspace");
  mkdirSync(projectPath, { recursive: true });
  PROJECT.path = projectPath;
  state.projects = [PROJECT];
  state.data = join(root, "data");
  state.prompts = [];
  state.findPrompt = null;

  // 真实会话库：resolveSessionOwner 需要 sessions 表
  const dir = join(state.data, PROJECT.id);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "zmzai.db"));
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)");
  db.prepare("INSERT INTO sessions (id, title) VALUES (?, ?)").run(SESSION, "新会话");
  db.prepare("INSERT INTO sessions (id, title) VALUES (?, ?)").run(OTHER_SESSION, "新会话");
  db.close();

  state.sessions = new Map([
    [SESSION, { id: SESSION, title: "新会话" }],
    [OTHER_SESSION, { id: OTHER_SESSION, title: "新会话" }],
  ]);
  store = attachmentStoreFor(dir);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("附件 id 的归属校验（规格 §19：不接受任意 id）", () => {
  it("别的会话的附件 id 被拒，且**根本不会进 runner**", async () => {
    const foreign = readyAttachment(OTHER_SESSION, "别人的合同.txt", "机密");
    const response = await sendPromptRoute(promptRequest(SESSION, { text: "读一下", attachmentIds: [foreign.id] }), params(SESSION));
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("not_found");
    // 关键：不是「拒了但东西已经进去了」。越权的 id 必须在这里就断掉
    expect(state.prompts).toHaveLength(0);
  });

  it("不存在的 id 与不属于本会话的 id 给同一个答复（不泄露「这个 id 存在但不是你的」）", async () => {
    const foreign = readyAttachment(OTHER_SESSION, "别人的合同.txt");
    const foreignResponse = await sendPromptRoute(promptRequest(SESSION, { text: "x", attachmentIds: [foreign.id] }), params(SESSION));
    const ghostResponse = await sendPromptRoute(promptRequest(SESSION, { text: "x", attachmentIds: ["att_00000000-0000-0000-0000-000000000000"] }), params(SESSION));
    expect(foreignResponse.status).toBe(ghostResponse.status);
    expect(await foreignResponse.json()).toEqual(await ghostResponse.json());
  });

  it("还没就绪的附件被拒（否则消息里会挂一个读不出内容的附件）", async () => {
    const pending = store.put({
      sessionId: SESSION,
      filename: "大文档.pdf",
      mediaType: "application/pdf",
      kind: "document",
      status: "processing",
      bytes: new TextEncoder().encode("%PDF-1.7\n"),
    });
    const response = await sendPromptRoute(promptRequest(SESSION, { text: "读一下", attachmentIds: [pending.id] }), params(SESSION));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("not_ready");
    expect(state.prompts).toHaveLength(0);
  });

  it("同一个 id 传两次只算一个（去重，避免消息里出现两张一样的卡）", async () => {
    const record = readyAttachment(SESSION, "notes.txt");
    await sendPromptRoute(promptRequest(SESSION, { text: "看看", attachmentIds: [record.id, record.id] }), params(SESSION));
    const refs = state.prompts[0]!.attachmentRefs as Array<{ id: string }>;
    expect(refs).toHaveLength(1);
  });
});

describe("发给 runner 的描述符", () => {
  it("只带 id 与元数据，不带文件内容（规格 §18.5：不在 prompt JSON 里塞 base64）", async () => {
    const marker = "SECRET-BODY-MARKER";
    const record = readyAttachment(SESSION, "notes.txt", marker.repeat(500));
    await sendPromptRoute(promptRequest(SESSION, { text: "看看", attachmentIds: [record.id] }), params(SESSION));
    const serialized = JSON.stringify(state.prompts[0]);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain("base64");
    const refs = state.prompts[0]!.attachmentRefs as Array<Record<string, unknown>>;
    expect(refs[0]).toMatchObject({ id: record.id, name: "notes.txt", mediaType: "text/plain", sha256: record.sha256 });
  });
});

describe("幂等与绑定（规格 §9.2 / §17.2.3）", () => {
  it("同一 requestId 重发：用**当初记录的那份输入**回放，且不再重复绑定", async () => {
    const record = readyAttachment(SESSION, "notes.txt");
    const body = { text: "看看", attachmentIds: [record.id], requestId: "req_aaaaaaaa" };
    const first = await sendPromptRoute(promptRequest(SESSION, body), params(SESSION));
    expect(first.status).toBe(200);
    expect(store.get(record.id)?.messageId).toBe("msg_1");

    /**
     * 这里是本用例真正的价值所在：workflow 里存下来的是 **runner 的输入**，
     * 附件字段叫 `attachmentRefs`（已解析的描述符），而请求体里叫 `attachmentIds`。
     * 指纹函数只认后者的话，重发时读出来的附件串永远是空数组，一比对就不相等，
     * 于是**带附件的消息只要重发就返回 409**——那条消息其实早就发出去了。
     * 所以这里必须喂真实形状，不能图省事喂 `{ attachmentIds }`。
     */
    const recorded = {
      text: "看看",
      attachmentRefs: [{ id: record.id, name: "notes.txt", mediaType: "text/plain", size: record.size, sha256: record.sha256, kind: "text" }],
      images: [],
    };
    state.findPrompt = () => ({ input: recorded });

    let bindCount = 0;
    const originalBind = store.bind.bind(store);
    store.bind = ((...args: Parameters<SqliteAttachmentStore["bind"]>) => {
      bindCount += 1;
      return originalBind(...args);
    }) as SqliteAttachmentStore["bind"];

    const replay = await sendPromptRoute(promptRequest(SESSION, body), params(SESSION));
    // 重发必须是「回放成功」，不是「冲突」——这才是幂等
    expect(replay.status).toBe(200);
    // 回放送进 runner 的是**同一个输入对象**，不是按当前请求体重新推导一份新的。
    // 真正的「不重复执行」由 runner 按 requestId 去重，这条断言管的是它前面那一段：
    // 服务端不能在重发时给出与首次不同的输入（那会让去重表认不出来）。
    expect(state.prompts[1]).toBe(recorded);
    // 附件已经绑在首次的用户消息上，重发不再动它
    expect(bindCount).toBe(0);
    expect(store.get(record.id)?.messageId).toBe("msg_1");
  });

  it("同一 requestId 换了附件 → 409，不静默复用旧消息", async () => {
    const first = readyAttachment(SESSION, "a.txt");
    const second = readyAttachment(SESSION, "b.txt");
    await sendPromptRoute(promptRequest(SESSION, { text: "看看", attachmentIds: [first.id], requestId: "req_bbbbbbbb" }), params(SESSION));
    // 记录里还是 a.txt；这次客户端带了 b.txt —— 换了内容的 requestId 必须冲突，
    // 否则用户会以为发出去了，实际发的是上一份文件
    state.findPrompt = () => ({ input: { text: "看看", attachmentRefs: [{ id: first.id }], images: [] } });
    const conflict = await sendPromptRoute(promptRequest(SESSION, { text: "看看", attachmentIds: [second.id], requestId: "req_bbbbbbbb" }), params(SESSION));
    expect(conflict.status).toBe(409);
    expect(state.prompts).toHaveLength(1);
  });

  it("发送成功后附件绑定到用户消息并清掉草稿 TTL（规格 §9.2）", async () => {
    const record = readyAttachment(SESSION, "notes.txt");
    expect(record.expiresAt).toBeTruthy();
    await sendPromptRoute(promptRequest(SESSION, { text: "看看", attachmentIds: [record.id] }), params(SESSION));
    const bound = store.get(record.id)!;
    expect(bound.messageId).toBe("msg_1");
    expect(bound.expiresAt).toBeUndefined();
  });
});

describe("只有附件的消息（规格 §18.4 / §7.5）", () => {
  it("text 为空、只有附件时可以发送，标题种子用文件名且正文不插入伪文字", async () => {
    const record = readyAttachment(SESSION, "季度复盘.md");
    const response = await sendPromptRoute(promptRequest(SESSION, { text: "", attachmentIds: [record.id] }), params(SESSION));
    expect(response.status).toBe(200);
    expect(state.prompts[0]!.text).toBe("");
    expect(state.sessions.get(SESSION)?.title).toBe("季度复盘.md");
  });

  it("文字、附件、图片全空才算空消息", async () => {
    const response = await sendPromptRoute(promptRequest(SESSION, { text: "   " }), params(SESSION));
    expect(response.status).toBe(400);
    expect(state.prompts).toHaveLength(0);
  });
});
