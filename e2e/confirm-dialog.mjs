import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

/** 自绘删除确认框验收：替代原生 window.confirm（0.13.0）。 */
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
const output = process.env.LECTERN_UI_OUTPUT || "test-results/confirm-dialog";
mkdirSync(output, { recursive: true });

const sessions = [
  { id: "a", title: "被删会话", agent: "default", model: { providerId: "openai", modelId: "glm-5.3" }, time: { created: "2026-10-11T08:00:00Z" } },
  { id: "b", title: "幸存会话", agent: "default", model: { providerId: "openai", modelId: "glm-5.3" }, time: { created: "2026-10-11T08:01:00Z" } },
];
let deleted = [];

const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(() => {
  localStorage.removeItem("lectern.task-layout");
  window.EventSource = class { close() {} };
});
await page.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  const method = route.request().method();
  if (path === "/api/sessions" && method === "GET") return route.fulfill({ json: sessions });
  if (/^\/api\/sessions\/[^/]+$/.test(path) && method === "DELETE") {
    deleted.push(path.split("/")[3]);
    sessions.splice(sessions.findIndex((s) => s.id === path.split("/")[3]), 1);
    return route.fulfill({ json: { ok: true } });
  }
  if (/^\/api\/sessions\/[^/]+\/messages$/.test(path)) return route.fulfill({ json: { messages: [], beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0, task: null, stateEvents: [] } });
  if (path.endsWith("/worktree")) return route.fulfill({ json: { enabled: false } });
  if (path === "/api/auth/status") return route.fulfill({ json: { loggedIn: true, user: { name: "QA" } } });
  if (path === "/api/models") return route.fulfill({ json: { models: [], authenticated: true } });
  if (path === "/api/skills") return route.fulfill({ json: { skills: [] } });
  if (path === "/api/settings/permissions") return route.fulfill({ json: { permissions: {} } });
  if (path === "/api/projects") return route.fulfill({ json: { projects: [], activeId: "default" } });
  return route.fulfill({ json: {} });
});

try {
  await page.goto(process.env.LECTERN_TEST_URL || "http://127.0.0.1:3100", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  const item = page.locator(".task-sidebar").getByText("被删会话", { exact: true });
  await item.hover();
  await page.locator('.task-sidebar .task-row-menu summary').first().click();

  // ① 危险态自绘确认框弹出（不是原生 confirm——原生会阻塞，playwright 下 dialog 事件可验）
  const nativeDialogs = [];
  page.on("dialog", (d) => { nativeDialogs.push(d.type); d.dismiss().catch(() => {}); });
  await page.locator('button[title="删除会话"]').first().click();
  const dlg = page.getByText("删除会话「被删会话」？", { exact: false });
  await dlg.waitFor({ timeout: 5000 });
  await page.getByText("消息记录将一并删除，不可恢复。", { exact: false }).waitFor({ timeout: 3000 });
  await page.screenshot({ path: `${output}/dialog-open.png` });

  // ② 取消：不删除
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.waitForTimeout(400);
  assert.equal(deleted.length, 0, "cancel must not delete");
  assert.equal(await page.getByText("被删会话", { exact: true }).count(), 1, "session still listed after cancel");

  // ③ 再开 → Esc 关闭 = 取消。删除按钮 stopPropagation 让菜单在对话框后面
  // 保持 open——重开前按 details 实际状态决定是否点 summary（连点会 toggle 关）。
  await item.hover();
  const menuOpen = await page.locator(".task-sidebar .task-row-menu").first().evaluate((d) => d.open);
  if (!menuOpen) await page.locator('.task-sidebar .task-row-menu summary').first().click();
  await page.locator('button[title="删除会话"]').first().click();
  await dlg.waitFor({ timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  assert.equal(deleted.length, 0, "escape must not delete");

  // ④ 确认：真删除且列表刷新
  await item.hover();
  const menuOpen2 = await page.locator(".task-sidebar .task-row-menu").first().evaluate((d) => d.open);
  if (!menuOpen2) await page.locator('.task-sidebar .task-row-menu summary').first().click();
  await page.locator('button[title="删除会话"]').first().click();
  await dlg.waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.waitForTimeout(600);
  assert.deepEqual(deleted, ["a"], "confirm deletes the session");
  assert.equal(await page.getByText("幸存会话", { exact: true }).count(), 1, "other session intact");
  assert.equal(nativeDialogs.length, 0, "no native window.confirm fired");
  assert.deepEqual(errors, [], JSON.stringify(errors));
  console.log("confirm-dialog: all assertions passed");
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
