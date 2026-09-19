import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { assertServingThisBuild } from "./serve-guard.mjs";

/** 交付卡的数据来源（规格 3 §14.1 四问 / §18.4 完成判定依据）。
 *
 *  「验收 x/y · 证据 n 条」此前在**任何**任务上都显示 0/n：`task.started` 是唯一
 *  携带 acceptanceCriteria 的事件，而那一刻所有条件必然 pending、证据必然为 0，
 *  此后整条任务里没有第二个事件带过它们；投影器还把渲染后的整段文本当成 outcome，
 *  于是四问里后三问恒为空，而「剩余项：无」在那段文本里又出现一次——同一件事
 *  出现两次且互相矛盾。这一行恰恰是给用户核对「不必相信这句完成」用的，一个恒错的
 *  核对依据比没有更糟。
 *
 *  【为什么走 SSE 注入而不是 task 快照】出问题的就是事件折叠那条路径：快照走的是
 *  `adoptTask`，服务端已经算对了。所以这里刻意让 `/messages` **不带** task 字段。
 *
 *  【为什么是浏览器 E2E 而不是单测】单测（`lib/chat-projector.test.ts`）钉的是折叠
 *  出来的对象；这里钉的是它最终画在卡片上的两个数字——中间还隔着呈现派生，而那段
 *  派生正是「有没有把证据读进去」最容易悄悄断掉的地方。 */

const url = process.env.LECTERN_TEST_URL || "http://127.0.0.1:3104";
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
const output = process.env.LECTERN_UI_OUTPUT || "test-results/task-delivery";
mkdirSync(output, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__streams = [];
    window.EventSource = class {
      constructor(url) { this.url = url; window.__streams.push(this); }
      close() { this.closed = true; }
    };
  });

  const session = { id: "delivery", title: "交付卡验收", agent: "default", model: { providerId: "openai", modelId: "test" }, time: { created: "2026-09-19T00:00:00Z" } };
  const transcript = [
    { info: { id: "u1", role: "user", sessionId: "delivery" }, messageSeq: 1, parts: [{ id: "u1-text", messageId: "u1", sessionId: "delivery", type: "text", text: "把这个 PDF 的内容完整铺到网页上" }] },
    { info: { id: "a1", role: "assistant", sessionId: "delivery" }, messageSeq: 2, parts: [{ id: "a1-text", messageId: "a1", sessionId: "delivery", type: "text", text: "六步都做完了。" }] },
  ];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/sessions") return route.fulfill({ json: [session] });
    if (path === "/api/sessions/delivery/messages") {
      // 【刻意不带 task】没有它，客户端就不会拿快照覆盖事件折叠出来的任务。
      return route.fulfill({ json: { messages: transcript, beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0 } });
    }
    if (path.endsWith("/worktree")) return route.fulfill({ json: { enabled: false } });
    if (path === "/api/auth/status") return route.fulfill({ json: { loggedIn: true, user: { name: "Delivery QA" } } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], authenticated: true } });
    if (path === "/api/skills") return route.fulfill({ json: { skills: [] } });
    if (path === "/api/settings/permissions") return route.fulfill({ json: { permissions: {} } });
    if (path === "/api/projects") return route.fulfill({ json: { projects: [], activeId: "default" } });
    return route.fulfill({ json: {} });
  });

  // 先验证被测服务就是本仓这次的构建——否则下面所有断言都在比一份别的产物。
  await assertServingThisBuild(page, url);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByText("交付卡验收", { exact: true }).click();
  await page.locator(".chat-assistant-message").first().waitFor();
  await page.waitForFunction(() => (window.__streams ?? []).length > 0);

  await page.evaluate(() => {
    const stream = window.__streams.at(-1);
    let seq = 0;
    const frame = (type, data) => stream.onmessage({ data: JSON.stringify({ sessionId: "delivery", seq: ++seq, type, data }) });
    // task.started：这一刻所有验收条件必然 pending、证据必然为 0——问题就出在这里。
    frame("task.started", {
      taskId: "t1",
      revision: 1,
      goal: "把这个 PDF 的内容完整铺到网页上",
      steps: [{ id: "s1", title: "铺页面", status: "in_progress", order: 0 }],
      acceptanceCriteria: [{ id: "crit_1", description: "页面可用", required: true, status: "pending" }],
    });
    frame("task.step.completed", { taskId: "t1", revision: 2, stepId: "s1", message: "铺页面", completedSteps: 1, totalSteps: 1 });
    // task.delivered：四问 + 逐条验收结论 + 证据条数。
    // `result` 刻意给一段**不同的**文本：0.9.0 起结构化 `delivery` 是四问的唯一来源，
    // 渲染文本只在旧帧（0.9.0 之前的事件）里才是退路。两个都在时写的是哪一个，
    // 下面用 outcome 的取值钉住。
    frame("task.delivered", {
      taskId: "t1",
      revision: 3,
      result: "渲染文本（旧客户端用）",
      delivery: { outcome: "页面已铺好并验证", changes: ["app/page.tsx"], verification: ["本地构建通过"], remaining: [] },
      criteria: [{ id: "crit_1", description: "页面可用", required: true, status: "passed" }],
      evidenceCount: 3,
      evidenceIds: ["e1", "e2", "e3"],
      filesEdited: 1,
      toolCalls: 4,
      durationMs: 1000,
    });
  });

  const card = page.locator("[data-task-delivered]");
  await card.waitFor();
  const squeeze = (text) => text.replace(/\s+/g, "");
  // 1) 两个数字读的是权威字段，而不是从 task.started 那一刻的 pending 快照推出来的
  assert.equal(squeeze(await card.locator("[data-task-basis]").innerText()), "验收1/1·证据3条");
  // 2) 四问来自结构化 delivery，而不是那段渲染文本
  assert.equal(squeeze(await card.locator("[data-task-outcome]").innerText()), "页面已铺好并验证");
  const body = await card.innerText();
  assert.ok(!body.includes("渲染文本（旧客户端用）"), "渲染文本不该被当成 outcome");
  assert.ok(body.includes("app/page.tsx"), "改动项要落到卡片上");
  assert.ok(body.includes("本地构建通过"), "验证方式要落到卡片上");
  assert.equal(squeeze(await card.locator("[data-task-remaining]").innerText()), "剩余项：无");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${output}/delivered.png`, animations: "disabled" });
  console.log("PASS: 交付卡的两个数字与四问都来自权威字段（SSE 折叠路径）");
} finally {
  await browser.close();
}
