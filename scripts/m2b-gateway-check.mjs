#!/usr/bin/env node
// M2b-B1 网关验证：生产路径 /api/sessions 经网关代理到 Host（flag on）。
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFrameworkSession, createSqliteSessionStore } from "@zmzai/agent-framework";

const root = process.cwd();
const PORT = 3178;
const base0 = () => `http://127.0.0.1:${JSON.parse(readFileSync(path.join(dataDir, "host.json"), "utf8")).port}`;
const H0 = () => ({ authorization: `Bearer ${JSON.parse(readFileSync(path.join(dataDir, "host.json"), "utf8")).token}` });
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
  // B4：附件上传（Host 命令）→ 生产路径下载字节一致 + 安全头
  const payload = Buffer.from("B4 attachment streaming check — 附件字节流验证");
  const uploaded = await (await fetch(`http://127.0.0.1:${PORT}/api/m2a/health`).then(() => fetch(`${base0()}/v1/commands/attachment`, { method: "POST", headers: { ...H0(), "content-type": "application/json" }, body: JSON.stringify({ sessionId: session.id, filename: "b4-check.txt", mediaType: "text/plain", bytesBase64: payload.toString("base64") }) }))).json();
  const attId = uploaded?.id ?? uploaded?.attachment?.id;
  const downloaded = await fetch(`http://127.0.0.1:${PORT}/api/sessions/${session.id}/attachments/${attId}?raw=1`);
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  const attOk = downloaded.status === 200 && bytes.equals(payload) && downloaded.headers.get("x-content-type-options") === "nosniff";
  if (!attOk) console.log("[att-debug] uploaded=", JSON.stringify(uploaded).slice(0, 120), "dlStatus=", downloaded.status, "len=", bytes.length);
  const ok = listed && isolated && viaCommand && abortOk && taskOk && compactOk && attOk;
  console.log(`[m2b-gateway] ${ok ? "PASS" : "FAIL"}：列表=${listed}；隔离=${isolated}；prompt(cookie→credential)=${viaCommand}；abort=${abortOk}；task(resume)=${taskOk}；compact=${compactOk}；附件流=${attOk}(${bytes.length}B)`);
  process.exitCode = ok ? 0 : 1;
} finally {
  for (const p of [next, host]) try { process.kill(-p.pid, "SIGKILL"); } catch { /* 已退出 */ }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}
