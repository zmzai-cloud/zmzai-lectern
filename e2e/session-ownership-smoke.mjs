/** Production-server smoke. All files/processes belong to this temporary fixture. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createSqliteSessionStore } from "@zmzai/agent-framework";

const fixture = mkdtempSync(join(tmpdir(), "lectern-ownership-smoke-"));
const roots = [join(fixture, "project A"), join(fixture, "project B")];
for (const root of roots) {
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Ownership Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "ownership@localhost"]);
  writeFileSync(join(root, "note.txt"), root === roots[0] ? "A original" : "B original");
  execFileSync("git", ["-C", root, "add", "note.txt"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
}
const socket = createServer();
await new Promise(r => socket.listen(0, "127.0.0.1", r));
const port = socket.address().port;
await new Promise(r => socket.close(r));
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  LECTERN_DATA_DIR: join(fixture, "data"),
  LECTERN_WORKSPACE: roots[0],
  RELAY_URL: "http://127.0.0.1:9",
  OPENAI_BASE_URL: "http://127.0.0.1:9",
  MUZHI_URL: "http://127.0.0.1:9",
};
let server;
const checks = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function api(path, method = "GET", body, status = 200) {
  const response = await fetch(origin + path, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
async function start() {
  server = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
    env, stdio: ["ignore", "ignore", "ignore"],
  });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${server.exitCode}`);
    try { await api("/api/projects"); return; } catch { await delay(100); }
  }
  throw new Error("Production server did not become ready");
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Test server did not stop")); }, 10_000);
    child.once("exit", () => { clearTimeout(timeout); done(); });
    child.kill("SIGTERM");
  });
  server = undefined;
}
const sessionBody = { agent: "default", model: { providerId: "openai", modelId: "smoke-no-network" } };
try {
  await start();
  const a = await api("/api/sessions", "POST", sessionBody);
  const isolated = await api("/api/sessions", "POST", { ...sessionBody, isolate: true });
  assert.equal(isolated.isolation.enabled, true);
  const bProject = await api("/api/projects", "POST", { path: roots[1] });
  const b = await api("/api/sessions", "POST", sessionBody);
  assert.equal(b.projectId, bProject.project.id);
  assert.equal(a.projectId, "default");
  checks.push("session creation captures and returns its project");

  const fixtureStore = createSqliteSessionStore({ dataDir: env.LECTERN_DATA_DIR });
  for (let n = 1; n <= 3; n++) {
    const message = { id: `search-${n}`, sessionId: a.id, role: n === 1 ? "user" : "assistant", parentId: n === 1 ? undefined : "search-1", agent: "default", model: sessionBody.model, time: { created: new Date().toISOString() } };
    await fixtureStore.persistEvent({ sessionId: a.id, type: "message.updated", data: { message } });
    await fixtureStore.persistEvent({ sessionId: a.id, type: "message.part.updated", data: { part: { id: `part-${n}`, messageId: message.id, sessionId: a.id, type: "text", text: `search needle ${n}` } } });
  }
  await fixtureStore.persistEvent({ sessionId: a.id, type: "todo.updated", data: { todos: [{ content: "search acceptance", status: "completed" }] } });
  const search = await api(`/api/sessions/${a.id}/search?q=needle&limit=1`);
  assert.equal(search.results[0].projectId, a.projectId);
  assert.equal(search.results[0].messageId, "search-1");
  assert.ok(search.nextCursor);
  const searchNext = await api(`/api/sessions/${a.id}/search?q=needle&limit=1&cursor=${search.nextCursor}`);
  assert.equal(searchNext.results[0].messageId, "search-2");
  assert.deepEqual((await api(`/api/sessions/${b.id}/search?q=needle`)).results, []);
  const context = await api(`/api/sessions/${a.id}/messages?view=window&around=search-2&limit=2`);
  assert.ok(context.messages.some(message => message.info.id === "search-2"));
  assert.ok(context.stateEvents.some(event => event.type === "todo.updated"));
  assert.ok(context.stateEvents.every(event => event.seq <= context.snapshotSeq));
  checks.push("real indexed search, cursor pagination and same-watermark context stay in A while B is active");
  assert.equal((await api(`/api/sessions/${a.id}/read-state`)).unreadCount, 2);
  assert.equal((await api(`/api/sessions/${a.id}/read-state`, "PUT", { lastReadMessageSeq: 2, historyRevision: 1 })).unreadCount, 1);
  assert.equal((await api(`/api/sessions/${a.id}/read-state`, "PUT", { lastReadMessageSeq: 1, historyRevision: 1 })).lastReadMessageSeq, 2);
  await api(`/api/sessions/${a.id}/read-state`, "PUT", { lastReadMessageSeq: 99, historyRevision: 1 }, 422);
  assert.equal((await api(`/api/sessions/${b.id}/read-state`)).lastReadMessageSeq, 0);
  checks.push("read cursors are monotonic, bounded by server sequence and isolated across projects");

  assert.equal((await api(`/api/fs/file?sessionId=${a.id}&path=note.txt`)).content, "A original");
  await api("/api/fs/file", "PUT", { sessionId: a.id, path: "note.txt", content: "A changed" });
  assert.equal(readFileSync(join(roots[0], "note.txt"), "utf8"), "A changed");
  assert.equal(readFileSync(join(roots[1], "note.txt"), "utf8"), "B original");
  await api(`/api/sessions/${a.id}/messages?tail=50`);
  await api(`/api/sessions/${a.id}/abort`, "POST");
  checks.push("background message/file/abort APIs stay in the owning project");

  const delivery = await api("/api/deliveries/attempt", "POST", { sessionId: a.id, action: "begin" });
  assert.equal(delivery.attempt.projectId, "default");
  assert.equal(delivery.attempt.effectiveWorkspaceRoot, roots[0]);
  checks.push("delivery ownership ignores the currently active project");

  const terminal = await api("/api/terminal", "POST", { sessionId: a.id, command: "git rev-parse --show-toplevel" });
  let output = "";
  let cursor = 0;
  let ended = false;
  for (let i = 0; i < 100; i++) {
    const chunk = await api(`/api/terminal/${terminal.id}/read?cursor=${cursor}`);
    output += chunk.output ?? "";
    cursor = chunk.cursor ?? cursor;
    if (chunk.session?.status !== "running") { assert.equal(chunk.session?.exitCode, 0); ended = true; break; }
    await delay(50);
  }
  assert.ok(ended);
  assert.ok(output.includes("project A"), "Terminal escaped the task's project");
  checks.push("real terminal/Git runs in A while B is active");

  for (const path of ["/api/sessions/unknown/messages", "/api/git/checkpoint?sessionId=unknown", "/api/deliveries?sessionId=unknown"]) {
    assert.equal((await api(path, "GET", undefined, 404)).detail.code, "NOT_FOUND");
  }
  await api("/api/fs/file", "PUT", { sessionId: "unknown", path: "bad.txt", content: "bad" }, 404);
  assert.equal((await api("/api/sessions/unknown", "PATCH", { title: "missing" }, 404)).detail.code, "NOT_FOUND");
  assert.equal((await api("/api/sessions/unknown", "DELETE", undefined, 404)).detail.code, "NOT_FOUND");
  checks.push("unknown sessions fail closed across read/write/delivery APIs");

  await stop();
  await start();
  assert.equal((await api(`/api/fs/file?sessionId=${a.id}&path=note.txt`)).content, "A changed");
  assert.equal((await api(`/api/sessions/${isolated.id}/worktree`)).enabled, true);
  checks.push("ownership and worktree mapping survive a production-server restart");
  assert.equal((await api(`/api/sessions/${a.id}/search?q=needle`)).results.length, 3);
  checks.push("indexed search survives a production-server restart");
  assert.equal((await api(`/api/sessions/${a.id}/read-state`)).lastReadMessageSeq, 2);
  await fixtureStore.rewind(a.id, "search-2");
  await api(`/api/sessions/${a.id}/read-state`, "PUT", { lastReadMessageSeq: 2, historyRevision: 1 }, 409);
  assert.deepEqual(await api(`/api/sessions/${a.id}/read-state`), { lastReadMessageSeq: 1, unreadCount: 0, latestMessageSeq: 1, historyRevision: 2 });
  checks.push("read state survives restart and rewind invalidates old cursors without negative unread counts");

  // Remove only this fixture's isolated worktree directory, leaving its mapping.
  rmSync(isolated.isolation.path, { recursive: true, force: true });
  assert.equal((await api(`/api/fs/file?sessionId=${isolated.id}&path=note.txt`, "GET", undefined, 409)).detail.code, "RECOVERY_REQUIRED");
  checks.push("a lost worktree never falls back to the main workspace");
  console.log(JSON.stringify({ passed: true, checks, fixture }, null, 2));
} finally {
  await stop();
  console.log(`Isolated fixture retained: ${fixture}`);
}
