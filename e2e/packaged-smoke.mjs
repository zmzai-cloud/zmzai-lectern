import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { _electron } from "playwright";

const executablePath = resolve(process.argv[2] ?? (process.platform === "darwin"
  ? "dist/mac-arm64/Lectern.app/Contents/MacOS/Lectern" : "dist/win-unpacked/Lectern.exe"));
const root = mkdtempSync(join(tmpdir(), "lectern-packaged-smoke-"));
const userData = join(root, "profile");
const workspace = join(root, "workspace with spaces");
const reportDir = resolve(process.env.LECTERN_SMOKE_REPORT_DIR ?? "test-results/packaged-smoke");
mkdirSync(workspace, { recursive: true });
mkdirSync(reportDir, { recursive: true });
execFileSync("git", ["init", workspace]);
execFileSync("git", ["-C", workspace, "config", "user.name", "Lectern Smoke"]);
execFileSync("git", ["-C", workspace, "config", "user.email", "smoke@localhost"]);
writeFileSync(join(workspace, "README.md"), "# Packaged smoke\n");
execFileSync("git", ["-C", workspace, "add", "README.md"]);
execFileSync("git", ["-C", workspace, "commit", "-m", "fixture"]);

const portServer = createServer();
await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
const port = portServer.address().port;
await new Promise((r) => portServer.close(r));
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, LECTERN_USER_DATA_DIR: userData, LECTERN_WEB_PORT: String(port) };
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_WEB_URL;
const results = [];
let passed = false;
// 失败原因要落进报告文件：CI 上没人看得到 stdout，产物里的 passed:false 而不带原因
// 等于让人去重跑一遍才知道挂在哪。
let failure;
let desktop;

async function api(path, method = "GET", body) {
  const response = await fetch(origin + path, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
  return response.json();
}

async function launch() {
  desktop = await _electron.launch({ executablePath, env, timeout: 90000 });
  const window = await desktop.firstWindow({ timeout: 90000 });
  await window.waitForLoadState("domcontentloaded");
  const homepage = await fetch(origin, { signal: AbortSignal.timeout(15000) });
  assert.equal(homepage.status, 200, "Packaged homepage must return HTTP 200");
  assert.equal(await desktop.evaluate(({ app }) => app.getPath("userData")), userData, "Profile is not isolated");
  assert.equal(await desktop.evaluate(({ app }) => app.isPackaged), true);
  if (process.env.LECTERN_SMOKE_CROSS_DRIVE === "1") {
    const appPath = await desktop.evaluate(({ app }) => app.getAppPath());
    assert.notEqual(parse(appPath).root.toLowerCase(), parse(userData).root.toLowerCase(), "Actual app and profile must be on different drives");
  }
  // Windows 渲染器首帧 body 可能尚未就绪（waitForLoadState 在初始空文档上就返回）；
  // predicate 必须 null 安全：null 时返回 false 持续重试，渲染失败则走正常超时。
  await window.waitForFunction(() => (document.body?.innerText ?? "").trim().length > 20);
  await window.locator(".account-block > button").waitFor();
  assert.equal(await window.evaluate(() => window.lecternNative.platform), process.platform);
  return window;
}

// ── 硬杀重启 + 遗留租约恢复的辅助 ───────────────────────────────────────
const SEEDED_LEASE_OWNER = "node:smoke-crashed";
const SEEDED_TITLE_INPUT = "恢复验收·待补充";
const SEEDED_TITLE_UNSAFE = "恢复验收·待确认";
// 与 lib/task-layout.ts 的 DESKTOP_MIN_WIDTH 同值。这里没法 import 那个模块
// （.mjs 拉不起 TS），所以改那边时这里要一起改——它是「视口够不够宽」的判据。
const DESKTOP_MIN_WIDTH = 1180;

/** 找出**包含全部目标会话**的那个 SQLite 库。
 *
 *  两件事都不能猜：① 库的位置按项目分目录（`<dataDir>/zmzai.db` 或
 *  `<dataDir>/projects/<id>/zmzai.db`），落在哪个取决于启动时的活动项目；
 *  ② 打包版里可能**同时存在多个库**（默认项目一个、显式添加的项目一个），
 *  取「第一个找到的」会取错——这条用例第一次跑就栽在这里。
 *  所以：递归收集所有 `zmzai.db`，按「这些会话都在里面」筛选。 */
function findSmokeDatabase(sessionIds) {
  const candidates = [];
  for (const root of [join(userData, "data"), userData]) {
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const next = join(current, entry.name);
        if (entry.isDirectory()) stack.push(next);
        else if (entry.name === "zmzai.db" && !candidates.includes(next)) candidates.push(next);
      }
    }
    if (candidates.length) break;
  }
  const placeholders = sessionIds.map(() => "?").join(",");
  for (const candidate of candidates) {
    try {
      const db = new DatabaseSync(candidate);
      try {
        db.exec("PRAGMA busy_timeout = 5000;");
        const row = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id IN (${placeholders})`).get(...sessionIds);
        if (row.n === sessionIds.length) return candidate;
      } finally {
        db.close();
      }
    } catch {
      /* 不是我们要的库（空库 / 表还没建），继续找 */
    }
  }
  if (candidates.length) console.log(`找到 ${candidates.length} 个 zmzai.db，但没有一个包含全部目标会话：${candidates.join(", ")}`);
  return null;
}

/** 种一份「应用被硬杀那一刻」的磁盘状态：过期租约 + 仍在 running 的任务。
 *
 *  不经过任何产品 API：runner 是要跑起一个真实 run 才会盖章租约的，而打包冒烟
 *  不许调模型（release-gates 要求它可离线跑）。**如实记录**：磁盘状态是构造的，
 *  但恢复过程与界面表现都是真实的；没有构造的部分是「租约由 runner 亲手盖上」。 */
function seedOrphanedRuns(dbPath, entries) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const now = new Date().toISOString();
    // 写成「已过期」而不是「即将过期」：恢复扫描在 runtime 首次创建时立即跑一次，
    // 租约没过期就不会被收，得等 60s 的下一轮——那会把用例变成看天吃饭的慢用例。
    const expired = new Date(Date.now() - 60_000).toISOString();
    for (const entry of entries) {
      const row = db.prepare("SELECT json FROM sessions WHERE id=?").get(entry.sessionId);
      assert.ok(row, `种子会话 ${entry.sessionId} 必须先在库里（用 API 创建）`);
      const session = JSON.parse(row.json);
      session.title = entry.title;
      session.leaseOwner = SEEDED_LEASE_OWNER;
      session.leaseExpiresAt = expired;
      db.prepare("UPDATE sessions SET json=?, updated=? WHERE id=?").run(JSON.stringify(session), now, entry.sessionId);

      const taskId = `task_seed_${entry.sessionId.slice(-6)}`;
      const requestId = `req_seed_${entry.sessionId.slice(-6)}`;
      const task = {
        id: taskId,
        sessionId: entry.sessionId,
        rootRequestId: requestId,
        rootUserMessageId: "msg_seed_root",
        goal: entry.goal,
        status: "running",
        acceptanceCriteria: [{ id: "crit_seed", description: "README 已改写", required: true, status: "pending", evidenceIds: [] }],
        steps: [{ id: "step_seed", title: "改写 README", status: "in_progress", order: 0, evidenceIds: [] }],
        currentStepId: "step_seed",
        evidence: [],
        revision: 1,
        attemptCount: 1,
        noProgressCount: 0,
        constraints: [],
        createdAt: now,
        updatedAt: now,
      };
      db.prepare("INSERT INTO tasks (id,session_id,request_id,status,revision,created,updated,json) VALUES (?,?,?,?,?,?,?,?)")
        .run(taskId, entry.sessionId, requestId, task.status, task.revision, task.createdAt, task.updatedAt, JSON.stringify(task));

      if (entry.runningToolCall) {
        // 一条「跑了但没收尾」的工具调用：恢复时它决定任务落 unsafe_replay
        // （规格 §10.2：不得自动重放未知副作用），而不是轻量的 input。
        const seq = db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM events WHERE session_id=?").get(entry.sessionId).n;
        const event = {
          id: `evt_seed_${seq}`, sessionId: entry.sessionId, seq, type: "message.part.updated", at: now,
          data: {
            part: {
              id: "part_seed_tool", sessionId: entry.sessionId, messageId: "msg_seed_root",
              type: "tool", callId: "call_seed_1", tool: "bash",
              state: { status: "running", input: { command: "git push" }, time: { start: now } },
            },
          },
        };
        db.prepare("INSERT INTO events (session_id,seq,id,type,at,json) VALUES (?,?,?,?,?,?)")
          .run(entry.sessionId, seq, event.id, event.type, event.at, JSON.stringify(event));
      }
    }
  } finally {
    db.close();
  }
  return entries.map((entry) => entry.sessionId);
}

/** 硬杀后回读：确认租约与非终态任务确实留在盘上——这是恢复扫描的输入条件。 */
function readSeededState(dbPath, sessionIds) {
  const db = new DatabaseSync(dbPath);
  try {
    // 主进程已经退出，但它的子进程可能还握着 WAL 一小会儿（Windows 上尤其如此）。
    db.exec("PRAGMA busy_timeout = 5000;");
    return sessionIds.map((id) => {
      const session = JSON.parse(db.prepare("SELECT json FROM sessions WHERE id=?").get(id).json);
      const task = JSON.parse(db.prepare("SELECT json FROM tasks WHERE session_id=? ORDER BY created DESC LIMIT 1").get(id).json);
      return { id, leaseOwner: session.leaseOwner, leaseExpiresAt: session.leaseExpiresAt, taskStatus: task.status };
    });
  } finally {
    db.close();
  }
}

/** 硬杀：**不调 `desktop.close()`**。优雅关闭会正常释放租约，那就永远走不到恢复路径。 */
async function hardKillPackagedApp() {
  const child = desktop.process();
  const pid = child.pid;
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), 15000);
    child.once("exit", () => { clearTimeout(timer); resolve(true); });
  });
  child.kill("SIGKILL");
  const ok = await exited;
  desktop = undefined;
  assert.ok(ok, "SIGKILL 之后打包版进程没有退出");
  return pid;
}

/** 等任务被恢复扫描收尾。扫描在 runtime 首次创建时立即跑一次，但是异步的
 *  （`void scan()`），所以这里等结果而不是等时间。 */
async function waitForTaskState(sessionId, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const view = await api(`/api/sessions/${encodeURIComponent(sessionId)}/task`);
    last = view.task;
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`任务未在 ${timeoutMs}ms 内恢复，最后状态：${JSON.stringify(last)}`);
}

try {
  const window = await launch();
  results.push("packaged app launched with isolated profile and native platform bridge");
  await api("/api/projects", "POST", { path: workspace });
  const session = await api("/api/sessions", "POST", { agent: "default", model: { providerId: "openai", modelId: "smoke-no-network" } });
  assert.ok(session.id);
  results.push("project with spaces and SQLite-backed session creation");
  const fileUrl = `/api/fs/file?path=README.md&sessionId=${encodeURIComponent(session.id)}`;
  assert.match((await api(fileUrl)).content, /Packaged smoke/);
  await api("/api/fs/file", "PUT", { path: "README.md", sessionId: session.id, content: "# Changed\n" });
  assert.equal(readFileSync(join(workspace, "README.md"), "utf8"), "# Changed\n");
  results.push("workspace file read/write");
  const terminal = await api("/api/terminal", "POST", { sessionId: session.id, command: "git status --short" });
  assert.equal(terminal.backend, "pty", "Native terminal silently fell back to pipes");
  let output = "";
  let exited = false;
  let cursor = 0;
  for (let i = 0; i < 100; i++) {
    const chunk = await api(`/api/terminal/${terminal.id}/read?cursor=${cursor}`);
    output += chunk.output ?? "";
    cursor = chunk.cursor ?? cursor;
    if (chunk.session?.status !== "running") {
      assert.equal(chunk.session?.exitCode, 0, "Git command did not exit successfully");
      exited = true; break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(exited, "Terminal did not exit");
  assert.match(output, /README\.md/);
  results.push("native terminal and real Git command");
  // Replace only the trusted update host in this isolated main process; no real installer runs.
  const nextVersion = await desktop.evaluate(({ app, dialog }) => {
    const version = app.getVersion().split(".").map(Number);
    version[2] += 1;
    const next = version.join(".");
    const bytes = Buffer.from("packaged update fixture");
    const crypto = process.getBuiltinModule("crypto");
    const name = process.platform === "darwin" ? `Lectern-${next}-arm64-mac.zip` : `Lectern-Setup-${next}.exe`;
    const path = `v${next}/${name}`;
    const manifest = { schema: 1, version: next, platforms: {
      [`${process.platform}-${process.arch}`]: { path, size: bytes.length, sha512: crypto.createHash("sha512").update(bytes).digest("base64") },
    } };
    const originalFetch = globalThis.fetch;
    const originalDialog = dialog.showMessageBox;
    globalThis.__restoreUpdateSmoke = () => { globalThis.fetch = originalFetch; dialog.showMessageBox = originalDialog; };
    globalThis.fetch = async (input, options) => {
      if (input === "https://zmzai.oss-cn-beijing.aliyuncs.com/releases/harness/latest-desktop.json") return new Response(JSON.stringify(manifest));
      if (input === `https://zmzai.oss-cn-beijing.aliyuncs.com/releases/harness/${path}`) return new Response(bytes);
      return originalFetch(input, options);
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    return next;
  });
  try {
    const update = await window.evaluate(() => window.lecternNative.updateCheck());
    assert.equal(update.status, "available");
    assert.equal(update.version, nextVersion);
    await window.locator(".account-block > button").click();
    await window.getByRole("button", { name: `下载 v${nextVersion}`, exact: true }).click();
    await window.waitForFunction(async () => (await window.lecternNative.updateState()).status === "ready");
    const label = process.platform === "darwin" ? "查看更新包并手动替换" : `安装 v${nextVersion}`;
    await window.getByRole("button", { name: label, exact: true }).waitFor();
    assert.equal(await window.evaluate(() => window.lecternNative.updateInstall()), false);
    assert.equal(await window.evaluate(() => window.lecternNative.updateState()).then((s) => s.status), "ready");
    results.push("packaged updater IPC, account-menu download, SHA-512 verification and cancelled install");
  } finally {
    await desktop.evaluate(() => globalThis.__restoreUpdateSmoke());
  }
  // Native smoke must not depend on remote font loading; screenshots are covered by browser UI checks.
  if (process.env.LECTERN_SMOKE_SCREENSHOT === "1") {
    await window.screenshot({ path: join(reportDir, `${process.platform}-desktop.png`), timeout: 90000, animations: "disabled" });
  }
  // ── 硬杀重启：任务恢复（规格 3 §11 / §16 阶段 D 的端到端证据）────────────
  // 这一段以前是 desktop.close() 的优雅关闭：租约被正常释放，永远走不到恢复路径
  // （framework 的 lease-recovery.test.ts 覆盖租约语义，但没接到真实启动路径上）。
  // 现在换成硬杀——崩溃 / 断电 / 被任务管理器结束，才是恢复逻辑真正要面对的。
  const orphanSession = await api("/api/sessions", "POST", { agent: "default", model: { providerId: "openai", modelId: "smoke-no-network" } });
  const seeds = [
    { sessionId: session.id, title: SEEDED_TITLE_INPUT, goal: "把 README 改写成一句话简介", runningToolCall: false },
    { sessionId: orphanSession.id, title: SEEDED_TITLE_UNSAFE, goal: "把 README 改写成一句话简介", runningToolCall: true },
  ];
  const dbPath = findSmokeDatabase(seeds.map((seed) => seed.sessionId));
  assert.ok(dbPath, "找不到包含这两个会话的 zmzai.db");
  const seededIds = seedOrphanedRuns(dbPath, seeds);
  results.push("seeded an expired lease and a running task (one with an unfinished tool call)");

  const killedPid = await hardKillPackagedApp();
  for (const item of readSeededState(dbPath, seededIds)) {
    assert.equal(item.leaseOwner, SEEDED_LEASE_OWNER, `${item.id}: 硬杀后租约不该被清掉`);
    assert.equal(item.taskStatus, "running", `${item.id}: 硬杀后任务仍应是 running`);
  }
  results.push(`hard-killed the packaged app (pid ${killedPid}); expired lease and running task survived on disk`);

  const revived = await launch();
  const restored = await api("/api/sessions");
  assert.ok(restored.some((s) => s.id === session.id), "Session lost after restart");
  results.push("restart after a hard kill preserves project and session data");

  // 两个分支必须落成不同的状态——它们的界面文案与可点动作都不一样：
  //   无未收尾工具调用 → waiting_input(input)  ：补一句话就能继续；
  //   有未收尾工具调用 → blocked(unsafe_replay)：必须先核对副作用，不得自动重放。
  const recoveredInput = await waitForTaskState(session.id, (t) => t.status === "waiting_input");
  assert.equal(recoveredInput.blocker?.kind, "input", `没有未收尾工具调用时应落 input：${JSON.stringify(recoveredInput)}`);
  assert.equal(recoveredInput.blocker?.resumable, true);
  const recoveredUnsafe = await waitForTaskState(orphanSession.id, (t) => t.status === "blocked");
  assert.equal(recoveredUnsafe.blocker?.kind, "unsafe_replay", `有未收尾工具调用时必须落 unsafe_replay：${JSON.stringify(recoveredUnsafe)}`);
  assert.equal(recoveredUnsafe.blocker?.resumable, true);
  results.push("both interrupted tasks settled: waiting_input(input) and blocked(unsafe_replay)");

  // runner 的显示器比主窗口的 1280 窄时，窗口会被系统约束到更小；落到紧凑档后
  // 侧栏是默认关闭的覆盖层，会话条目根本不在 DOM 里。其余 E2E 早有这个约定。
  const viewport = await revived.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  if (viewport.width < DESKTOP_MIN_WIDTH) {
    await revived.getByRole("button", { name: "展开会话栏", exact: true }).click({ timeout: 15000 });
    results.push(`viewport ${viewport.width}×${viewport.height} is below ${DESKTOP_MIN_WIDTH}; opened the session overlay`);
  }

  // 列表格必须与任务状态一致：会话列表的文案是从 task lifecycle 取的，不靠 summary 反推。
  //
  // 期望值来自实测而非推导：`waiting_input` 这一格用的是 `TASK_TONE` 的状态文案
  // （「等待补充」），只有 `blocked` 才会换成 blocker 细分文案（「外部状态待确认」）
  // ——两者取自两个不同的表，很容易想当然写错。
  const listTitles = await revived.evaluate(() => [...document.querySelectorAll('[role="button"][title]')].map((el) => el.getAttribute("title") ?? ""));
  assert.ok(listTitles.some((title) => title.includes(SEEDED_TITLE_INPUT) && title.includes("· 等待补充 ·")), `列表未显示「等待补充」：${listTitles.join(" | ")}`);
  assert.ok(listTitles.some((title) => title.includes(SEEDED_TITLE_UNSAFE) && title.includes("外部状态待确认")), `列表未显示「外部状态待确认」：${listTitles.join(" | ")}`);
  results.push("session list labels follow the recovered task states");

  // 任务卡：文案与动作必须与 blocker 对应，而不是笼统的一句「已阻塞」。
  // 用 title 前缀点会话条目（它的 title 就是「标题 · 状态文案 · 模型」），比按文本
  // 命中更准——标题同时会出现在别处。
  await revived.locator(`[role="button"][title^="${SEEDED_TITLE_UNSAFE}"]`).first().click({ timeout: 30000 });
  const unsafeCard = revived.locator('[data-task-blocker="unsafe_replay"]');
  await unsafeCard.waitFor({ timeout: 30000 });
  assert.match(await unsafeCard.locator("[data-task-blocker-message]").innerText(), /可能已经产生了副作用/);
  await revived.getByRole("button", { name: "检查后重试", exact: true }).waitFor({ timeout: 15000 });
  results.push("blocked card explains the unsafe-replay risk and offers 「检查后重试」");

  await revived.locator(`[role="button"][title^="${SEEDED_TITLE_INPUT}"]`).first().click({ timeout: 30000 });
  const inputCard = revived.locator('[data-task-blocker="input"]');
  await inputCard.waitFor({ timeout: 30000 });
  assert.match(await inputCard.locator("[data-task-blocker-message]").innerText(), /任务停在了中途/);
  await revived.getByRole("button", { name: "补充信息", exact: true }).waitFor({ timeout: 15000 });
  results.push("waiting_input card names what was interrupted and offers 「补充信息」");

  passed = true;
  console.log("Packaged smoke passed:\n" + results.join("\n"));
} catch (error) {
  failure = error;
  throw error;
} finally {
  if (desktop) await desktop.close();
  writeFileSync(join(reportDir, `${process.platform}-report.json`), JSON.stringify({
    passed, executablePath, profile: userData, results,
    ...(failure ? { failure: String(failure.stack ?? failure) } : {}),
  }, null, 2));
  console.log(`Smoke fixtures and logs preserved at ${root}`);
}
