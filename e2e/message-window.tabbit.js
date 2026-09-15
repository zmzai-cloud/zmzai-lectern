// Submit via tabbit-cli nodejs --task lectern-m12 --request-id setup < this file.
// Only mock APIs; never calls a model or accesses the user's sessions.
globalThis.fixture = { total: 10000, reads: 0, lastRead: 0, requests: [], errors: [] };
const fixture = globalThis.fixture;
await page.setViewportSize({ width: 1440, height: 900 });
page.on("pageerror", error => fixture.errors.push(error.message));
await page.addInitScript(() => {
  window.__streams = [];
  window.EventSource = class { constructor(url) { this.url = url; window.__streams.push(this); } close() { this.closed = true; } };
});
await page.route("**/*", async route => {
  const url = new URL(route.request().url());
  if (url.hostname !== "127.0.0.1") return route.abort();
  if (!url.pathname.startsWith("/api/")) return route.continue();
  const path = url.pathname;
  const readState = () => ({ lastReadMessageSeq: fixture.lastRead, latestMessageSeq: fixture.total, unreadCount: Math.max(0, Math.floor((fixture.total - fixture.lastRead)/2)), historyRevision: 1 });
  if (path === "/api/sessions") return route.fulfill({ json: [{ id: "window", title: "Long history", agent: "default", model: { providerId: "test", modelId: "test" }, time: { created: "2026-09-10T00:00:00Z" }, readState: readState() }] });
  if (path.endsWith("/read-state")) {
    if (route.request().method() === "PUT") { fixture.reads++; fixture.lastRead = Math.max(fixture.lastRead, route.request().postDataJSON().lastReadMessageSeq); }
    return route.fulfill({ json: readState() });
  }
  if (path.endsWith("/messages")) {
    fixture.requests.push(url.search);
    const decode = key => { const value = url.searchParams.get(key); return value ? JSON.parse(Buffer.from(value, "base64url").toString()).messageSeq : null; };
    const before = decode("before"); const after = decode("after");
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const end = before !== null ? before - 1 : after !== null ? Math.min(fixture.total, after + limit) : fixture.total;
    const start = Math.max(1, end - limit + 1);
    const cursor = n => Buffer.from(JSON.stringify({ sessionId: "window", messageSeq: n, historyRevision: 1 })).toString("base64url");
    const messages = Array.from({ length: end-start+1 }, (_, i) => {
      const n = start+i;
      const parts = [{ id: `p${n}`, type: "text", text: `Message ${n}\n\n${"Body with variable height. ".repeat(n % 5 + 1)}`, messageId: `m${n}`, sessionId: "window" }];
      if (n % 7 === 0) parts.push({ id: `f${n}`, type: "file", filename: `note-${n}.txt`, mime: "text/plain", url: "data:text/plain;base64,aGVsbG8=", messageId: `m${n}`, sessionId: "window" });
      if (n % 11 === 0) parts.push({ id: `t${n}`, type: "tool", tool: "read", callId: `call${n}`, state: { status: "completed", input: { path: "note.txt" }, output: "result", title: "Read note.txt", time: { start: "now", end: "now" } }, messageId: `m${n}`, sessionId: "window" });
      return { info: { id: `m${n}`, role: n % 2 ? "user" : "assistant" }, messageSeq: n, parts };
    });
    return route.fulfill({ json: { messages, beforeCursor: start>1 ? cursor(start) : null, afterCursor: end<fixture.total ? cursor(end) : null, hasMoreBefore: start>1, hasMoreAfter: end<fixture.total, historyRevision: 1, snapshotSeq: 0, readState: readState() } });
  }
  if (path.endsWith("/worktree")) return route.fulfill({ json: { enabled: false } });
  if (path === "/api/auth/status") return route.fulfill({ json: { loggedIn: true, user: { name: "Window Test" } } });
  if (path === "/api/models") return route.fulfill({ json: { models: [], authenticated: true } });
  if (path === "/api/skills") return route.fulfill({ json: { skills: [] } });
  if (path === "/api/settings/permissions") return route.fulfill({ json: { permissions: {} } });
  if (path === "/api/projects") return route.fulfill({ json: { projects: [], activeId: "default" } });
  return route.fulfill({ json: {} });
});
await page.goto("http://127.0.0.1:3105", { waitUntil: "domcontentloaded", timeout: 120000 });
// Hide the browser's translation overlay in this test document only.
await page.addStyleTag({ content: "read-frog { display: none !important; }" });
await page.getByText("Long history", { exact: true }).click();
await page.locator('[data-message-id="m10000"]').waitFor();
const initialCached = Number(await page.locator(".messages").getAttribute("data-cached-messages"));
assert.equal(initialCached, 50);
const counts = [];
for (let i = 0; i < 12; i++) {
  const prior = fixture.requests.length;
  await page.locator(".messages").evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await expect.poll(() => fixture.requests.length).toBeGreaterThan(prior);
  await page.getByText("正在加载更早消息…", { exact: true }).waitFor({ state: "hidden" });
  await page.waitForTimeout(100);
  counts.push({ cached: Number(await page.locator(".messages").getAttribute("data-cached-messages")), rows: await page.locator("[data-virtual-message]").count() });
}
assert(counts.every(value => value.cached <= 400 && value.rows <= 100));
assert.equal(counts.at(-1).cached, 400);
const readsBefore = fixture.reads;
await page.waitForTimeout(1100);
assert.equal(fixture.reads, readsBefore);
await page.getByRole("button", { name: "加载更新消息", exact: true }).click();
await expect.poll(() => fixture.requests.at(-1)).toContain("after=");
await page.getByRole("button", { name: "回到最新消息", exact: true }).click();
await page.locator('[data-message-id="m10000"]').waitFor();
await expect.poll(async () => Number(await page.locator(".messages").getAttribute("data-cached-messages"))).toBe(50);
// Deterministic focus/visibility fault injection without stealing the user's OS focus.
await page.evaluate(() => {
  window.__testFocused = false; window.__testVisible = false;
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => window.__testFocused });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__testVisible ? "visible" : "hidden" });
  window.dispatchEvent(new Event("blur")); document.dispatchEvent(new Event("visibilitychange"));
});
fixture.lastRead = 0;
const hiddenReads = fixture.reads;
await page.waitForTimeout(1200);
assert.equal(fixture.reads, hiddenReads);
await page.evaluate(() => { window.__testVisible = true; document.dispatchEvent(new Event("visibilitychange")); });
await page.waitForTimeout(700);
assert.equal(fixture.reads, hiddenReads);
await page.evaluate(() => { window.__testFocused = true; window.dispatchEvent(new Event("focus")); });
await page.waitForTimeout(250);
assert.equal(fixture.reads, hiddenReads);
await expect.poll(() => fixture.lastRead).toBe(10000);
await page.locator(".messages").evaluate(el => { el.scrollTop = 250; el.dispatchEvent(new Event("scroll", { bubbles: true })); });
await page.waitForTimeout(100);
fixture.total = 10100;
await page.evaluate(() => {
  const stream = window.__streams.filter(stream => !stream.closed).at(-1);
  let seq = 0;
  for (let n = 10001; n <= 10100; n++) {
    stream.onmessage({ data: JSON.stringify({ sessionId: "window", seq: ++seq, type: "message.updated", data: { message: { id: `m${n}`, role: "assistant", messageSeq: n } } }) });
    stream.onmessage({ data: JSON.stringify({ sessionId: "window", seq: ++seq, type: "message.part.updated", data: { part: { id: `p${n}`, messageId: `m${n}`, sessionId: "window", type: "text", text: `Concurrent ${n}` } } }) });
  }
});
await page.waitForTimeout(1000);
assert.equal(fixture.lastRead, 10000);
assert.equal(Number(await page.locator(".messages").getAttribute("data-cached-messages")), 50);
await page.getByRole("button", { name: "回到最新消息", exact: true }).click();
await page.locator('[data-message-id="m10100"]').waitFor();
await expect.poll(() => fixture.lastRead).toBe(10100);
const desktop = await page.screenshot({ fullPage: false });
await page.setViewportSize({ width: 390, height: 844 });
await page.getByRole("button", { name: "收起会话栏", exact: true }).press("Enter");
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
const mobile = await page.screenshot({ fullPage: false });
assert.deepEqual(fixture.errors, []);
return { initialCached, counts, reads: fixture.reads, lastRead: fixture.lastRead, errors: fixture.errors, desktop, mobile };
