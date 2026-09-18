import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const output = process.env.LECTERN_UI_OUTPUT || "test-results/message-search";
mkdirSync(output, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__streams = [];
    window.EventSource = class { constructor(url) { this.url = url; window.__streams.push(this); } close() { this.closed = true; } };
  });
  const message = n => ({ info: { id: `m-${n}`, role: "assistant" }, messageSeq: n, parts: [{ id: `p-${n}`, messageId: `m-${n}`, sessionId: "a", type: "text", text: `Searchable message ${n}` }] });
  const windowPage = messages => ({ messages, beforeCursor: "before", afterCursor: "after", hasMoreBefore: true, hasMoreAfter: true, historyRevision: 1, snapshotSeq: 0 });
  let failSearch = false;
  let delayed;
  let contextCount = 0;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/sessions") return route.fulfill({ json: [{ id: "a", title: "Search acceptance", agent: "default", model: { providerId: "test", modelId: "test" }, time: { created: "2026-09-08T00:00:00Z" } }] });
    if (path === "/api/sessions/a/search") {
      if (url.searchParams.get("q") === "delayed") { delayed = route; return; }
      if (failSearch) return route.fulfill({ status: 503, json: { error: "Injected search failure" } });
      return route.fulfill({ json: { results: [1, 5000, 10000].map(n => ({ projectId: "test", sessionId: "a", messageId: `m-${n}`, partId: `p-${n}`, messageSeq: n, kind: "text", snippet: `Searchable message ${n}`, match: { start: 0, length: 10 } })), nextCursor: null } });
    }
    if (path === "/api/sessions/a/messages") {
      const around = url.searchParams.get("around");
      if (around) { contextCount++; return route.fulfill({ json: windowPage([message(Number(around.slice(2)))]) }); }
      if (url.searchParams.has("after")) return route.fulfill({ json: { ...windowPage([message(10000)]), afterCursor: null, hasMoreAfter: false } });
      return route.fulfill({ json: { ...windowPage(Array.from({ length: 50 }, (_, i) => message(9951 + i))), beforeCursor: null, hasMoreBefore: false } });
    }
    if (path.endsWith("/worktree")) return route.fulfill({ json: { enabled: false } });
    if (path === "/api/auth/status") return route.fulfill({ json: { loggedIn: true, user: { name: "Search Test" } } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], authenticated: true } });
    if (path === "/api/skills") return route.fulfill({ json: { skills: [] } });
    if (path === "/api/settings/permissions") return route.fulfill({ json: { permissions: {} } });
    if (path === "/api/projects") return route.fulfill({ json: { projects: [], activeId: "default" } });
    return route.fulfill({ json: {} });
  });
  await page.goto(process.env.LECTERN_TEST_URL || "http://127.0.0.1:3104", { waitUntil: "domcontentloaded" });
  await page.getByText("Search acceptance", { exact: true }).click();
  await page.getByText("Searchable message 9951", { exact: true }).waitFor().catch(async (error) => {
    await page.screenshot({ path: `${output}/load-failure.png`, animations: "disabled" });
    const body = await page.locator("body").innerText().catch(() => "");
    throw new Error(`${error.message}\n${body.slice(0, 3000)}`);
  });
  await page.locator(".messages").evaluate(el => { el.scrollTop = 100; el.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await page.waitForTimeout(300);
  const scrollTop = await page.locator(".messages").evaluate(el => el.scrollTop);
  await page.evaluate(() => {
    const stream = window.__streams.at(-1);
    stream.onmessage({ data: JSON.stringify({ sessionId: "a", seq: 1, type: "permission.asked", data: { request: { id: "approval", permission: "bash", patterns: ["npm test"], always: [], sessionId: "a" } } }) });
  });
  await page.getByRole("button", { name: "回到最新消息", exact: true }).waitFor();
  await page.waitForTimeout(200);
  const position = await page.locator(".messages").evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
  assert.ok(Math.abs(position.top - scrollTop) < 10, JSON.stringify({ before: scrollTop, after: position }));
  await page.getByRole("button", { name: "搜索当前会话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "搜索当前会话" });
  const input = dialog.getByRole("textbox", { name: "搜索当前会话" });
  await input.fill("searchable");
  for (const n of [1, 5000, 10000]) {
    await dialog.getByRole("button", { name: `Searchable message ${n}`, exact: true }).click();
    await dialog.locator(`article[data-message-id="m-${n}"]`).waitFor();
  }
  assert.equal(contextCount, 3);
  // setViewportSize 触发的是异步重排，紧接着量尺寸可能拿到重排前的中间盒。CI 上第一次
  // 跑就因此判过一次假失败（本机不复现）。这里等到连续两次测量一致再断言：不掩盖真实
  // 布局问题，也不再依赖「量的时候恰好已经稳定」这个假设。断言消息带上实测盒，便于定位。
  const settledBox = async locator => {
    let previous = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const box = await locator.boundingBox();
      if (box && previous && Math.abs(box.width - previous.width) < 0.5 && Math.abs(box.x - previous.x) < 0.5 && Math.abs(box.height - previous.height) < 0.5) return box;
      previous = box;
      await page.waitForTimeout(50);
    }
    return previous;
  };
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    const rect = await settledBox(input);
    assert.ok(
      rect && rect.width > 60 && rect.x >= 0 && rect.x + rect.width <= width,
      `搜索输入框必须完整落在 ${width}px 视口内：${JSON.stringify({ rect, width })}`,
    );
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${output}/search-${width}.png`, animations: "disabled" });
  }
  await input.fill("delayed");
  await page.waitForTimeout(350);
  assert.ok(delayed);
  await input.fill("replacement");
  await dialog.getByRole("button", { name: "Searchable message 1", exact: true }).waitFor();
  await delayed.fulfill({ json: { results: [{ messageId: "late", partId: "late", kind: "text", snippet: "STALE RESULT", match: { start: 0, length: 5 } }], nextCursor: null } }).catch(() => {});
  assert.equal(await dialog.getByText("STALE RESULT").count(), 0);
  failSearch = true;
  await input.fill("failure");
  await dialog.getByText("Injected search failure", { exact: false }).waitFor();
  failSearch = false;
  await dialog.getByRole("button", { name: "重试", exact: true }).click();
  await dialog.getByRole("button", { name: "Searchable message 1", exact: true }).waitFor();
  await input.press("Escape");
  assert.equal(await dialog.count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: first/middle/last search navigation, stale response, retry, focus, permission scroll anchor, desktop/mobile; no page errors");
} finally { await browser.close(); }
