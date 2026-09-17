import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
const output = process.env.LECTERN_UI_OUTPUT || "test-results/conversation-first";
mkdirSync(output, { recursive: true });

const longCopy = "会话是 Lectern 的主要工作区域。右侧工作台打开后，这段内容仍需保持自然换行、完整可读，并且不能产生页面级横向滚动。".repeat(4);
const transcript = [
  {
    info: { id: "user-1", role: "user", sessionId: "conversation" },
    messageSeq: 1,
    parts: [{ id: "user-text", messageId: "user-1", sessionId: "conversation", type: "text", text: longCopy }],
  },
  {
    info: { id: "assistant-1", role: "assistant", sessionId: "conversation" },
    messageSeq: 2,
    parts: [{ id: "assistant-text", messageId: "assistant-1", sessionId: "conversation", type: "text", text: `${longCopy}\n\n下一步可以按需打开成果或审查。` }],
  },
];

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.removeItem("lectern:task-layout:conversation");
    window.EventSource = class { close() {} };
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/sessions") return route.fulfill({ json: [{ id: "conversation", title: "对话优先验收", agent: "default", model: { providerId: "openai", modelId: "gpt-test" }, time: { created: "2026-09-17T00:00:00Z" } }] });
    if (path === "/api/sessions/conversation/messages") return route.fulfill({ json: { messages: transcript, beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0 } });
    if (path.endsWith("/worktree")) return route.fulfill({ json: { enabled: false } });
    if (path === "/api/auth/status") return route.fulfill({ json: { loggedIn: true, user: { name: "Visual QA" } } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], authenticated: true } });
    if (path === "/api/skills") return route.fulfill({ json: { skills: [] } });
    if (path === "/api/settings/permissions") return route.fulfill({ json: { permissions: {} } });
    if (path === "/api/projects") return route.fulfill({ json: { projects: [], activeId: "default" } });
    return route.fulfill({ json: {} });
  });

  await page.goto(process.env.LECTERN_TEST_URL || "http://127.0.0.1:3100", { waitUntil: "domcontentloaded" });
  await page.getByText("对话优先验收", { exact: true }).click();
  await page.locator(".chat-assistant-message").waitFor();

  assert.equal(await page.locator(".workbench-shell").count(), 0, "workbench defaults closed");
  assert.equal(await page.locator('[data-task-primary-status="true"]').count(), 1, "one primary task status");
  assert.equal(await page.getByRole("button", { name: "运行配置" }).count(), 1, "runtime controls are consolidated");

  for (const [width, height] of [[1600, 900], [1440, 900], [1180, 900]]) {
    await page.setViewportSize({ width, height });
    const workbenchButton = page.getByRole("button", { name: /右侧工作区/ });
    if (await page.locator(".workbench-shell").count() === 0) await workbenchButton.click();
    await page.locator(".workbench-shell").waitFor();
    const chat = await page.locator(".chat-view").boundingBox();
    assert.ok(chat && chat.width >= 480, JSON.stringify({ width, chat }));
    assert.equal(await page.locator(".panel-overlay-right").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${output}/desktop-${width}.png`, animations: "disabled" });
  }

  for (const [width, height] of [[1179, 900], [960, 800], [768, 900], [767, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.locator(".panel-overlay-right").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (width < 768) {
      const overlay = await page.locator(".panel-overlay-right").boundingBox();
      assert.ok(overlay && Math.abs(overlay.width - width) <= 1, JSON.stringify({ width, overlay }));
    }
    await page.getByRole("button", { name: "展开会话栏" }).click();
    await page.locator(".panel-overlay-left").waitFor();
    assert.equal(await page.locator(".panel-overlay-right").count(), 0, "compact overlays are mutually exclusive");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${output}/compact-${width}.png`, animations: "disabled" });
    await page.locator(".panel-scrim").click({ position: { x: width - 2, y: 10 } }).catch(() => page.keyboard.press("Escape"));
    await page.getByRole("button", { name: "展开右侧工作区" }).click();
  }

  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: `${output}/dark-390.png`, animations: "disabled" });
  assert.deepEqual(errors, []);
  console.log("PASS: conversation-first hierarchy, task status, consolidated config, desktop sizing, compact overlays, and overflow");
} finally {
  await browser.close();
}
