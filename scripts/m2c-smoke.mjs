#!/usr/bin/env node
// M2c-S13 冒烟：Host 生命周期——双开互斥、graceful 退出无孤儿、lock 清理。
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const dataDir = mkdtempSync(path.join(tmpdir(), "m2c-s13-"));
const host = () => spawn("node", [path.join(root, "host/dist/host/src/index.js")], {
  env: { ...process.env, LECTERN_HOST_DATA: dataDir, LECTERN_HOST_WORKSPACE: path.join(dataDir, "ws") },
  stdio: "ignore", detached: true,
});
const results = [];
const ok = (id, cond, detail = "") => { results.push([id, !!cond]); console.log(`[m2c:${id}] ${cond ? "PASS" : "FAIL"} ${detail}`); };

try {
  const h1 = host();
  await new Promise((r) => setTimeout(r, 1200));
  const boot = JSON.parse(readFileSync(path.join(dataDir, "host.json"), "utf8"));
  ok("health", (await (await fetch(`http://127.0.0.1:${boot.port}/health`, { headers: { authorization: `Bearer ${boot.token}` } }))).status === 200);

  const h2 = host();
  const h2code = await new Promise((r) => h2.on("exit", (c) => r(c)));
  ok("mutex", h2code === 1 && readdirSync(dataDir).includes("host.lock"), `第二实例 exit=${h2code}`);

  let res = null;
  let errDetail = "";
  try {
    res = await fetch(`http://127.0.0.1:${boot.port}/v1/shutdown`, { method: "POST", headers: { authorization: `Bearer ${boot.token}` } });
    await res.text();
  } catch (e) {
    errDetail = String(e);
  }
  ok("graceful-http", res?.status === 200, `status=${res?.status} ${errDetail.slice(0, 80)}`);
  await new Promise((r) => setTimeout(r, 1500));
  let exited = false;
  try { process.kill(h1.pid, 0); } catch { exited = true; }
  ok("exit", exited, `Host pid=${h1.pid}`);
  await new Promise((r) => setTimeout(r, 200));
  ok("lock-cleaned", !readdirSync(dataDir).includes("host.lock"));

  const failed = results.filter(([, p]) => !p);
  console.log(`[m2c] ${results.length - failed.length}/${results.length} 通过${failed.length ? " 失败:" + failed.map(([i]) => i).join(",") : ""}`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
