import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const fx = vi.hoisted(() => ({ dir: "", owner: (() => null) as (sid: string) => unknown, deps: null as unknown }));
vi.mock("./runtime-constants", () => ({ get dataDir() { return fx.dir; } }));
vi.mock("./session-owner", () => ({ resolveSessionOwner: (sid: string) => fx.owner(sid) }));
vi.mock("./runtime", () => ({
  sessionRuntime: (sid: string) => ({ store: { task: { getActiveTask: async () => ({ id: `task_${sid}` }) } } }),
  terminalManager: () => ({}),
}));
vi.mock("./service-instance", async (importOriginal) => ({ ...(await importOriginal<object>()), hostServiceDeps: () => fx.deps }));
import { createWorkspace } from "./workspace-service.js";
import { probeOrigin, type ServiceDeps } from "./service-instance.js";
import { createBrowserVerifyTool } from "./browser-verify-tool.js";

/** PC16 原生闭环（spec §5.1；P0 2026-11-07）：真实 Chromium（Electron 44 自带）
 *  在隔离 fixture 网站上执行 acceptance 计划——表单提交、路由、错误提示、双视口；
 *  首次因真实 bug 失败并留下真实截图证据 → 真实修改 worktree 源码修复一次 →
 *  自动新 attempt 重验通过 → ready_for_review；结果落库可由新连接读回（重启不丢）。
 *
 *  跑法：BROWSER_NATIVE_TEST=1 pnpm exec vitest run lib/browser-native.test.ts
 *  （ELECTRON_BIN 可覆盖 Electron 可执行文件；缺省依次找本仓库与主 checkout 的 node_modules）。
 *  隔离：verifier 窗口 show:false、非持久 partition、隐藏 Dock、临时 userData。 */
const NATIVE = process.env.BROWSER_NATIVE_TEST === "1";
const root = process.cwd();

function electronBin(): string | null {
  const rel = "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
  for (const candidate of [process.env.ELECTRON_BIN, path.join(root, rel), path.resolve(root, "../..", rel)]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address() as { port: number }; srv.close(() => resolve(port)); });
  });
}

const BUGGY_INDEX = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture App</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<nav id="nav"><a id="about-link" href="/about">关于</a></nav>
<form id="form"><input id="name" placeholder="姓名"><button id="submit" type="button">提交</button></form>
<div id="error"></div><div id="result"></div>
<script>
document.getElementById("submit").addEventListener("click", function () {
  var name = document.getElementById("name").value.trim();
  document.getElementById("error").textContent = name ? "" : "请输入姓名";
  // BUG：结果里漏了姓名
  document.getElementById("result").textContent = name ? "已提交：" : "";
});
</script></body></html>`;

const SERVER = `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const port = Number(process.argv[2]);
createServer((req, res) => {
  const file = req.url === "/about" ? "about.html" : "index.html";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(readFileSync(new URL(file, import.meta.url)));
}).listen(port, "127.0.0.1");
`;

describe.skipIf(!NATIVE)("PC16 原生：真实浏览器业务验收闭环", () => {
  const base = mkdtempSync(path.join(tmpdir(), "browser-native-"));
  fx.dir = path.join(base, "data");
  mkdirSync(fx.dir, { recursive: true });
  let electron: ChildProcess | null = null;
  const spawned = new Map<string, ChildProcess>();
  let worktree = "";

  beforeAll(async () => {
    const bin = electronBin();
    if (!bin) throw new Error("找不到 Electron 可执行文件（设置 ELECTRON_BIN）");
    const bootstrap = path.join(base, "verifier.json");
    electron = spawn(bin, [path.join(root, "scripts/native/electron-verifier-main.cjs")], {
      env: { ...process.env, LECTERN_VERIFIER_USERDATA: path.join(base, "electron-user"), LECTERN_VERIFIER_BOOTSTRAP_OUT: bootstrap, LECTERN_REPO_ROOT: root, ELECTRON_ENABLE_LOGGING: "0" },
      stdio: "ignore",
    });
    for (let i = 0; i < 150 && !existsSync(bootstrap); i++) await new Promise((r) => setTimeout(r, 100));
    if (!existsSync(bootstrap)) throw new Error("Electron verifier 未在 15s 内就绪");
    process.env.LECTERN_VERIFIER_BOOTSTRAP = bootstrap;

    // 隔离 fixture 项目：manifest 声明 devServer；会话在独立 worktree 中
    const repo = path.join(base, "fixture-app");
    mkdirSync(path.join(repo, ".lectern"), { recursive: true });
    writeFileSync(path.join(repo, "index.html"), BUGGY_INDEX);
    writeFileSync(path.join(repo, "about.html"), `<!doctype html><html><head><meta charset="utf-8"></head><body><h1 id="about">关于我们</h1></body></html>`);
    writeFileSync(path.join(repo, "server.mjs"), SERVER);
    writeFileSync(path.join(repo, ".lectern", "workspace.json"), JSON.stringify({ devServer: { command: "node server.mjs {port}", port: await freePort() } }));
    execSync("git init -q -b main && git config user.email t@t && git config user.name t && git add . && git commit -qm init", { cwd: repo, shell: "/bin/bash" });
    fx.owner = (sid: string) => {
      const wt = path.join(repo, ".lectern-worktrees", sid);
      return { sessionId: sid, project: { id: "fixture", path: repo }, effectiveWorkspaceRoot: existsSync(wt) ? wt : repo };
    };
    const created = await createWorkspace({ dataDir: fx.dir, projectId: "fixture", projectPath: repo, sessionId: "ses_native_form" });
    if (!created.ok) throw new Error("workspace 创建失败");
    worktree = created.record.path;

    // 受管开发服务：真实子进程（与生产 TerminalManager 等价的最小实现）
    const deps: ServiceDeps = {
      spawnService: async ({ command, cwd }) => {
        const child = spawn(command, { cwd, shell: "/bin/bash", stdio: "ignore", detached: true });
        const id = `svc_${child.pid}`;
        spawned.set(id, child);
        return { terminalId: id, ...(child.pid ? { pid: child.pid } : {}) };
      },
      stopSpawned: async (id) => { const child = spawned.get(id); spawned.delete(id); try { if (child?.pid) process.kill(-child.pid); } catch { /* 已退出 */ } },
      portAllocator: (_ws, preferred) => preferred ?? 0,
      probe: (origin, expected) => probeOrigin(origin, expected),
    };
    fx.deps = deps;
  }, 60_000);

  afterAll(async () => {
    for (const [, child] of spawned) { try { if (child.pid) process.kill(-child.pid); } catch { /* 已退出 */ } }
    electron?.kill();
    delete process.env.LECTERN_VERIFIER_BOOTSTRAP;
    await rm(base, { recursive: true, force: true });
  });

  it("表单提交/路由/错误提示 × 桌面+移动视口：首败留真实证据 → 修复一次 → 重验通过", async () => {
    const tool = createBrowserVerifyTool();
    const call = (args: Record<string, unknown>) => tool.execute(tool.parameters.parse(args), { sessionId: "ses_native_form", abort: new AbortController().signal } as never);

    const planned = await call({
      action: "plan",
      viewports: [{ width: 1280, height: 800 }, { width: 390, height: 844 }],
      steps: [
        { kind: "goto", target: "/" },
        { kind: "click", target: "#submit" },
        { kind: "assert_dom", target: "#error", value: "请输入姓名" },
        { kind: "type", target: "#name", value: "Ada" },
        { kind: "click", target: "#submit" },
        { kind: "assert_dom", target: "#result", value: "已提交：Ada" },
        { kind: "goto", target: "/about" },
        { kind: "assert_dom", target: "#about", value: "关于我们" },
      ],
    });
    expect(planned.metadata).toMatchObject({ ok: true });

    const first = await call({ action: "run" });
    expect(first.metadata).toMatchObject({ status: "failed", repairsLeft: 1 });
    expect(first.output).toContain("assert_dom");
    expect(first.output).toMatch(/@1280x800|@390x844/);
    // 真实截图证据落在 dataDir/browser-screenshots，且是 PNG
    const ref = /截图证据：([^、\n]+)/.exec(first.output)?.[1];
    expect(ref).toBeTruthy();
    const png = readFileSync(path.join(fx.dir, ref!));
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    console.log(`[pc16-native] 首次失败证据：\n${first.output}`);

    // 修复一次：真实修改 worktree 源码（不改验收计划）
    const fixed = readFileSync(path.join(worktree, "index.html"), "utf8").replace('name ? "已提交：" : ""', 'name ? "已提交：" + name : ""');
    writeFileSync(path.join(worktree, "index.html"), fixed);

    const second = await call({ action: "run" });
    console.log(`[pc16-native] 修复后重验：${second.output}`);
    expect(second.metadata).toMatchObject({ ok: true, status: "passed" });

    // 重启不丢：新连接直接读库——两次 run（failed→passed）与终态都已持久化
    const { DatabaseSync } = await import("node:sqlite");
    const dbFile = path.join(fx.dir, "deliveries", "deliveries.db");
    expect(existsSync(dbFile)).toBe(true);
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const statuses = (db.prepare("SELECT status FROM browser_verification_runs ORDER BY started_at ASC").all() as { status: string }[]).map((r) => r.status);
      expect(statuses).toEqual(["failed", "passed"]);
      const attempts = db.prepare("SELECT status FROM delivery_attempts WHERE session_id = ?").all("ses_native_form") as { status: string }[];
      expect(attempts.map((a) => a.status)).toContain("ready_for_review");
    } finally {
      db.close();
    }
  }, 120_000);
});
