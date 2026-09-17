import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
mkdirSync("test-results/task-groups", { recursive: true });
try {
  const page = await browser.newPage();
  const task = (id, extra = {}) => ({
    id, title: id, agent: "default", model: { providerId: "openai", modelId: "test" },
    time: { created: "2026-09-07T00:00:00Z" }, ...extra,
  });
  await page.route("**/api/sessions**", (route) => route.request().method() === "GET" ? route.fulfill({
    json: [task("approval-task", { awaitingPermission: true, running: true }),
      task("failed-task", { lastOutcome: "error" }), task("running-task", { running: true }), task("recent-task")],
  }) : route.continue());
  await page.goto(process.env.LECTERN_TEST_URL || "http://127.0.0.1:3101", { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.getByText("approval-task", { exact: true }).waitFor({ timeout: 90000 });
  for (const width of [1440, 960]) {
    await page.setViewportSize({ width, height: 900 });
    if (width < 1180) {
      // 768–1179px 下侧栏是**默认关闭**的覆盖层（规格 §7）：先等桌面常驻侧栏的分隔条
      // 卸载（断点切换已提交），再由用户显式展开侧栏，最后断言收起后会话被交还。
      await page.getByRole("separator", { name: "调整会话栏宽度" }).waitFor({ state: "detached" });
      await page.getByRole("button", { name: "展开会话栏", exact: true }).click();
      await page.locator(".panel-overlay-left").waitFor();
    }
    const sidebar = await page.locator(".task-sidebar").innerText();
    for (const label of ["待确认", "需要处理", "进行中", "最近"]) assert.ok(sidebar.includes(label), label);
    const order = ["approval-task", "failed-task", "running-task", "recent-task"].map((label) => sidebar.indexOf(label));
    assert.ok(order.every((value, i) => value >= 0 && (i === 0 || value > order[i - 1])));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.LECTERN_UI_SCREENSHOT === "1") await page.screenshot({ path: `test-results/task-groups/${width}.png`, timeout: 90000, animations: "disabled" });
    if (width < 1180) {
      await page.getByRole("button", { name: "收起会话栏", exact: true }).click();
      await page.locator(".panel-overlay-left").waitFor({ state: "detached" });
      assert.equal(await page.locator(".task-sidebar").count(), 0, "closing the sidebar overlay hands the conversation back");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
  }
  console.log("Task group browser checks passed at 1440px and 960px");
} finally {
  await browser.close();
}
