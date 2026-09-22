#!/usr/bin/env node
// M2c-S15：回滚路径实测（顺序单实例——双 next dev 并发在 dev 模式下
// 就绪探测互卡，进程级实测过两次才改的形态）。
// LEGACY：不设 LECTERN_HOST_GATEWAY → 网关休眠，旧 handler 服务（形状≠Host）。
// ARMED 对照：设 GATEWAY → 同路径 Host 形状。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const PORT = 3179;
const dataDir = mkdtempSync(path.join(tmpdir(), "m2c-s15-"));
const workspace = mkdtempSync(path.join(tmpdir(), "m2c-s15-ws-"));
const results = [];
const ok = (id, cond, detail = "") => { results.push([id, !!cond]); console.log(`[m2c-s15:${id}] ${cond ? "PASS" : "FAIL"} ${detail}`); };

function startNext(env) {
  return spawn("pnpm", ["exec", "next", "dev", "-p", String(PORT)], { cwd: root, env: { ...process.env, ...env }, stdio: "ignore", detached: true });
}
async function waitReady(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // 根路径任一非 5xx 即认为 dev server 起来（LEGACY 无 BOOTSTRAP 时 m2a/health 是 500）
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
      if (r.status < 500) return true;
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
const killTree = (p) => { try { process.kill(-p.pid, "SIGKILL"); } catch { /* 已退出 */ } };

try {
  const host = spawn("node", [path.join(root, "host/dist/host/src/index.js")], {
    env: { ...process.env, LECTERN_HOST_DATA: dataDir, LECTERN_HOST_WORKSPACE: workspace }, stdio: "ignore", detached: true,
  });
  try {
    // ---- LEGACY（无 GATEWAY）----
    let next = startNext({});
    if (!(await waitReady(PORT, 120_000))) throw new Error("LEGACY next dev 120s 未就绪");
    const legacyBody = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions`)).json();
    ok("legacy-off", !Array.isArray(legacyBody?.sessions), `形状=${Array.isArray(legacyBody) ? "数组(旧)" : Array.isArray(legacyBody?.sessions) ? "Host(错!)" : "投影(旧)"}`);
    const legacyTerm = await (await fetch(`http://127.0.0.1:${PORT}/api/terminal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "echo legacy-check" }) })).json();
    ok("legacy-terminal", !!legacyTerm?.name, `旧 handler name 字段=${!!legacyTerm?.name}`);
    killTree(next);
    await new Promise((r) => setTimeout(r, 2000));

    // ---- ARMED 对照 ----
    next = startNext({ LECTERN_HOST_GATEWAY: path.join(dataDir, "host.json"), LECTERN_HOST_BOOTSTRAP: path.join(dataDir, "host.json") });
    if (!(await waitReady(PORT, 120_000))) throw new Error("ARMED next dev 120s 未就绪");
    const armedBody = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions`)).json();
    // Host 形状判定：带 userId → {sessions:[...]}；不带 → Host 的 400 INVALID_INPUT。
    // 旧 handler 无参数也返回数组——两者必居其一即证明 armed 生效
    const armedWithUser = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions?userId=s15-probe`)).json();
    const isHost = Array.isArray(armedWithUser?.sessions) || armedBody?.error === "INVALID_INPUT";
    ok("armed-on", isHost, `形状=${Array.isArray(armedWithUser?.sessions) ? "Host(sessions)" : armedBody?.error === "INVALID_INPUT" ? "Host(400 校验)" : "非Host(错!)"}`);
    killTree(next);
  } finally {
    killTree(host);
  }

  const failed = results.filter(([, p]) => !p);
  console.log(`[m2c-s15] ${results.length - failed.length}/${results.length} 通过${failed.length ? " 失败:" + failed.map(([i]) => i).join(",") : ""}`);
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error("[m2c-s15] FAIL:", e.message);
  process.exitCode = 1;
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}
