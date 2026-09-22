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

  const health = await (await fetch(`${base}/health`, { headers: H })).json();
  const listed = await (await fetch(`${base}/v1/sessions?userId=b1-user`, { headers: H })).json();
  const other = await (await fetch(`${base}/v1/sessions?userId=elsewhere`, { headers: H })).json();
  const noToken = await fetch(`${base}/v1/sessions?userId=b1-user`);

  const ok = health.ok !== false
    && listed.sessions.some((sn) => sn.id === session.id)
    && other.sessions.every((sn) => sn.id !== session.id)
    && noToken.status === 401;
  console.log(`[m2b-real] ${ok ? "PASS" : "FAIL"}：health=${JSON.stringify(health.capabilities)}；列出新会话=${listed.sessions.some((sn) => sn.id === session.id)}；跨用户隔离=${other.sessions.every((sn) => sn.id !== session.id)}；无token=${noToken.status}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  try { process.kill(-host.pid, "SIGKILL"); } catch { /* 已退出 */ }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}
