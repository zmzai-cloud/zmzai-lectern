import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";

/**
 * 原生剪贴板粘贴入口验收（规格 2 §7.2 / §18.13 的桌面一侧）。
 *
 * 【与 attachments-ui.mjs 的分工】那边用页面内合成的 ClipboardEvent 测「Composer 拿到
 * files 之后怎么处理」——上传协议、卡片状态机、失败重试都在那里。它证不了的是**前半段**：
 * 系统剪贴板里的一份文件，渲染进程到底能不能读成 File。合成事件天然把这一步跳过了。
 * 只有真实 Electron 渲染进程 + 真实系统剪贴板能回答，所以单开这个文件。
 *
 * 【跑法】需要 next server 已在跑（`pnpm build && pnpm start`，或 `pnpm dev:web`）：
 *   node e2e/clipboard-native-ui.mjs
 *
 * 【平台】macOS 与 Windows，但两侧写入的**不是同一种机制**，差别必须讲清楚：
 *   - macOS：用 Electron 自己的 clipboard.write 写 text/uri-list。落盘类型与 Finder
 *     ⌘C 的 furl 一致，但**写入方不是 Finder**——「Finder ⌘C 本身」仍未验证。
 *   - Windows：用 PowerShell 的 Set-Clipboard -Path 写 CF_HDROP，也就是资源管理器
 *     Ctrl+C 落盘的同一格式；写完由另一个进程回读 FileDropList 确认（顺带证伪
 *     「剪贴板数据随写入进程退出而失效」这个假设）。
 * Linux 跳过。
 */

const BASE = process.env.LECTERN_TEST_URL || "http://127.0.0.1:3100";
const reportDir = resolve(process.env.LECTERN_UI_OUTPUT || "test-results/clipboard-native");
const SES = "ses_clipboard";
const SESSION_TITLE = "剪贴板验收";

if (process.platform !== "darwin" && process.platform !== "win32") {
  console.log(`[skip] 原生剪贴板验收只在 macOS 与 Windows 上实现（当前平台 ${process.platform}）。`);
  process.exit(0);
}
const PASTE_KEY = process.platform === "darwin" ? "Meta+V" : "Control+V";
const PASTE_LABEL = process.platform === "darwin" ? "⌘V" : "Ctrl+V";

mkdirSync(reportDir, { recursive: true });

const probe = await fetch(BASE, { signal: AbortSignal.timeout(5000) }).catch(() => null);
if (!probe || !probe.ok) {
  console.error(`next server 不可达：${BASE}`);
  console.error("先跑 `pnpm build && pnpm start`（或 `pnpm dev:web`）再执行本脚本。");
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), "lectern-clipboard-"));
const profile = join(root, "profile");
mkdirSync(profile, { recursive: true });

/** 1×1 PNG：体积小、类型可嗅探，便于断言卡片显示的元信息。 */
const SAMPLE_NAME = "clipboard-sample.png";
const SAMPLE_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001",
  "hex",
);
const samplePath = join(root, SAMPLE_NAME);
writeFileSync(samplePath, SAMPLE_BYTES);

const results = [];
let passed = false;
const errors = [];
const uploads = [];
// 用哪种机制写的剪贴板、用哪条路径触发粘贴，都要进报告：报告是「验了什么」的唯一
// 凭据，不能只有 passed 一个布尔值。
let writer = null;
let pasteRoute = null;

const env = { ...process.env };
// 这个环境默认设了 ELECTRON_RUN_AS_NODE：Electron 会以 Node 模式起来、不建 GUI，
// Playwright 永远等不到调试握手。产品代码与 CI 都不依赖它。
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
env.LECTERN_WEB_URL = BASE;
env.LECTERN_USER_DATA_DIR = profile;

let desktop;
try {
  // --no-sandbox / --disable-gpu：当前沙箱不允许 Electron 初始化自身进程沙箱
  // （sandbox initialization failed: Operation not permitted → GPU 进程崩溃 → 退出）。
  desktop = await _electron.launch({
    args: ["--no-sandbox", "--disable-gpu", "electron/main.cjs"],
    cwd: resolve("."),
    env,
    timeout: 90000,
  });
  const window = await desktop.firstWindow({ timeout: 90000 });
  await window.waitForFunction(() => (document.body?.innerText ?? "").trim().length > 20, null, { timeout: 60000 });

  window.on("pageerror", (error) => errors.push(error.message));

  // 失败取证：这个用例只在有 GUI 会话的机器上跑，本机不容易复现 CI 的环境差异
  // （曾经出现过「窗口起来了但会话列表没渲染」）。把网络流水与页面文本留下来，
  // 否则只能拿到一句超时，等于白跑一轮。
  const netlog = [];
  window.on("request", (request) => netlog.push(`→ ${request.method()} ${request.url().slice(0, 120)}`));
  window.on("response", (response) => netlog.push(`← ${response.status()} ${response.url().slice(0, 120)}`));
  window.on("requestfailed", (request) => netlog.push(`✗ ${request.url().slice(0, 120)} ${request.failure()?.errorText ?? ""}`));
  const dump = async (label, error) => {
    await window.screenshot({ path: join(reportDir, `${label}.png`), animations: "disabled" }).catch(() => {});
    const body = await window.locator("body").innerText().catch(() => "");
    const shape = await window
      .evaluate(() => ({ href: location.href, innerWidth, innerHeight, native: typeof window.lecternNative }))
      .catch(() => null);
    return `${error.message}\n地址与视口：${JSON.stringify(shape)}\n最近网络：\n${netlog.slice(-25).join("\n")}\n页面文本：\n${body.slice(0, 1500)}`;
  };

  results.push("Electron 主进程与渲染窗口建立（真实系统剪贴板可用）");

  // mock 掉服务端：本用例要证的是剪贴板到卡片这一段，真实上传链路由单测与
  // attachments-ui.mjs 覆盖。route 必须在 reload 之前挂上。
  await window.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === "/api/sessions") {
      return route.fulfill({
        json: [{ id: SES, title: SESSION_TITLE, agent: "default", model: { providerId: "openai", modelId: "gpt-test" }, time: { created: "2026-09-18T00:00:00Z" } }],
      });
    }
    if (path === `/api/sessions/${SES}/messages`) {
      return route.fulfill({ json: { messages: [], beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0 } });
    }
    if (method === "POST" && /\/attachments$/.test(path)) {
      const raw = request.postDataBuffer()?.toString("latin1") ?? "";
      const name = /filename="([^"]*)"/.exec(raw)?.[1] ?? "file";
      uploads.push(name);
      return route.fulfill({
        json: {
          ok: true,
          attachment: { attachmentId: "att_clip_0001", filename: name, mediaType: "image/png", size: SAMPLE_BYTES.byteLength, sha256: "0".repeat(64), kind: "image", status: "ready" },
        },
      });
    }
    if (method === "GET" && /\/attachments\/[^/]+$/.test(path)) {
      return route.fulfill({ json: { attachment: { attachmentId: "att_clip_0001", filename: SAMPLE_NAME, mediaType: "image/png", size: SAMPLE_BYTES.byteLength, sha256: "0".repeat(64), kind: "image", status: "ready" }, availability: true } });
    }
    if (method === "DELETE" && /\/attachments\/[^/]+$/.test(path)) return route.fulfill({ json: { ok: true } });
    if (path === `/api/sessions/${SES}/prompt`) return route.fulfill({ json: { requestId: "req_clip", userMessageId: "msg_clip" } });
    if (path.endsWith("/worktree")) return route.fulfill({ json: { enabled: false } });
    if (path === "/api/auth/status") return route.fulfill({ json: { loggedIn: true, user: { name: "Clipboard QA" } } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], authenticated: true } });
    if (path === "/api/skills") return route.fulfill({ json: { skills: [] } });
    if (path === "/api/settings/permissions") return route.fulfill({ json: { permissions: {} } });
    if (path === "/api/projects") return route.fulfill({ json: { projects: [], activeId: "default" } });
    return route.fulfill({ json: {} });
  });

  await window.reload({ waitUntil: "domcontentloaded" });
  try {
    await window.getByText(SESSION_TITLE, { exact: true }).click({ timeout: 30000 });
  } catch (error) {
    throw new Error(await dump("session-list-missing", error));
  }
  await window.locator(".chat-composer").waitFor({ timeout: 30000 });
  const textarea = window.locator('textarea[aria-label="消息"]');
  const cards = window.locator('ul[aria-label^="待发送附件"] > li');
  assert.equal(await cards.count(), 0, "开始前不应有附件卡片");

  if (process.platform === "win32") {
    // 资源管理器复制文件落盘的是 CF_HDROP。Electron 44 的 clipboard 已重构成 W3C 风格
    // （只剩 clear/has/read/readText/write/writeText），没有写 CF_HDROP 的口子，
    // 所以这里必须借外部写入方——PowerShell 的 Set-Clipboard -Path。
    const setClipboard = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", `Set-Clipboard -Path '${samplePath.replace(/'/g, "''")}'`],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(
      setClipboard.status,
      0,
      `Set-Clipboard 失败（退出码 ${setClipboard.status}）：${setClipboard.stderr || setClipboard.error?.message || ""}`,
    );
    results.push("系统剪贴板写入 CF_HDROP（PowerShell Set-Clipboard -Path，与资源管理器 Ctrl+C 同格式）");

    // 换一个进程回读：既确认格式确实是文件拖放列表，也确认它没有随写入进程退出而失效
    // ——Clipboard.SetDataObject 的 flush 行为是外部实现细节，不该被当成假设写死。
    const readBack = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetFileDropList()"],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(readBack.status, 0, `回读剪贴板失败：${readBack.stderr || readBack.error?.message || ""}`);
    assert.equal(
      readBack.stdout.includes(SAMPLE_NAME),
      true,
      `剪贴板里应该是 ${SAMPLE_NAME}（回读得到 ${JSON.stringify(readBack.stdout.trim())}）`,
    );
    results.push("另一个进程回读 FileDropList 得到该文件（格式与存续性都成立）");
    writer = "powershell:CF_HDROP";
  } else {
    // macOS：file URL 格式，与 Finder ⌘C 落盘的 furl 一致（写入方是 Electron 而非
    // Finder 本身，这一步的差距已写在文件头的【平台】段）。
    // 注：evaluate 的函数体在 Playwright 注入的上下文里执行，那里没有 require——
    // 拿得到的是它作为第一个参数传进来的 electron 模块。
    const fileUrl = "file://" + samplePath;
    const written = await desktop.evaluate(async ({ clipboard, ClipboardItem }, url) => {
      await clipboard.write([new ClipboardItem({ "text/uri-list": url })]);
      return true;
    }, fileUrl).catch((error) => `写剪贴板失败: ${error.message}`);
    assert.equal(written, true, String(written));
    results.push("系统剪贴板写入文件 URL（text/uri-list，等价于 Finder ⌘C 的 furl）");

    // 再用一个独立进程查一眼系统粘贴板，确认写进去的不是「Electron 内部的一厢情愿」，
    // 而是真的落在系统剪贴板上、且是文件 URL（furl）flavor——实测 macOS 会把
    // text/uri-list 映射成 «class furl»，正是 Finder 复制文件所落的那一族 flavor。
    // 顺带排除一种假通过：若写入方进程退出后数据就没了，这里会立刻暴露。
    const board = spawnSync("osascript", ["-e", "clipboard info"], { encoding: "utf8", timeout: 15000 });
    assert.equal(board.status, 0, `读取系统粘贴板失败：${board.stderr || board.error?.message || ""}`);
    assert.equal(
      /furl/.test(board.stdout),
      true,
      `系统粘贴板上应存在 furl flavor（实际 ${JSON.stringify(board.stdout.trim())}）`,
    );
    results.push("另一个进程确认系统粘贴板上存在 furl（文件 URL）flavor");
    writer = "electron:text/uri-list";
  }

  await textarea.click();
  // 主路径与 macOS 一致：让渲染进程收到真实粘贴键。若该平台下 CDP 键事件没能触发
  // 编辑加速键，退到宿主窗口的 paste 命令——两条路径都仍然经过系统剪贴板，只是触发
  // 点不同，实际用了哪条会记进结果，不假装它们是一回事。
  pasteRoute = `键盘 ${PASTE_LABEL}`;
  await window.keyboard.press(PASTE_KEY);
  const appeared = await cards.first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  if (!appeared) {
    pasteRoute = "webContents.paste()（回退：CDP 键事件未触发编辑加速键）";
    await desktop.evaluate(({ BrowserWindow }) => {
      const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      target?.webContents.paste();
    });
    await cards.first().waitFor({ timeout: 15000 });
  }
  await window.waitForFunction(
    () => document.querySelector('ul[aria-label^="待发送附件"] li')?.dataset.status === "ready",
    null,
    { timeout: 20000 },
  );

  const cardTitle = await cards.first().locator("[title]").first().getAttribute("title");
  assert.equal(cardTitle, SAMPLE_NAME, "卡片上的文件名应与剪贴板里的文件一致");
  assert.deepEqual(uploads, [SAMPLE_NAME], "应恰好发起一次上传，且文件名正确");
  results.push(`粘贴生效（${pasteRoute}）：卡片出现、上传完成、文件名正确`);

  // Finder 复制文件会把文件名塞进 text/plain；Composer 认出了它并**不**当说明文字粘进来。
  assert.equal((await textarea.inputValue()).trim(), "", "文件名不应被当成说明文字留在输入框里");
  results.push("文件名未被误当作说明文字写入输入框");

  passed = true;
  console.log("原生剪贴板验收通过：\n" + results.map((line) => "  ✓ " + line).join("\n"));
} catch (error) {
  errors.push(error.message);
  console.error("原生剪贴板验收失败：", error.message);
} finally {
  if (desktop) await desktop.close().catch(() => {});
  writeFileSync(
    join(reportDir, "report.json"),
    JSON.stringify({ passed, platform: process.platform, base: BASE, writer, pasteRoute, sample: samplePath, uploads, results, errors }, null, 2),
  );
  console.log(`报告与样本保留在 ${root}`);
}

if (!passed) process.exit(1);
