import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

/**
 * rewind 复用附件（规格 2 §11 / §17.2.4 / §18.6 / §18.12）。
 *
 * 【为什么这条也要测】rewind 是唯一一条**把已发送的附件重新送进一次新 run** 的路径。
 * 它做错事的方式很安静：不重新上传是对的（附件已在存储里），但如果绑定没跟着走到新
 * 消息上，附件会一直指向一条已经不存在的消息——既不会被清理，也不会跟历史卡片对上；
 * 而如果 id 解析失败却继续发，用户得到的是一条少了文件的空消息。
 *
 * 会话归属、附件库、绑定都走真实实现；只替换 runtime/store/relay 这些外部依赖。
 */

type Entry = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

const state = vi.hoisted(() => ({
  data: "",
  projects: [] as Array<{ id: string; path: string }>,
  prompts: [] as Array<Record<string, unknown>>,
  messages: [] as Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>,
  rewound: [] as string[],
  bound: [] as Array<{ id: string; messageId: string }>,
  active: false,
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
vi.mock("@/lib/runtime", () => ({
  sessionRuntime: () => ({
    store: {
      getSession: (id: string) => Promise.resolve({ id, queuedPrompts: [] }),
      getMessages: () => Promise.resolve(state.messages),
      workflow: { workflowRuns: () => Promise.resolve([]) },
      // 真实 sqlite store 两个都有；路由先用 `truncateFrom` 是否存在判断后端能力
      truncateFrom: (id: string, messageId: string) => { state.rewound.push(messageId); return Promise.resolve({ sessionId: id }); },
      rewind: (id: string, messageId: string) => { state.rewound.push(messageId); return Promise.resolve({ sessionId: id }); },
    },
    runner: {
      prompt: (_id: string, input: Record<string, unknown>) => {
        state.prompts.push(input);
        return Promise.resolve({ userMessageId: `msg_new_${state.prompts.length}` });
      },
    },
  }),
}));
vi.mock("@zmzai/agent-framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zmzai/agent-framework")>()),
  isSessionActive: () => state.active,
  notifyEventLogListeners: () => undefined,
}));

import { NextRequest } from "next/server";
import { POST as rewindRoute } from "../../app/api/sessions/[id]/rewind/route.js";
import { attachmentStoreFor, type SqliteAttachmentStore } from "./store.js";

const SESSION = "ses_rewind";
const PROJECT = { id: "proj_one", path: "" };
let root: string;
let store: SqliteAttachmentStore;

const params = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const request = (body: Record<string, unknown>) =>
  new NextRequest(`http://127.0.0.1/api/sessions/${SESSION}/rewind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** 失败时把响应体一起打出来——这条路由把异常都收成 500 + 一句话，只看状态码没法查。 */
async function rewind(body: Record<string, unknown>) {
  const response = await rewindRoute(request(body), params(SESSION));
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

function readyAttachment(name: string) {
  return store.put({
    sessionId: SESSION,
    filename: name,
    mediaType: "text/plain",
    kind: "text",
    status: "ready",
    bytes: new TextEncoder().encode("正文"),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lectern-rewind-"));
  const projectPath = join(root, "workspace");
  mkdirSync(projectPath, { recursive: true });
  PROJECT.path = projectPath;
  state.projects = [PROJECT];
  state.data = join(root, "data");
  state.prompts = [];
  state.rewound = [];
  state.bound = [];
  state.active = false;
  state.messages = [];

  const dir = join(state.data, PROJECT.id);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "zmzai.db"));
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO sessions (id) VALUES (?)").run(SESSION);
  db.close();

  store = attachmentStoreFor(dir);
  const originalBind = store.bind.bind(store);
  store.bind = ((...args: Parameters<SqliteAttachmentStore["bind"]>) => {
    state.bound.push({ id: args[0], messageId: args[1] });
    return originalBind(...args);
  }) as SqliteAttachmentStore["bind"];
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** 一条带附件的用户消息，形如消息链路真正落库的样子。 */
function userMessageWith(parts: Array<Record<string, unknown>>): Entry {
  return { info: { id: "msg_old", role: "user", agent: "default" }, parts };
}

describe("回溯重发复用已发送的附件", () => {
  it("复用 attachment id、不重新上传，并把绑定挪到新的用户消息上", async () => {
    const record = readyAttachment("notes.txt");
    store.bind(record.id, "msg_old", SESSION);
    // 只看路由自己做的绑定（上面那次是「这条消息当初发送时」的绑定）
    state.bound = [];
    state.messages = [userMessageWith([{ id: "p1", type: "file", attachmentId: record.id, filename: "notes.txt", mime: "text/plain", size: record.size }])];

    const response = await rewind({ messageId: "msg_old" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(state.rewound).toEqual(["msg_old"]);
    // 附件描述符原样送进新的一轮，没有被重新上传（上传接口根本没被碰到）
    const refs = state.prompts[0]!.attachmentRefs as Array<{ id: string }>;
    expect(refs.map((ref) => ref.id)).toEqual([record.id]);
    // 旧消息已随截断删除，绑定必须跟着走——否则附件永远指着一条不存在的消息
    expect(state.bound).toEqual([{ id: record.id, messageId: "msg_new_1" }]);
    expect(store.get(record.id)?.messageId).toBe("msg_new_1");
  });

  it("附件已被清理时明确拒绝，而不是发出一条少了文件的空消息", async () => {
    const ghost = "att_00000000-0000-0000-0000-000000000000";
    state.messages = [userMessageWith([{ id: "p1", type: "file", attachmentId: ghost, filename: "x.txt", mime: "text/plain", size: 1 }])];

    const response = await rewind({ messageId: "msg_old" });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body?.code).toBe("not_found");
    expect(state.rewound).toEqual([]);
    expect(state.prompts).toHaveLength(0);
  });

  it("附件未就绪时也拒绝——放过去等于静默丢掉这个文件", async () => {
    const pending = store.put({
      sessionId: SESSION,
      filename: "大文档.pdf",
      mediaType: "application/pdf",
      kind: "document",
      status: "processing",
      bytes: new TextEncoder().encode("%PDF-1.7\n"),
    });
    state.messages = [userMessageWith([{ id: "p1", type: "file", attachmentId: pending.id, filename: "大文档.pdf", mime: "application/pdf", size: pending.size }])];

    const response = await rewind({ messageId: "msg_old" });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body?.code).toBe("not_ready");
    expect(state.prompts).toHaveLength(0);
  });

  it("旧链路历史（data URL part）仍能重发，升级后不回退（规格 §18.12）", async () => {
    const dataUrl = `data:text/plain;base64,${Buffer.from("旧正文").toString("base64")}`;
    state.messages = [userMessageWith([{ id: "p1", type: "file", url: dataUrl, filename: "旧记录.txt", mime: "text/plain", size: 6 }])];

    const response = await rewind({ messageId: "msg_old" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const attachments = state.prompts[0]!.attachments as Array<{ name: string; data: string }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.name).toBe("旧记录.txt");
    expect(attachments[0]!.data).toBe(dataUrl);
  });

  it("会话运行中 / 有排队消息时不截断（附件再正确也不能在运行中砍历史）", async () => {
    state.active = true;
    const record = readyAttachment("notes.txt");
    state.messages = [userMessageWith([{ id: "p1", type: "file", attachmentId: record.id, filename: "notes.txt", mime: "text/plain", size: record.size }])];

    const response = await rewind({ messageId: "msg_old" });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(state.rewound).toEqual([]);
  });
});
