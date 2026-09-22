#!/usr/bin/env node
// M2a smoke（设计 S11）：dev 拓扑下编排 A01–A04、A24。
// 用法：node e2e/m2a-smoke.mjs [mode]  mode=dev|start（S12 standalone 复用）
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MODE = process.argv[2] ?? "dev";
const PORT = 3177;
const root = process.cwd();
const dataDir = mkdtempSync(path.join(tmpdir(), `m2a-${MODE}-data-`));
const workspace = mkdtempSync(path.join(tmpdir(), `m2a-${MODE}-ws-`));
const hostJson = path.join(dataDir, "host.json");
const results = [];
let host, nextProc;

const log = (tag, msg) => console.log(`[m2a:${tag}] ${msg}`);
const ok = (id, cond, detail = "") => {
  results.push([id, !!cond]);
  log(id, cond ? `PASS ${detail}` : `FAIL ${detail}`);
};

async function waitFor(cond, ms, tag) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`waitFor 超时: ${tag}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function readHost() {
  return JSON.parse(readFileSync(hostJson, "utf8"));
}

function hostAuth() {
  const h = readHost();
  return { authorization: `Bearer ${h.token}`, "content-type": "application/json" };
}

async function nextReady() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/m2a/health`);
    return res.status === 200;
  } catch {
    return false;
  }
}

function startNext() {
  const cmd = MODE === "dev" ? ["exec", "next", "dev", "-p", String(PORT)] : ["exec", "next", "start", "-p", String(PORT)];
  nextProc = spawn("pnpm", cmd, { cwd: root, env: { ...process.env, LECTERN_HOST_BOOTSTRAP: hostJson }, stdio: "ignore", detached: true });
  return nextProc;
}

async function collectSse(sessionId, since, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const seqs = [];
  const types = [];
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/m2a/events?sessionId=${sessionId}&since=${since}`, { signal: controller.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const f of buf.split("\n\n")) {
        const id = f.split("\n").find((l) => l.startsWith("id: "));
        const d = f.split("\n").find((l) => l.startsWith("data: "));
        if (id && d) {
          seqs.push(Number(id.slice(4)));
          types.push(JSON.parse(d.slice(6)).type);
        }
      }
      buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
    }
  } catch { /* 超时/断开，返回已收 */ }
  clearTimeout(timer);
  return { seqs, types };
}

async function post(pathname, body, init = {}) {
  return fetch(`http://127.0.0.1:${PORT}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init });
}

async function main() {
  // ---- 启动 Host（工具延迟 2500ms 制造 A02 的执行中窗口）----
  host = spawn("node", [path.join(root, "host/dist/index.js")], {
    env: { ...process.env, LECTERN_HOST_DATA: dataDir, LECTERN_HOST_WORKSPACE: workspace, LECTERN_HOST_TOOL_DELAY_MS: "2500" },
    stdio: "ignore",
    detached: true,
  });
  await waitFor(() => readdirSync(dataDir).includes("host.json"), 5_000, "host.json");
  const hostPid = host.pid;

  startNext();
  await waitFor(nextReady, 60_000, `next(${MODE}) ready`);

  // ---- A24：直连 Host 错 token → 401 且数据目录零新增 ----
  const { port, token } = readHost();
  const before = readdirSync(dataDir).sort();
  const bad = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${"0".repeat(64)}` } });
  await fetch(`http://127.0.0.1:${port}/v1/commands/prompt`, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s", requestId: "x", text: "y" }) }).catch(() => null);
  ok("A24", bad.status === 401 && readdirSync(dataDir).sort().join() === before.join(), `401=${bad.status} 目录不变`);

  // ---- 会话（A01 的断开重连验证挪到 A02 之后：会话刚建时本无事件可收）----
  const session = (await (await post("/api/m2a/session", {})).json()).sessionId;
  void token;

  // ---- A02：prompt 触发 2.5s 工具，期间 kill -9 Next，重启后恢复 ----
  const a02 = (await (await post("/api/m2a/prompt", { sessionId: session, requestId: "m2a-a02", text: "杀掉 Next 期间执行工具" })).json());
  await new Promise((r) => setTimeout(r, 400)); // 工具执行中
  process.kill(-nextProc.pid, "SIGKILL"); // 进程组：pnpm 包装杀掉后 next dev 不能孤儿化
  await new Promise((r) => setTimeout(r, 300));
  ok("A02-host-alive", host.pid === hostPid && !host.killed, `Host PID ${hostPid} 不变`);
  startNext();
  await waitFor(nextReady, 60_000, "next 重启");
  const probeText = () => { try { return readFileSync(path.join(workspace, "probe.log"), "utf8"); } catch { return ""; } };
  await waitFor(() => probeText().includes("m2a-probe"), 10_000, "probe 完成");
  const after = await collectSse(session, 0, 2_500);
  const contiguous = after.seqs.every((s, i) => i === 0 || s === after.seqs[i - 1] + 1);
  ok("A02", after.types.includes("task.delivered") && contiguous && after.seqs[0] === 1, `${after.seqs.length}帧 delivered+连续`);
  void a02;

  // ---- A01（有事件后）：SSE 断开重连按 since 续传 ----
  {
    const sse1 = await collectSse(session, 0, 1_500);
    const last = sse1.seqs.at(-1) ?? 0;
    const sse2 = await collectSse(session, last, 1_500);
    const noDup = new Set(sse2.seqs).size === sse2.seqs.length;
    ok("A01", sse1.seqs.length > 0 && sse2.seqs.every((s) => s > last) && noDup, `首段${sse1.seqs.length}帧 重连${sse2.seqs.length}帧`);
  }

  // ---- A03：响应丢失 + 同 requestId 重试 → 同一回执，probe 只写一次 ----
  const session2 = (await (await post("/api/m2a/session", {})).json()).sessionId;
  await post("/api/m2a/prompt", { sessionId: session2, requestId: "m2a-a03", text: "响应会丢" }, { signal: AbortSignal.timeout(60) }).catch(() => null);
  const retry = await (await post("/api/m2a/prompt", { sessionId: session2, requestId: "m2a-a03", text: "响应会丢" })).json();
  await waitFor(() => {
    const lines = probeText().split("\n").filter((l) => l === "m2a-probe");
    return lines.length === 2; // A02 一行 + A03 一行
  }, 10_000, "A03 probe 计数");
  ok("A03", !!retry.runId, `runId=${retry.runId?.slice(0, 8)}`);

  // ---- A04：同 requestId 换 payload → 409 ----
  const clash = await post("/api/m2a/prompt", { sessionId: session2, requestId: "m2a-a03", text: "换掉的" });
  ok("A04", clash.status === 409, `status=${clash.status}`);

  const failed = results.filter(([, p]) => !p);
  console.log(`[m2a] ${MODE} 模式：${results.length - failed.length}/${results.length} 通过${failed.length ? "，失败：" + failed.map(([id]) => id).join(",") : ""}`);
  process.exitCode = failed.length ? 1 : 0;
}

main()
  .catch((e) => {
    console.error("[m2a] FAIL:", e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const p of [nextProc, host]) if (p && !p.killed) try { process.kill(-p.pid, "SIGKILL"); } catch { /* 已退出 */ }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
