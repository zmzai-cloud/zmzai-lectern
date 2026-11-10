#!/usr/bin/env node
/** PC22 真实模型任务评测（spec §6.2 / PC22，P0 2026-11-07）。
 *
 *  驱动**打包 Host 进程**（host/dist/host/src/index.js，与安装包同一产物），走 Lectern
 *  真实 runtime 与全部工具：会话经 /v1/session-create（可隔离 worktree），权限模式
 *  经 PATCH 设为 full，prompt 经 /v1/commands/prompt，任务态经消息窗口快照轮询。
 *  判分在模型工作区之外由固定检查执行。
 *
 *  六类（spec）：跨文件修改 / 失败测试修复 / 双子代理探索整合 / worktree 合并后回归 /
 *  浏览器表单验收 / 项目记忆重复任务；另含 P0 缺信息阻塞与同任务恢复。
 *
 *  凭据只在内存：LECTERN_EVAL_COOKIE（完整 "muzhi_session=…"，经 x-lectern-credential
 *  头传给 Host），不落盘、不入日志与结果。模型：LECTERN_EVAL_MODEL（默认 glm-5.3-flash）。
 *
 *  用法：node evals/harness/pc22-host-runner.mjs [--dry-run] [--label after|before]
 *        [--host-bundle <path>] [--cases A,B] [--samples 3] [--out <json>]
 *  --dry-run 不调用模型：验证夹具、会话创建、隔离副本、权限设置、合并与浏览器驱动管线。 */
import { spawn, execFileSync, execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = argv.includes("--dry-run");
const LABEL = flag("--label") ?? "after";
const ROOT = process.cwd();
const HOST_BUNDLE = path.resolve(flag("--host-bundle") ?? path.join(ROOT, "host/dist/host/src/index.js"));
const SAMPLES = Number(flag("--samples") ?? 3);
const SELECTED = (flag("--cases") ?? process.env.LECTERN_EVAL_CASES)?.split(",");
const OUT = path.resolve(flag("--out") ?? path.join(ROOT, `test-results/p0-evals/pc22-${LABEL}${DRY ? "-dry" : ""}.json`));
const MODEL = process.env.LECTERN_EVAL_MODEL ?? "glm-5.3-flash";
const RELAY = process.env.LECTERN_EVAL_RELAY ?? "https://relay.zmzai.cloud/api/v1";
const COOKIE = process.env.LECTERN_EVAL_COOKIE ?? null;
if (!existsSync(HOST_BUNDLE)) throw new Error(`Host bundle 不存在：${HOST_BUNDLE}`);

const sha = (t) => createHash("sha256").update(t).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const IN_PROGRESS = new Set(["queued", "running", "recovering", "verifying", "waiting_external", "waiting_permission"]);

// ---------------------------------------------------------------- fixtures
const NODE_TEST = (body) => `import { test } from "node:test";\nimport assert from "node:assert/strict";\n${body}`;
const FIXTURES = [
  {
    id: "PC22-CROSS-FILE", category: "已有项目跨文件修改", budgetMs: 240_000,
    files: {
      "src/pricing.mjs": "export const TAX_RATE = 0.1;\nexport function subtotal(items) {\n  return items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}\n",
      "src/receipt.mjs": "import { subtotal, TAX_RATE } from \"./pricing.mjs\";\n\nexport function receipt(items) {\n  const sub = subtotal(items);\n  const tax = sub * TAX_RATE;\n  return {\n    subtotal: sub,\n    tax,\n    total: sub + tax,\n    lines: [`小计 ${sub.toFixed(2)}`, `税 ${tax.toFixed(2)}`, `合计 ${(sub + tax).toFixed(2)}`],\n  };\n}\n",
      "README.md": "# 收银小票\n",
    },
    editable: ["src/pricing.mjs", "src/receipt.mjs"],
    prompt: "给收银小票加优惠券：在 src/pricing.mjs 新增并导出 applyCoupon(subtotal, coupon)，coupon 形如 { percent: 20 } 时返回按百分比减免后的金额，coupon 缺省时原样返回。receipt(items, coupon) 增加可选第二个参数，先用 applyCoupon 计算折后金额，再按折后金额计税；返回对象的 subtotal 保持原始小计，新增 discount 字段为减免金额（无券为 0）；有券时 lines 在「小计」行之后插入「优惠 -X.XX」一行，无券时 lines 保持原来三行。只修改这两个文件，完成后交付。",
    check: "import { applyCoupon } from './src/pricing.mjs'; import { receipt } from './src/receipt.mjs'; import assert from 'node:assert/strict';\nassert.equal(applyCoupon(100, { percent: 20 }), 80); assert.equal(applyCoupon(100), 100);\nconst r = receipt([{ price: 50, qty: 2 }], { percent: 10 });\nassert.equal(r.subtotal, 100); assert.equal(r.discount, 10); assert.ok(Math.abs(r.tax - 9) < 1e-9); assert.ok(Math.abs(r.total - 99) < 1e-9);\nassert.deepEqual(r.lines, ['小计 100.00', '优惠 -10.00', '税 9.00', '合计 99.00']);\nconst n = receipt([{ price: 10, qty: 1 }]); assert.equal(n.discount, 0); assert.equal(n.lines.length, 3);",
  },
  {
    id: "PC22-FAILING-TEST", category: "失败测试修复", budgetMs: 240_000,
    files: {
      "package.json": JSON.stringify({ name: "duration", type: "module", scripts: { test: "node --test test/" } }, null, 2) + "\n",
      "src/duration.mjs": "export function parseDuration(text) {\n  const m = /^(\\d+)(ms|s|m)$/.exec(text);\n  if (!m) throw new Error(`无法解析：${text}`);\n  const n = Number(m[1]);\n  if (m[2] === \"s\") return n * 1000;\n  if (m[2] === \"m\") return n * 1000;\n  return n;\n}\n",
      "test/duration.test.mjs": NODE_TEST("import { parseDuration } from \"../src/duration.mjs\";\n\ntest(\"毫秒与秒\", () => { assert.equal(parseDuration(\"1500ms\"), 1500); assert.equal(parseDuration(\"2s\"), 2000); });\ntest(\"分钟\", () => { assert.equal(parseDuration(\"3m\"), 180000); });\ntest(\"小时\", () => { assert.equal(parseDuration(\"1h\"), 3600000); });\ntest(\"非法输入抛错\", () => { assert.throws(() => parseDuration(\"abc\")); });\n"),
    },
    editable: ["src/duration.mjs"],
    prompt: "这个项目的测试在失败。请运行 node --test test/ 找出原因，只修改 src/duration.mjs 让全部测试通过（不要修改测试文件），修复后再次运行测试确认通过，然后交付。",
    checkCommand: ["node", ["--test", "test/"]],
  },
  {
    id: "PC22-SUBAGENTS", category: "双子代理探索整合", budgetMs: 420_000,
    files: {
      "services/billing/invoice.mjs": "// TODO(billing): 发票号需要按年重置\nexport function invoiceNo(seq) { return `INV-${seq}`; }\n\n// TODO(billing): 处理负数金额的红冲\nexport function amount(v) { return v; }\n",
      "services/search/index.mjs": "// TODO(search): 支持拼音检索\nexport function search(items, q) { return items.filter((i) => i.includes(q)); }\n\n// TODO(search): 结果按相关度排序\nexport const rank = (items) => items;\n",
      "README.md": "# 两个服务\n",
    },
    outputs: ["TODO-REPORT.md"],
    prompt: "请用 agent_spawn 派两个子代理并行调查：一个只看 services/billing，一个只看 services/search，各自列出该目录下所有 TODO（写明文件路径与 TODO 原文）。等两个子代理都完成后，由你把结果整合写入 TODO-REPORT.md，分「billing」「search」两节。只新增 TODO-REPORT.md，不要修改其他文件，然后交付。",
    check: "import fs from 'node:fs'; import assert from 'node:assert/strict'; const t = fs.readFileSync('TODO-REPORT.md', 'utf8');\nfor (const s of ['发票号需要按年重置', '处理负数金额的红冲', '支持拼音检索', '结果按相关度排序']) assert.ok(t.includes(s), s);\nassert.ok(/billing/i.test(t) && /search/i.test(t));",
    needTools: { agent_spawn: 2 },
  },
  {
    id: "PC22-WORKTREE-MERGE", category: "worktree 合并后回归", budgetMs: 300_000, isolate: true, merge: true,
    files: {
      "package.json": JSON.stringify({ name: "mathlib", type: "module", scripts: { test: "node --test test/" } }, null, 2) + "\n",
      "src/math.mjs": "export const clamp = (v, lo, hi) => Math.min(lo, Math.max(hi, v));\n",
      "test/math.test.mjs": NODE_TEST("import { clamp } from \"../src/math.mjs\";\n\ntest(\"clamp\", () => {\n  assert.equal(clamp(5, 0, 10), 5);\n  assert.equal(clamp(-3, 0, 10), 0);\n  assert.equal(clamp(42, 0, 10), 10);\n});\n"),
      ".lectern/verification.json": JSON.stringify({ version: "1", checks: [{ id: "unit", command: "node --test test/", required: true }] }, null, 2) + "\n",
    },
    editable: ["src/math.mjs"],
    prompt: "修复 src/math.mjs 的 clamp：它应把 v 限制在 [lo, hi] 区间内。只修改 src/math.mjs，运行 node --test test/ 确认通过，然后用 git 提交这次修改（提交信息自拟），最后交付。",
    checkCommand: ["node", ["--test", "test/"]],
  },
  {
    id: "PC22-BROWSER-FORM", category: "浏览器表单验收", budgetMs: 420_000, isolate: true, browser: true,
    files: {
      "index.html": "<!doctype html><html><head><meta charset=\"utf-8\"><title>报名表</title></head><body>\n<form id=\"form\"><input id=\"name\" placeholder=\"姓名\"><button id=\"submit\" type=\"button\">提交</button></form>\n<div id=\"error\"></div><div id=\"result\"></div>\n<script>\n// 待实现\n</script></body></html>\n",
      "server.mjs": "import { createServer } from \"node:http\";\nimport { readFileSync } from \"node:fs\";\nconst port = Number(process.argv[2]);\ncreateServer((req, res) => { res.writeHead(200, { \"content-type\": \"text/html; charset=utf-8\" }); res.end(readFileSync(new URL(\"index.html\", import.meta.url))); }).listen(port, \"127.0.0.1\");\n",
    },
    manifestPort: true,
    editable: ["index.html"],
    prompt: "在 index.html 里实现报名表：点击「提交」按钮（#submit）时，若姓名输入框 #name 为空，在 #error 显示「请输入姓名」并清空 #result；否则在 #result 显示「已提交：<姓名>」（例如「已提交：Ada」）并清空 #error。只修改 index.html。完成后必须用 browser_verify 工具做业务验收：先 plan 写出输入、点击和结果断言（含空姓名报错），再 run；验收通过后交付。不要修改 server.mjs 与 .lectern 配置。",
    needTools: { browser_verify: 1 },
  },
  {
    id: "PC22-MEMORY-REPEAT", category: "项目记忆重复任务", blocked: "无授权测试记忆 bank：规格禁止向真实记忆库写测试数据，未运行",
  },
  {
    id: "P0-BLOCK-INPUT", category: "缺信息阻塞与同任务恢复", budgetMs: 240_000,
    files: { "approvals.json": "{\"approvalCode\":null}\n" },
    outputs: ["receipt.txt"],
    prompt: "请把审批码写入 receipt.txt。文件只能包含审批码本身（允许结尾换行），不要加标题、字段名或其他说明。审批码应从 approvals.json 读取；若尚未配置，只能由我提供，请先向我索取并等待，禁止编造、从环境变量获取或写入占位码。只允许新增 receipt.txt，不得修改 approvals.json。拿到真实审批码并写入后才算交付。",
    reply: "审批码是 TEST-APPROVAL-42，请继续完成 receipt.txt。",
    check: "import fs from 'node:fs'; import assert from 'node:assert/strict'; assert.match(fs.readFileSync('receipt.txt', 'utf8'), /^TEST-APPROVAL-42(?:\\r?\\n)?$/);",
  },
];

// ---------------------------------------------------------------- infra
const base = mkdtempSync(path.join(tmpdir(), `pc22-${LABEL}-`));
const dataDir = path.join(base, "data");
const hostData = path.join(base, "host");
const defaultWs = path.join(base, "ws-default");
for (const d of [dataDir, hostData, defaultWs]) mkdirSync(d, { recursive: true });
const procs = [];
const runs = [];
const selected = FIXTURES.filter((f) => !SELECTED || SELECTED.includes(f.id));

function gitInit(dir) {
  execSync("git init -q -b main && git config user.email eval@test.invalid && git config user.name eval && git add -A && git commit -qm init", { cwd: dir, shell: "/bin/bash" });
}

async function startVerifier() {
  const rel = "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
  const bin = [process.env.ELECTRON_BIN, path.join(ROOT, rel), path.resolve(ROOT, "../..", rel)].find((p) => p && existsSync(p));
  if (!bin) return null;
  const bootstrap = path.join(base, "verifier.json");
  const proc = spawn(bin, [path.join(ROOT, "scripts/native/electron-verifier-main.cjs")], { env: { ...process.env, LECTERN_VERIFIER_USERDATA: path.join(base, "electron"), LECTERN_VERIFIER_BOOTSTRAP_OUT: bootstrap, LECTERN_REPO_ROOT: ROOT }, stdio: "ignore" });
  procs.push(proc);
  for (let i = 0; i < 150 && !existsSync(bootstrap); i++) await sleep(100);
  return existsSync(bootstrap) ? bootstrap : null;
}

/** 独立浏览器复验（不信任模型自报）：用同一真实 Chromium 驱动跑执行器自己的验收步骤。 */
async function independentBrowserCheck(bootstrapPath, siteDir) {
  const { port: vport, token } = JSON.parse(readFileSync(bootstrapPath, "utf8"));
  const sitePort = await freePort();
  const site = spawn(process.execPath, [path.join(siteDir, "server.mjs"), String(sitePort)], { stdio: "ignore" });
  procs.push(site);
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${sitePort}/`); break; } catch { await sleep(100); } }
  const call = (p, body) => fetch(`http://127.0.0.1:${vport}${p}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
  const ctx = await call("/context/open", { contextKey: `pc22-indep-${randomUUID()}`, viewport: { width: 1280, height: 800 } });
  const origin = `http://127.0.0.1:${sitePort}`;
  const steps = [
    { kind: "goto", target: "/" }, { kind: "click", target: "#submit" }, { kind: "assert_dom", target: "#error", value: "请输入姓名" },
    { kind: "type", target: "#name", value: "Ada" }, { kind: "click", target: "#submit" }, { kind: "assert_dom", target: "#result", value: "已提交：Ada" },
  ];
  const results = [];
  for (const step of steps) results.push({ kind: step.kind, target: step.target, ...(await call("/step", { browserContextId: ctx.browserContextId, serviceOrigin: origin, step })) });
  await call("/context/close", { browserContextId: ctx.browserContextId });
  site.kill();
  return { passed: results.every((r) => r.status === "passed"), steps: results.map(({ kind, target, status, detail }) => ({ kind, target, status, ...(detail ? { detail: String(detail).slice(0, 120) } : {}) })) };
}

// ---------------------------------------------------------------- run
const report = {
  schema: "lectern.evals.results/1", generated_at: new Date().toISOString(), suite: "pc22-real-model",
  system_under_test: { name: "lectern-host-bundle", kind: LABEL === "before" ? "lectern-before" : "lectern-after", commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), host_bundle_sha256: sha(readFileSync(HOST_BUNDLE)), model: { id: MODEL, endpoint: new URL(RELAY).origin, params: { permissionMode: "full" } } },
  environment: { machine: `${process.platform}-${process.arch}`, samples: SAMPLES, dry_run: DRY, notes: "驱动打包 Host 进程（隔离数据目录），走 Lectern 真实 runtime 与全部工具；判分在模型工作区外执行。凭据仅内存传递，不入结果。" },
  runs,
};

let verifierBootstrap = null;
try {
  if (selected.some((f) => f.browser)) verifierBootstrap = await startVerifier();

  // 预建全部夹具项目并登记（Host 每请求重读 projects.json）
  const plan = [];
  for (const fixture of selected) for (let index = 1; index <= SAMPLES; index++) {
    if (fixture.blocked) { plan.push({ fixture, index }); continue; }
    const dir = path.join(base, "projects", `${fixture.id}-${index}`);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(fixture.files)) { mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); writeFileSync(path.join(dir, name), content); }
    if (fixture.manifestPort) {
      mkdirSync(path.join(dir, ".lectern"), { recursive: true });
      writeFileSync(path.join(dir, ".lectern", "workspace.json"), JSON.stringify({ devServer: { command: "node server.mjs {port}", port: await freePort() } }) + "\n");
    }
    gitInit(dir);
    plan.push({ fixture, index, dir, projectId: `pc22_${fixture.id.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${index}` });
  }
  writeFileSync(path.join(dataDir, "projects.json"), JSON.stringify({ activeId: "default", projects: plan.filter((p) => p.dir).map((p) => ({ id: p.projectId, name: p.fixture.id, path: p.dir, createdAt: new Date().toISOString() })) }));

  const host = spawn(process.execPath, [HOST_BUNDLE], {
    env: { ...process.env, LECTERN_HOST_DATA: hostData, LECTERN_DATA_DIR: dataDir, LECTERN_WORKSPACE: defaultWs, LECTERN_HOST_WORKSPACE: defaultWs, RELAY_URL: RELAY, OPENAI_BASE_URL: RELAY, OPENAI_MODEL: MODEL, ...(verifierBootstrap ? { LECTERN_VERIFIER_BOOTSTRAP: verifierBootstrap } : {}) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  procs.push(host);
  let hostErr = ""; host.stderr.on("data", (d) => { hostErr = (hostErr + String(d)).slice(-4000); });
  const hostJson = path.join(hostData, "host.json");
  for (let i = 0; i < 200 && !existsSync(hostJson); i++) await sleep(50);
  const boot = JSON.parse(readFileSync(hostJson, "utf8"));
  const hostFetch = async (p, { method = "GET", body, credential = false } = {}) => {
    const res = await fetch(`http://127.0.0.1:${boot.port}${p}`, { method, headers: { authorization: `Bearer ${boot.token}`, ...(body ? { "content-type": "application/json" } : {}), ...(credential && COOKIE ? { "x-lectern-credential": COOKIE } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: { raw: text.slice(0, 200) } }; }
  };
  const taskOf = async (sid) => (await hostFetch(`/v1/sessions/${sid}/messages?view=window&limit=1`)).json?.task ?? null;
  const waitTask = async (sid, deadline) => {
    let task = await taskOf(sid);
    while (Date.now() < deadline && (!task || IN_PROGRESS.has(task.status))) { await sleep(1000); task = await taskOf(sid); }
    return task;
  };

  for (const { fixture, index, dir, projectId } of plan) {
    if (fixture.blocked) { runs.push({ case_id: fixture.id, run_index: index, outcome: "blocked", failure_category: "environment_blocked", notes: fixture.blocked }); console.log(`${fixture.id} ${index}: blocked`); continue; }
    if (!DRY && !COOKIE) { runs.push({ case_id: fixture.id, run_index: index, outcome: "not_run", failure_category: "missing_credential", notes: "未提供 LECTERN_EVAL_COOKIE，未调用模型" }); continue; }
    if (fixture.browser && !verifierBootstrap) { runs.push({ case_id: fixture.id, run_index: index, outcome: "not_run", failure_category: "environment_unavailable", notes: "找不到 Electron 浏览器驱动" }); continue; }
    const started = Date.now();
    const record = { case_id: fixture.id, run_index: index, category: fixture.category, fixture_hash: sha(JSON.stringify(fixture.files)) };
    try {
      const created = await hostFetch(`/v1/session-create?projectId=${projectId}`, { method: "POST", credential: true, body: { requestId: `pc22_${randomUUID().replace(/-/g, "")}`, isolate: !!fixture.isolate, model: { providerId: "openai", modelId: MODEL } } });
      const sid = created.json?.id;
      if (created.status !== 200 || !sid) throw Object.assign(new Error(`会话创建失败 ${created.status} ${JSON.stringify(created.json).slice(0, 160)}`), { category: "harness_error" });
      const ws = fixture.isolate ? created.json.isolation?.path : dir;
      if (fixture.isolate && !created.json.isolation?.enabled) throw Object.assign(new Error(`隔离副本未创建：${created.json.isolation?.reason ?? ""}`), { category: "harness_error" });
      const perm = await hostFetch(`/v1/sessions/${sid}`, { method: "PATCH", body: { permissionMode: "full" } });
      if (perm.status === 404 && perm.json?.error !== "SESSION_NOT_FOUND") {
        // before 版 Host 尚无会话改写端点：与旧执行器一致，经框架 store 直写会话权限（run 开始时读取）
        const { createSqliteSessionStore } = await import("@zmzai/agent-framework");
        await createSqliteSessionStore({ dataDir: path.join(dataDir, "projects", projectId) }).updateSession(sid, { permission: [{ permission: "*", pattern: "*", action: "allow" }] });
        record.permission_via = "store";
      } else if (perm.status !== 200) {
        throw Object.assign(new Error(`权限模式设置失败 ${perm.status}`), { category: "harness_error" });
      }
      record.isolated = !!fixture.isolate;

      if (DRY) {
        // 只验证管线：会话、隔离、权限、合并前置与浏览器驱动可用
        record.outcome = "not_run"; record.failure_category = "dry_run"; record.notes = `管线就绪：session ok, isolate=${!!fixture.isolate}, ws=${ws ? "ok" : "missing"}${fixture.browser ? `, verifier=${!!verifierBootstrap}` : ""}`;
        if (fixture.merge) {
          const merged = await hostFetch(`/v1/sessions/${sid}/worktree`, { method: "POST", body: { action: "merge" } });
          record.notes += `; 空改动合并=${merged.status} ${String(merged.json?.output ?? merged.json?.error ?? "").slice(0, 120)}`;
        }
        runs.push(record); console.log(`${fixture.id} ${index}: dry ${record.notes}`); continue;
      }

      const deadline = started + fixture.budgetMs;
      const receipt = await hostFetch("/v1/commands/prompt", { method: "POST", credential: true, body: { sessionId: sid, text: fixture.prompt, requestId: `pc22p_${randomUUID().replace(/-/g, "")}`, model: { providerId: "openai", modelId: MODEL } } });
      if (receipt.status !== 200) throw Object.assign(new Error(`prompt 被拒 ${receipt.status} ${JSON.stringify(receipt.json).slice(0, 160)}`), { category: "harness_error" });
      let task = await waitTask(sid, deadline);
      const originalTaskId = task?.id ?? receipt.json?.taskId ?? null;

      if (fixture.reply) {
        const before = (await hostFetch(`/v1/sessions/${sid}/messages`)).json ?? [];
        const blockTool = before.flatMap((m) => m.parts ?? []).some((p) => p.type === "tool" && p.tool === "task_block" && p.state?.status === "completed");
        const boundary = Object.entries(fixture.files).every(([n, c]) => existsSync(path.join(ws, n)) && readFileSync(path.join(ws, n), "utf8") === c) && (fixture.outputs ?? []).every((n) => !existsSync(path.join(ws, n)));
        record.initial_status = task?.status ?? null;
        record.blocked_correctly = task?.status === "waiting_input" && task?.blocker?.kind === "input" && blockTool && boundary;
        record.blocking_boundary_valid = boundary;
        if (task?.status === "waiting_input") {
          const resumed = await hostFetch("/v1/commands/prompt", { method: "POST", credential: true, body: { sessionId: sid, text: fixture.reply, requestId: `pc22r_${randomUUID().replace(/-/g, "")}`, model: { providerId: "openai", modelId: MODEL } } });
          record.resumed_same_task = (resumed.json?.taskId ?? null) === originalTaskId;
          task = await waitTask(sid, deadline);
        } else {
          record.resumed_same_task = false;
        }
      }

      if (fixture.merge && task?.status === "delivered") {
        const merged = await hostFetch(`/v1/sessions/${sid}/worktree`, { method: "POST", body: { action: "merge" } });
        record.merge = { status: merged.status, output: String(merged.json?.output ?? "").slice(0, 200) };
      }

      // 判分（工作区外）
      const checkDir = fixture.merge ? dir : ws; // 合并类在目标（主）工作区上回归
      let verification = false; let verificationDetail = "";
      try {
        if (fixture.check) execFileSync(process.execPath, ["--input-type=module", "-e", fixture.check], { cwd: checkDir, timeout: 20_000, stdio: "pipe" });
        if (fixture.checkCommand) execFileSync(fixture.checkCommand[0] === "node" ? process.execPath : fixture.checkCommand[0], fixture.checkCommand[1], { cwd: checkDir, timeout: 60_000, stdio: "pipe" });
        if (fixture.browser) {
          const indep = await independentBrowserCheck(verifierBootstrap, ws);
          record.independent_browser = indep;
          if (!indep.passed) throw new Error("独立浏览器复验未通过");
        }
        verification = true;
      } catch (error) { verificationDetail = String(error?.stderr ?? error?.message ?? error).slice(0, 240); }
      if (fixture.merge) {
        record.merged_into_target = record.merge?.status === 200;
        if (!record.merged_into_target) verification = false;
      }

      const protectedOk = Object.entries(fixture.files).filter(([n]) => !(fixture.editable ?? []).includes(n)).every(([n, c]) => existsSync(path.join(ws, n)) && readFileSync(path.join(ws, n), "utf8") === c);
      const allowed = new Set([...Object.keys(fixture.files), ...(fixture.outputs ?? []), ...(fixture.manifestPort ? [".lectern/workspace.json"] : [])]);
      const unexpected = readdirSync(ws, { recursive: true }).map(String).filter((p) => !p.startsWith(".git") && !p.startsWith(".lectern-worktrees") && !p.startsWith("node_modules") && !allowed.has(p) && !readdirSync(ws, { recursive: true }).map(String).some((q) => q.startsWith(`${p}/`)));
      const transcript = (await hostFetch(`/v1/sessions/${sid}/messages`)).json ?? [];
      const tools = transcript.flatMap((m) => m.parts ?? []).filter((p) => p.type === "tool");
      const toolCounts = {};
      for (const p of tools) toolCounts[p.tool] = (toolCounts[p.tool] ?? 0) + 1;
      const tokens = transcript.reduce((acc, m) => ({ input: acc.input + (m.info?.tokens?.input ?? 0), output: acc.output + (m.info?.tokens?.output ?? 0) }), { input: 0, output: 0 });
      // pi 1.5+ 消息级费用：total 求和；providerReported=全部为 provider 计费真值
      const costs = transcript.flatMap((m) => (m.info?.cost ? [m.info.cost] : []));
      const cost = costs.length ? costs.reduce((sum, c) => sum + (Number.isFinite(c.total) ? c.total : 0), 0) : null;
      const toolsOk = Object.entries(fixture.needTools ?? {}).every(([id, n]) => (toolCounts[id] ?? 0) >= n);
      const blockOk = !fixture.reply || (record.blocked_correctly && record.resumed_same_task);
      const delivered = task?.status === "delivered";
      Object.assign(record, {
        outcome: delivered && verification && protectedOk && unexpected.length === 0 && toolsOk && blockOk ? "pass" : "fail",
        failure_category: delivered && verification && protectedOk && unexpected.length === 0 && toolsOk && blockOk ? null
          : task?.blocker?.kind === "no_progress" && /502|503|上游|不可用/.test(task?.blocker?.message ?? "") ? "upstream_unavailable"
          : Date.now() > deadline && (!task || IN_PROGRESS.has(task.status)) ? "timeout"
          : !blockOk ? (record.blocked_correctly ? "incorrect_resume" : "incorrect_block")
          : !toolsOk ? "tool_not_used"
          : !verification ? "assertion"
          : !delivered ? "not_delivered" : "scope",
        task_status: task?.status ?? null, task_blocker: task?.blocker ? { kind: task.blocker.kind, message: String(task.blocker.message ?? "").slice(0, 160) } : null,
        verification, verification_detail: verificationDetail || undefined, protected_files_unchanged: protectedOk, unexpected_paths: unexpected,
        tool_counts: toolCounts, delivery_calls: tools.filter((p) => p.tool === "task_deliver").map((p) => ({ status: p.state?.status, ...(p.state?.status === "error" ? { error: String(p.state?.error ?? "").slice(0, 200) } : {}) })),
        tokens_input: tokens.input || null, tokens_output: tokens.output || null,
        cost, cost_provider_reported: costs.length ? costs.every((c) => c.totalFromProvider === true) : null,
        duration_ms: Date.now() - started, manual_interventions: 0,
      });
    } catch (error) {
      Object.assign(record, { outcome: "fail", failure_category: error?.category ?? "runtime_error", notes: String(error?.message ?? error).slice(0, 240), duration_ms: Date.now() - started });
    }
    runs.push(record);
    console.log(`${fixture.id} ${index}/${SAMPLES}: ${record.outcome}${record.failure_category ? ` (${record.failure_category})` : ""}`);
  }
  if (runs.some((r) => r.failure_category === "runtime_error")) report.environment.host_stderr_tail = hostErr.slice(-1500).replace(/muzhi_session=[^;\s"]+/g, "muzhi_session=<redacted>");
} finally {
  for (const p of procs) { try { p.kill("SIGTERM"); } catch { /* 已退出 */ } }
  await sleep(300);
  rmSync(base, { recursive: true, force: true });
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2));
const tally = runs.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
console.log(`PC22 ${LABEL}${DRY ? "（dry-run）" : ""}：${JSON.stringify(tally)} → ${OUT}`);
process.exitCode = runs.every((r) => r.outcome === "pass" || r.outcome === "blocked") ? 0 : 1;
