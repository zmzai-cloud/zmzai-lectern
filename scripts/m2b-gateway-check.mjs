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
  const ok = listed && isolated;
  console.log(`[m2b-gateway] ${ok ? "PASS" : "FAIL"}：生产路径 /api/sessions 经网关=${listed}；跨用户隔离=${isolated}；body 形状=${Array.isArray(viaGateway?.sessions) ? "Host" : JSON.stringify(viaGateway).slice(0, 80)}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  for (const p of [next, host]) try { process.kill(-p.pid, "SIGKILL"); } catch { /* 已退出 */ }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}
