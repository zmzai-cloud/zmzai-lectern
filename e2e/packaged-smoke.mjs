import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { _electron } from "playwright";

const executablePath = resolve(process.argv[2] ?? (process.platform === "darwin"
  ? "dist/mac-arm64/Lectern.app/Contents/MacOS/Lectern" : "dist/win-unpacked/Lectern.exe"));
const root = mkdtempSync(join(tmpdir(), "lectern-packaged-smoke-"));
const userData = join(root, "profile");
const workspace = join(root, "workspace with spaces");
const reportDir = resolve("test-results/packaged-smoke");
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
  assert.equal(await desktop.evaluate(({ app }) => app.getPath("userData")), userData, "Profile is not isolated");
  assert.equal(await desktop.evaluate(({ app }) => app.isPackaged), true);
  await window.waitForFunction(() => document.body.innerText.trim().length > 20);
  assert.equal(await window.evaluate(() => window.lecternNative.platform), process.platform);
  return window;
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
  await desktop.close(); desktop = undefined;
  await launch();
  const restored = await api("/api/sessions");
  assert.ok(restored.some((s) => s.id === session.id), "Session lost after restart");
  results.push("restart preserves project and session data");
  passed = true;
  console.log("Packaged smoke passed:\n" + results.join("\n"));
} finally {
  if (desktop) await desktop.close();
  writeFileSync(join(reportDir, `${process.platform}-report.json`), JSON.stringify({ passed, executablePath, profile: userData, results }, null, 2));
  console.log(`Smoke fixtures and logs preserved at ${root}`);
}
