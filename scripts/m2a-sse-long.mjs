#!/usr/bin/env node
// M2a-S12：SSE 长连接观察（standalone 模式，~60s 带负载，无缺口断言）
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const root = process.cwd();
const dataDir = mkdtempSync(path.join(tmpdir(), "m2a-sse-data-"));
const workspace = mkdtempSync(path.join(tmpdir(), "m2a-sse-ws-"));
const host = spawn("node", [path.join(root, "host/dist/index.js")], { env: { ...process.env, LECTERN_HOST_DATA: dataDir, LECTERN_HOST_WORKSPACE: workspace }, stdio: "ignore", detached: true });
const next = spawn("pnpm", ["exec", "next", "start", "-p", "3177"], { cwd: root, env: { ...process.env, LECTERN_HOST_BOOTSTRAP: path.join(dataDir, "host.json") }, stdio: "ignore", detached: true });
const DURATION_MS = Number(process.env.M2A_SSE_SECONDS ?? "60") * 1_000;
let result = "未执行";
try {
  while (!readdirSync(dataDir).includes("host.json")) await new Promise((r) => setTimeout(r, 50));
  while (true) { try { if ((await fetch("http://127.0.0.1:3177/api/m2a/health")).status === 200) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  const boot = JSON.parse(readFileSync(path.join(dataDir, "host.json"), "utf8"));
  const H = { authorization: `Bearer ${boot.token}`, "content-type": "application/json" };
  const sessionId = (await (await fetch("http://127.0.0.1:3177/api/m2a/session", { method: "POST" })).json()).sessionId;
  // 事件号连续性靠 Host seq，这里按 SSE 帧计数 + 心跳存活判定
  const controller = new AbortController();
  const frames = [];
  let heartbeats = 0;
  const t = setTimeout(() => controller.abort(), DURATION_MS);
  const sse = (async () => {
    const res = await fetch(`http://127.0.0.1:3177/api/m2a/events?sessionId=${sessionId}&since=0`, { signal: controller.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const f of buf.split("\n\n")) {
        if (f.startsWith(":")) heartbeats += 1;
        else if (f.includes("id: ")) frames.push(Number(f.split("\n").find((l) => l.startsWith("id: ")).slice(4)));
      }
      buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
    }
  })().catch(() => {});
  // 持续负载：每 3s 一个 prompt
  const start = Date.now();
  let prompts = 0;
  while (Date.now() - start < DURATION_MS - 2_000) {
    await fetch("http://127.0.0.1:3177/api/m2a/prompt", { method: "POST", headers: H, body: JSON.stringify({ sessionId, requestId: `sse-${prompts}`, text: `长连接 ${prompts}` }) });
    prompts += 1;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  await sse;
  clearTimeout(t);
  const contiguous = frames.every((s, i) => i === 0 || s === frames[i - 1] + 1);
  const ok = frames.length > 0 && contiguous && prompts > 0;
  result = `${ok ? "PASS" : "FAIL"}：${(DURATION_MS / 1000).toFixed(0)}s 连接，${frames.length} 帧${contiguous ? "连续无缺口" : "存在缺口"}，心跳 ${heartbeats} 次，负载 ${prompts} prompts`;
  console.log(`[m2a-sse] ${result}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  for (const p of [next, host]) try { process.kill(-p.pid, "SIGKILL"); } catch {}
  rmSync(dataDir, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true });
}
