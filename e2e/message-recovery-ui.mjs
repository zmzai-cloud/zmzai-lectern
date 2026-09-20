import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

// Transport fault injection only; no model calls, user sessions, or file writes via API.
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
const output = process.env.LECTERN_UI_OUTPUT || "test-results/message-recovery";
mkdirSync(output, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__streams = [];
    window.EventSource = class {
      constructor(url) { this.url = url; window.__streams.push(this); }
      close() { this.closed = true; }
    };
  });
  const session = id => ({ id, title: `recovery-${id}`, agent: "default", model: { providerId: "openai", modelId: "test" }, time: { created: "2026-09-08T00:00:00Z" } });
  const message = (sid, id, text) => ({ info: { id, role: "assistant", sessionId: sid }, parts: [{ id: `${id}-text`, messageId: id, sessionId: sid, type: "text", text }] });
  const tail = Array.from({ length: 50 }, (_, i) => message("a", `a-${i}`, `A history ${i}`));
  let initialFails = true;
  let olderFails = true;
  let olderPending;
  let markOlderPending;
  const olderStarted = new Promise(resolve => { markOlderPending = resolve; });
  let initialCount = 0;
  let olderCount = 0;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/sessions") return route.fulfill({ json: [session("a"), session("b")] });
    if (path === "/api/sessions/a/messages") {
      if (!url.searchParams.has("before")) {
        initialCount++;
        return route.fulfill(initialFails ? { status: 503, json: { error: "Injected history outage" } } : { json: { messages: tail, beforeCursor: "older", hasMoreBefore: true, historyRevision: 1, snapshotSeq: 0 } });
      }
      olderCount++;
      if (olderFails) return route.fulfill({ status: 503, json: { error: "Injected older outage" } });
      olderPending = route;
      markOlderPending();
      return;
    }
    if (path === "/api/sessions/b/messages") return route.fulfill({ json: { messages: [message("b", "b-1", "B current history")], beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0 } });
    if (path.endsWith("/worktree")) return route.fulfill({ json: { enabled: false } });
    if (path === "/api/auth/status") return route.fulfill({ json: { loggedIn: true, user: { name: "Recovery Test" } } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], authenticated: true } });
    if (path === "/api/skills") return route.fulfill({ json: { skills: [] } });
    if (path === "/api/settings/permissions") return route.fulfill({ json: { permissions: {} } });
    if (path === "/api/projects") return route.fulfill({ json: { projects: [], activeId: "default" } });
    return route.fulfill({ json: {} });
  });
  await page.goto(process.env.LECTERN_TEST_URL || "http://127.0.0.1:3102", { waitUntil: "domcontentloaded" });
  await page.getByText("recovery-a", { exact: true }).click();
  await page.getByText("历史消息加载失败", { exact: true }).waitFor();
  assert.equal(await page.getByText("今天想完成什么？", { exact: true }).count(), 0);
  const retry = page.getByRole("button", { name: "重试加载历史消息", exact: true });
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
    await page.setViewportSize({ width, height });
    if (width === 390) {
      // 单视图断点（规格 §7）：侧栏是**默认关闭**的覆盖层，会话才是唯一可见视图。
      // 开合一次，证明覆盖层不会改变会话里重试入口的位置与可用性。
      await page.getByRole("button", { name: "展开会话栏", exact: true }).click();
      await page.locator(".panel-overlay-left").waitFor();
      await page.getByRole("button", { name: "收起会话栏", exact: true }).click();
      await page.locator(".panel-overlay-left").waitFor({ state: "detached" });
    }
    assert.equal(await retry.isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const rect = await retry.boundingBox();
    assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width && rect.y >= 0 && rect.y + rect.height <= height);
    await page.screenshot({ path: `${output}/initial-error-${width}.png`, animations: "disabled" });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // 桌面宽度下侧栏默认常驻（规格 §7）：只有它被收起时才需要展开，展开后侧栏方可点选任务。
  //
  // 这里**不能**用 count() 决定要不要点。count() 数的是「在不在 DOM」，而从 390 切回 1440 时，
  // 「宽屏自动常驻」与「刚刚在窄屏手动收起」这两种状态之间有一个人眼不可见、机器能撞上的
  // 时间窗：按钮可能已经在 DOM 里、却还没进入可点状态。那时 count() 返回 1，紧跟的 click()
  // 就一头撞进 30s 超时（2026-09-20 CI 实测，本机 4 次全过，属环境时序差）。
  // 改为看**侧栏本身**的可见性：已经开着就不碰它，确实收起才去点。
  const sidebar = page.locator(".task-sidebar");
  const expandSidebar = page.getByRole("button", { name: "展开会话栏", exact: true });
  if (!(await sidebar.isVisible()) && (await expandSidebar.isVisible())) await expandSidebar.click();
  await sidebar.waitFor();
  initialFails = false;
  await retry.click();
  await page.getByText("A history 49", { exact: true }).waitFor();
  assert.equal(initialCount, 2);
  await page.locator(".messages").evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await page.getByText("更早消息加载失败", { exact: true }).waitFor();
  const attempts = olderCount;
  await page.locator(".messages").evaluate(el => el.dispatchEvent(new Event("scroll", { bubbles: true })));
  await page.screenshot({ path: `${output}/older-error.png`, animations: "disabled" });
  assert.equal(olderCount, attempts);
  assert.equal(await page.getByText("A history 0", { exact: true }).count(), 1);
  olderFails = false;
  await retry.click();
  await page.getByText("正在加载更早消息…", { exact: true }).waitFor();
  await Promise.race([olderStarted, new Promise((_, reject) => setTimeout(() => reject(new Error("Older request not started")), 5000))]);
  await page.getByText("recovery-b", { exact: true }).click();
  await page.getByText("B current history", { exact: true }).waitFor();
  await olderPending.fulfill({ json: { messages: [message("a", "a-late", "A late history")], beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0 } }).catch(() => {});
  await page.evaluate(() => {
    const stream = window.__streams.at(-1);
    const frame = (seq, type, data) => stream.onmessage({ data: JSON.stringify({ sessionId: "b", seq, type, data }) });
    frame(1, "message.updated", { message: { id: "live", role: "assistant" } });
    frame(2, "message.part.delta", { messageId: "live", partId: "live-text", delta: "Unique live text" });
    frame(2, "message.part.delta", { messageId: "live", partId: "live-text", delta: "Unique live text" });
  });
  await page.getByText("Unique live text", { exact: true }).waitFor();
  assert.equal(await page.getByText("A late history", { exact: true }).count(), 0);
  assert.equal(await page.getByText("A history 0", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${output}/recovered.png`, animations: "disabled" });
  console.log("PASS: initial retry, older retry, session switch, duplicate delta, 3 responsive viewports; no page errors");
} finally {
  await browser.close();
}
