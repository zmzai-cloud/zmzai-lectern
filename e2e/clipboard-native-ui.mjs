import assert from "node:assert/strict";
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
 * 【平台】只覆盖 macOS。Windows Explorer 的剪贴板格式（CF_HDROP）在这一层没有实现，
 * 不得据此声称跨平台已验证。
 */

const BASE = process.env.LECTERN_TEST_URL || "http://127.0.0.1:3100";
const reportDir = resolve(process.env.LECTERN_UI_OUTPUT || "test-results/clipboard-native");
const SES = "ses_clipboard";
const SESSION_TITLE = "剪贴板验收";

if (process.platform !== "darwin") {
  console.log(`[skip] 原生剪贴板验收只在 macOS 上实现（当前平台 ${process.platform}）。`);
  console.log("[skip] Windows Explorer 一侧仍未验证，不得据此声称跨平台覆盖。");
  process.exit(0);
}

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
  await window.getByText(SESSION_TITLE, { exact: true }).click({ timeout: 30000 });
  await window.locator(".chat-composer").waitFor({ timeout: 30000 });
  const textarea = window.locator('textarea[aria-label="消息"]');
  const cards = window.locator('ul[aria-label^="待发送附件"] > li');
  assert.equal(await cards.count(), 0, "开始前不应有附件卡片");

  // 把文件放进**系统剪贴板**：file URL 格式，与 Finder ⌘C 落盘的类型一致。
  // 注：evaluate 的函数体在 Playwright 注入的上下文里执行，那里没有 require——
  // 拿得到的是它作为第一个参数传进来的 electron 模块。
  const fileUrl = "file://" + samplePath;
  const written = await desktop.evaluate(async ({ clipboard, ClipboardItem }, url) => {
    await clipboard.write([new ClipboardItem({ "text/uri-list": url })]);
    return true;
  }, fileUrl).catch((error) => `写剪贴板失败: ${error.message}`);
  assert.equal(written, true, String(written));
  results.push("系统剪贴板写入文件 URL（text/uri-list，等价于 Finder ⌘C 的 furl）");

  await textarea.click();
  await window.keyboard.press("Meta+V");
  await cards.first().waitFor({ timeout: 15000 });
  await window.waitForFunction(
    () => document.querySelector('ul[aria-label^="待发送附件"] li')?.dataset.status === "ready",
    null,
    { timeout: 20000 },
  );

  const cardTitle = await cards.first().locator("[title]").first().getAttribute("title");
  assert.equal(cardTitle, SAMPLE_NAME, "卡片上的文件名应与剪贴板里的文件一致");
  assert.deepEqual(uploads, [SAMPLE_NAME], "应恰好发起一次上传，且文件名正确");
  results.push("⌘V 之后卡片出现、上传完成、文件名正确");

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
    JSON.stringify({ passed, platform: process.platform, base: BASE, sample: samplePath, uploads, results, errors }, null, 2),
  );
  console.log(`报告与样本保留在 ${root}`);
}

if (!passed) process.exit(1);
