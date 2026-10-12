import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

/**
 * UX 走查第二轮（web-gui-tester 方法论）：第一轮盖住了主流程，这一轮走
 * 没覆盖的交互面——新建会话、斜杠命令、@引用、命令面板、消息悬浮操作/
 * 编辑重发、底部终端、深色主题、会话管理菜单、长代码块。
 * 截图在 test-results/ux-walkthrough-2/，逐张视觉审。
 */

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
const output = process.env.LECTERN_UI_OUTPUT || "test-results/ux-walkthrough-2";
mkdirSync(output, { recursive: true });

const codeMsg = '好的，看这个例子：\n\n```ts\n// 长代码块渲染 + 悬停复制按钮\nexport function reconcileSnapshot<T>(prev: Snapshot<T>, next: Snapshot<T>): Patch<T>[] {\n  const patches: Patch<T>[] = [];\n  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);\n  for (const key of keys) {\n    const a = prev[key as keyof T];\n    const b = next[key as keyof T];\n    if (!Object.is(a, b)) patches.push({ key, prev: a, next: b });\n  }\n  return patches;\n}\n```\n\n这段逻辑每次快照对比都会跑，注意 `Object.is` 对 NaN 的语义。';

const pageSpecs = {
  done: {
    messages: [
      { info: { id: "u1", role: "user", sessionId: "done" }, messageSeq: 1, parts: [{ id: "u1-t", messageId: "u1", sessionId: "done", type: "text", text: "给我一个 TypeScript 的深比较例子" }] },
      { info: { id: "m2", role: "assistant", sessionId: "done" }, messageSeq: 2, parts: [{ id: "m2-t", messageId: "m2", sessionId: "done", type: "text", text: codeMsg }] },
    ],
    events: [],
  },
};

const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && consoleErrors.push(`console: ${m.text().slice(0, 160)}`));

await page.addInitScript(() => {
  localStorage.removeItem("lectern.task-layout");
  localStorage.removeItem("lectern:workbench-open");
  window.EventSource = class { close() {} };
});

await page.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  if (path === "/api/sessions" && route.request().method() === "POST")
    return route.fulfill({ json: { id: "new-x", title: "新会话", agent: "default", model: { providerId: "openai", modelId: "glm-5.3" }, time: { created: "2026-10-11T09:00:00Z" } } });
  if (path === "/api/sessions")
    return route.fulfill({ json: [
      { id: "done", title: "深比较例子", agent: "default", model: { providerId: "openai", modelId: "glm-5.3" }, time: { created: "2026-10-11T08:00:00Z" }, pinned: true },
      { id: "old", title: "旧会话", agent: "default", model: { providerId: "openai", modelId: "glm-5.3" }, time: { created: "2026-10-10T08:00:00Z" }, archived: true },
    ] });
  if (path === "/api/sessions/done/messages")
    return route.fulfill({ json: { messages: pageSpecs.done.messages, beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 3, task: null, stateEvents: [] } });
  if (path === "/api/sessions/old/messages")
    return route.fulfill({ json: { messages: [], beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0, task: null, stateEvents: [] } });
  if (path === "/api/sessions/new-x/messages")
    return route.fulfill({ json: { messages: [], beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0, task: null, stateEvents: [] } });
  if (path === "/api/fs/tree") {
    const p = url.searchParams.get("path") ?? "";
    return route.fulfill({ json: { nodes: p === ""
      ? [{ name: "components", type: "dir" }, { name: "lib", type: "dir" }, { name: "package.json", type: "file" }, { name: "README.md", type: "file" }]
      : [{ name: "ChatView.tsx", type: "file" }, { name: "Composer.tsx", type: "file" }, { name: "client.ts", type: "file" }] } });
  }
  if (path === "/api/fs/file") return route.fulfill({ json: { path: url.searchParams.get("path") ?? "", size: 24, content: "export const answer = 42;\n", binary: false, mediaType: "text/plain" } });
  if (path.endsWith("/prompt")) return route.fulfill({ json: { userMessageId: "um-1", requestId: "r1" } });
  if (path.endsWith("/worktree")) return route.fulfill({ json: { enabled: false } });
  if (path === "/api/auth/status") return route.fulfill({ json: { loggedIn: true, user: { name: "走查二" } } });
  if (path === "/api/models") return route.fulfill({ json: { models: [{ providerId: "openai", modelId: "glm-5.3", displayName: "GLM-5.3" }], authenticated: true } });
  if (path === "/api/skills") return route.fulfill({ json: { skills: [] } });
  if (path === "/api/settings/permissions") return route.fulfill({ json: { permissions: {} } });
  if (path === "/api/projects") return route.fulfill({ json: { projects: [], activeId: "default" } });
  return route.fulfill({ json: {} });
});

const shot = (name) => page.screenshot({ path: `${output}/${name}.png` });
const step = async (name, fn) => {
  await fn();
  await page.waitForTimeout(500);
  await shot(name);
  console.log(`📸 ${name}`);
};

await page.goto(process.env.LECTERN_TEST_URL || "http://127.0.0.1:3100", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);

// ① 新建会话入口与空态
await step("01-new-session", () => page.locator('.task-sidebar button[title*="新建会话"]').click());
await step("02-slash-type", async () => {
  const ta = page.locator("textarea").first();
  ta.click();
  ta.fill("/");
});
await step("03-at-type", async () => {
  const ta = page.locator("textarea").first();
  ta.fill("看一下 @");
});
await step("04-at-navigate", async () => {
  const ta = page.locator("textarea").first();
  ta.fill("看一下 @comp");
});
// ⑤ 命令面板
await step("05-palette", () => page.keyboard.press("Meta+k"));
// ⑥ 消息悬浮操作 + 编辑重发
await step("06-open-done", () => page.getByText("深比较例子", { exact: true }).first().click());
await step("07-code-block-hover", () => page.locator("pre").first().hover());
await step("08-edit-resend", async () => {
  await page.locator(".chat-user-message").first().hover();
});
await step("09-edit-clicked", async () => {
  const btn = page.locator('button[title*="编辑重发"]');
  if (await btn.count()) await btn.first().click();
});
// ⑩ 底部终端面板
await step("10-bottom-panel", () => page.getByRole("button", { name: "展开底部面板", exact: true }).click());
// ⑪ 会话管理菜单（置顶会话的悬浮菜单）
await step("11-session-menu", async () => {
  const item = page.locator(".task-sidebar").getByText("深比较例子", { exact: false }).first();
  await item.hover();
  const menuBtn = page.locator('.task-sidebar button[title*="更多"], .task-sidebar button[aria-label*="更多"]');
  if (await menuBtn.count()) await menuBtn.first().click();
});
// ⑫ 深色主题（重开页面走 localStorage）
await step("12-dark-theme", async () => {
  await page.evaluate(() => localStorage.setItem("zmzai-theme", "dark"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.getByText("深比较例子", { exact: true }).first().click();
});

console.log("\nconsole/page errors:", consoleErrors.length ? consoleErrors : "无");
await browser.close();
