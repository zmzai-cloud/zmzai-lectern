#!/usr/bin/env node
// M2b-B1 网关验证：生产路径 /api/sessions 经网关代理到 Host（flag on）。
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFrameworkSession, createSqliteSessionStore } from "@zmzai/agent-framework";

const root = process.cwd();
const PORT = 3178;
const dataDir = mkdtempSync(path.join(tmpdir(), "m2b-gw-data-"));
const workspace = mkdtempSync(path.join(tmpdir(), "m2b-gw-ws-"));
const host = spawn("node", [path.join(root, "host/dist/host/src/index.js")], {
  env: { ...process.env, LECTERN_HOST_DATA: dataDir, LECTERN_HOST_WORKSPACE: workspace }, stdio: "ignore", detached: true,
});
const next = spawn("pnpm", ["exec", "next", "dev", "-p", String(PORT)], {
  cwd: root, env: { ...process.env, LECTERN_HOST_GATEWAY: path.join(dataDir, "host.json"), LECTERN_HOST_BOOTSTRAP: path.join(dataDir, "host.json") }, stdio: "ignore", detached: true,
});
try {
  while (!readdirSync(dataDir).includes("host.json")) await new Promise((r) => setTimeout(r, 50));
  for (;;) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/m2a/health`)).status === 200) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  const store = createSqliteSessionStore({ dataDir });
  const session = await createFrameworkSession({ store, userId: "gw-user", workspaceId: "gw-ws", model: { providerId: "faux", modelId: "m" }, prompt: "网关验证" });
  // 经生产路径（网关代理）
  const viaGateway = (await (await fetch(`http://127.0.0.1:${PORT}/api/sessions?userId=gw-user`)).json());
  const other = (await (await fetch(`http://127.0.0.1:${PORT}/api/sessions?userId=else`)).json());
  const listed = Array.isArray(viaGateway?.sessions) && viaGateway.sessions.some((sn) => sn.id === session.id);
  const isolated = Array.isArray(other?.sessions) && other.sessions.every((sn) => sn.id !== session.id);
  // B2：生产路径 prompt（cookie → credential 通道）+ abort 经网关
  const prompted = await fetch(`http://127.0.0.1:${PORT}/api/sessions/${session.id}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "muzhi_session=gw-cred-check; other=x" },
    body: JSON.stringify({ requestId: "gw-b2", text: "网关命令" }),
  });
  const receipt = await prompted.json();
  const viaCommand = prompted.status === 200 && receipt.requestId === "gw-b2";
  const aborted = await fetch(`http://127.0.0.1:${PORT}/api/sessions/${session.id}/abort`, { method: "POST" });
  const abortOk = aborted.status === 200;
  const tasked = await fetch(`http://127.0.0.1:${PORT}/api/sessions/${session.id}/task`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "resume" }) });
  const taskOk = tasked.status === 200;
  const compacted = await fetch(`http://127.0.0.1:${PORT}/api/sessions/${session.id}/compact`, { method: "POST" });
  const compactOk = compacted.status === 200;
  const ok = listed && isolated && viaCommand && abortOk && taskOk && compactOk;
  console.log(`[m2b-gateway] ${ok ? "PASS" : "FAIL"}：列表=${listed}；隔离=${isolated}；prompt(cookie→credential)=${viaCommand}；abort=${abortOk}；task(resume)=${taskOk}；compact=${compactOk}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  for (const p of [next, host]) try { process.kill(-p.pid, "SIGKILL"); } catch { /* 已退出 */ }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}
