import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
const output = process.env.LECTERN_UI_OUTPUT || "test-results/workbench-resize";
mkdirSync(output, { recursive: true });

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("lectern:workbench-open", "1");
    localStorage.setItem("lectern:workbench-width", "384");
    window.EventSource = class { close() {} };
  });

  const longCopy = "右侧工作区变宽以后，这段会话内容必须跟随可用宽度重新换行，不能继续保持原来的排版宽度，也不能被右侧面板直接裁断。".repeat(5);
  const transcript = [
    {
      info: { id: "user-1", role: "user", sessionId: "resize" },
      messageSeq: 1,
      parts: [{ id: "user-text", messageId: "user-1", sessionId: "resize", type: "text", text: longCopy }],
    },
    {
      info: { id: "assistant-1", role: "assistant", sessionId: "resize" },
      messageSeq: 2,
      parts: [{ id: "assistant-text", messageId: "assistant-1", sessionId: "resize", type: "text", text: longCopy }],
    },
  ];

  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/sessions") return route.fulfill({ json: [{ id: "resize", title: "分栏收缩测试", agent: "default", model: { providerId: "test", modelId: "test" }, time: { created: "2026-09-17T00:00:00Z" } }] });
    if (path === "/api/sessions/resize/messages") return route.fulfill({ json: { messages: transcript, beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0 } });
    if (path.endsWith("/worktree")) return route.fulfill({ json: { enabled: false } });
    if (path === "/api/auth/status") return route.fulfill({ json: { loggedIn: true, user: { name: "Resize Test" } } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], authenticated: true } });
    if (path === "/api/skills") return route.fulfill({ json: { skills: [] } });
    if (path === "/api/settings/permissions") return route.fulfill({ json: { permissions: {} } });
    if (path === "/api/projects") return route.fulfill({ json: { projects: [], activeId: "default" } });
    return route.fulfill({ json: {} });
  });

  await page.goto(process.env.LECTERN_TEST_URL || "http://127.0.0.1:3100", { waitUntil: "domcontentloaded" });
  await page.getByText("分栏收缩测试", { exact: true }).click();
  await page.locator(".chat-assistant-message").waitFor().catch(async error => {
    await page.screenshot({ path: `${output}/load-failure.png`, animations: "disabled" });
    const body = await page.locator("body").innerText().catch(() => "");
    throw new Error(`${error.message}\n${body.slice(0, 2000)}`);
  });

  const splitter = page.getByRole("separator", { name: "调整右侧工作区宽度" });
  const beforeChat = await page.locator(".chat-view").boundingBox();
  const handle = await splitter.boundingBox();
  assert.ok(beforeChat && handle, "chat and workbench splitter must be visible");
  await page.screenshot({ path: `${output}/before.png`, animations: "disabled" });
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 300, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();

  const afterChat = await page.locator(".chat-view").boundingBox();
  assert.ok(afterChat && afterChat.width < beforeChat.width - 200, JSON.stringify({ beforeChat, afterChat }));
  const overflow = await page.locator(".chat-view").evaluate(root => {
    const boundary = root.getBoundingClientRect().right;
    return [...root.querySelectorAll(".chat-assistant-message, .chat-user-bubble")].map(element => {
      const rect = element.getBoundingClientRect();
      return { right: rect.right, boundary, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
  });
  for (const item of overflow) {
    assert.ok(item.right <= item.boundary + 1, JSON.stringify(item));
    assert.ok(item.scrollWidth <= item.clientWidth + 1, JSON.stringify(item));
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${output}/after.png`, animations: "disabled" });
  console.log("PASS: workbench drag shrinks chat; user and assistant messages wrap without clipping");
} finally {
  await browser.close();
}
