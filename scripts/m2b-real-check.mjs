#!/usr/bin/env node
// M2b-B1 进程级验证：Host 真实 runtimeFor 装配 + GET /v1/sessions 只读端点。
// （vitest 对 host/src→lib 链的 node:sqlite 有跨目录解析怪癖，真实链路验证走本脚本）
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFrameworkSession, createSqliteSessionStore } from "@zmzai/agent-framework";

const root = process.cwd();
const dataDir = mkdtempSync(path.join(tmpdir(), "m2b-real-data-"));
const workspace = mkdtempSync(path.join(tmpdir(), "m2b-real-ws-"));
const host = spawn("node", [path.join(root, "host/dist/host/src/index.js")], {
  env: { ...process.env, LECTERN_HOST_DATA: dataDir, LECTERN_HOST_WORKSPACE: workspace },
  stdio: "ignore", detached: true,
});
try {
  while (!readdirSync(dataDir).includes("host.json")) await new Promise((r) => setTimeout(r, 50));
  const boot = JSON.parse(readFileSync(path.join(dataDir, "host.json"), "utf8"));
  const H = { authorization: `Bearer ${boot.token}` };
  const base = `http://127.0.0.1:${boot.port}`;

  // 真实 store 落在 dataDir（默认项目沿用 dataDir 本身）——直接种一个会话
  const store = createSqliteSessionStore({ dataDir });
  const session = await createFrameworkSession({ store, userId: "b1-user", workspaceId: "b1-ws", model: { providerId: "faux", modelId: "m" }, prompt: "B1 真实装配" });

  // 种一条消息 + part（供 messages/search/read-state/usage 断言）
  const mid = "msg_b1_seed";
  try {
    await store.appendMessage({ id: mid, sessionId: session.id, role: "user", agent: "default", model: { providerId: "faux", modelId: "m" }, tokens: { input: 12, output: 0, cacheRead: 0, cacheWrite: 0 }, time: { created: new Date().toISOString() } });
    await store.appendPart({ id: `part_${mid}`, sessionId: session.id, messageId: mid, type: "text", text: "B1 端点验证种子文本" });
  } catch (e) { console.log("[seed] 写入失败:", String(e).slice(0, 120)); }
  const dbg = await store.getMessages(session.id);
  console.log("[seed] 直读 entries:", dbg.length, JSON.stringify(dbg[0]?.info ?? null).slice(0, 160));

  const health = await (await fetch(`${base}/health`, { headers: H })).json();
  const messages = await (await fetch(`${base}/v1/sessions/${session.id}/messages`, { headers: H })).json();
  const search = await (await fetch(`${base}/v1/sessions/${session.id}/search?q=${encodeURIComponent("种子")}&limit=10`, { headers: H })).json();
  const readState = await fetch(`${base}/v1/sessions/${session.id}/read-state`, { headers: H });
  const usage = await (await fetch(`${base}/v1/sessions/${session.id}/usage`, { headers: H })).json();
  const gone = await fetch(`${base}/v1/sessions/ses_none/messages`, { headers: H });
  const listed = await (await fetch(`${base}/v1/sessions?userId=b1-user`, { headers: H })).json();
  const other = await (await fetch(`${base}/v1/sessions?userId=elsewhere`, { headers: H })).json();
  const noToken = await fetch(`${base}/v1/sessions?userId=b1-user`);

  const msgHit = Array.isArray(messages) && messages.some((entry) => entry.info?.id === mid && entry.parts?.some((part) => part.text?.includes("种子文本")));
  const searchHit = Array.isArray(search?.results) ? search.results.length > 0 : search?.hits?.length > 0;
  const readOk = readState.status === 200 || readState.status === 404; // 实现可选
  const usageHit = usage?.tokens?.input === 12;
  const ok = health.ok !== false
    && listed.sessions.some((sn) => sn.id === session.id)
    && other.sessions.every((sn) => sn.id !== session.id)
    && noToken.status === 401
    && msgHit
    && (searchHit === undefined || searchHit !== false)
    && readOk
    && usageHit
    && gone.status === 404;
  console.log(`[m2b-real] ${ok ? "PASS" : "FAIL"}：列表/隔离/401=${listed.sessions.some((sn) => sn.id === session.id)}/${other.sessions.every((sn) => sn.id !== session.id)}/${noToken.status}；messages=${msgHit}；search=${String(searchHit)}；read-state=${readState.status}；usage(input=12)=${usageHit}；不存在会话=${gone.status}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  try { process.kill(-host.pid, "SIGKILL"); } catch { /* 已退出 */ }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}
