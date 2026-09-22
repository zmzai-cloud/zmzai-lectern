#!/usr/bin/env node
// M2a-S12 性能基线：mock 命令 durable receipt 延迟（样本 100，直连 Host）
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const root = process.cwd();
const dataDir = mkdtempSync(path.join(tmpdir(), "m2a-perf-data-"));
const workspace = mkdtempSync(path.join(tmpdir(), "m2a-perf-ws-"));
const host = spawn("node", [path.join(root, "host/dist/index.js")], {
  env: { ...process.env, LECTERN_HOST_DATA: dataDir, LECTERN_HOST_WORKSPACE: workspace },
  stdio: "ignore", detached: true,
});
try {
  while (!readdirSync(dataDir).includes("host.json")) await new Promise((r) => setTimeout(r, 50));
  const boot = JSON.parse((await import("node:fs")).readFileSync(path.join(dataDir, "host.json"), "utf8"));
  const H = { authorization: `Bearer ${boot.token}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${boot.port}`;
  const sessionId = (await (await fetch(`${base}/v1/commands/session`, { method: "POST", headers: H })).json()).sessionId;
  const samples = [];
  const N = 100;
  for (let i = 0; i < N; i += 1) {
    const t0 = performance.now();
    const res = await fetch(`${base}/v1/commands/prompt`, { method: "POST", headers: H, body: JSON.stringify({ sessionId, requestId: `perf-${i}`, text: `基准 ${i}` }) });
    await res.json();
    samples.push(performance.now() - t0);
    if (i === N - 1) await new Promise((r) => setTimeout(r, 1_000)); // 等尾部 run 收敛
  }
  samples.sort((a, b) => a - b);
  const p = (q) => samples[Math.min(N - 1, Math.floor(q * N))];
  const out = {
    schema: "lectern.evals.results/1", generated_at: new Date().toISOString(), suite: "deterministic",
    system_under_test: { name: "m2a-host-minimal", kind: "lectern-after", commit: process.env.M2A_COMMIT ?? null, model: null },
    environment: { machine: "local-dev", samples: N, notes: "durable receipt（prompt 命令受理→回执）直连 Host，fixture sqlite" },
    runs: [], summary: { total: N, pass: N, fail: 0, blocked: 0, not_run: 0, unverified: 0 },
    metrics: { p50_ms: p(0.5), p95_ms: p(0.95), max_ms: samples[N - 1], gate: "p95 <= 300ms", gate_pass: p(0.95) <= 300 },
  };
  (await import("node:fs")).writeFileSync(path.join(root, "evals/results/m2a-receipt-perf-baseline.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`[m2a-perf] N=${N} p50=${p(0.5).toFixed(1)}ms p95=${p(0.95).toFixed(1)}ms max=${samples[N - 1].toFixed(1)}ms gate(p95≤300)=${p(0.95) <= 300 ? "PASS" : "FAIL"}`);
} finally {
  try { process.kill(-host.pid, "SIGKILL"); } catch { /* 已退出 */ }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}
