import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

/**
 * 子代理消息盒自动跟随 + 运行态外观验收（2026-10-09 三连修）：
 *
 * ① 状态行不再裸英文工具名：task 运行中显示「正在执行子任务」；
 * ② 中止按钮中性化（墨底白方块），不再常驻红色警示；
 * ③ 展开的运行中工具卡不再有第二份绿色「正在等待工具返回结果…」（单一状态源）；
 * ④ 子代理 Tab 未点过「打开」也自动展示内容（跑着的优先），不再空占位反向引导；
 * ⑤ 并行多子代理出 chips，盒内切换只换内容不抢 Tab。
 */

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
const output = process.env.LECTERN_UI_OUTPUT || "test-results/subagent-pane-follow";
mkdirSync(output, { recursive: true });

const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

await page.addInitScript(() => {
  localStorage.removeItem("lectern:workbench-open");
  // 任务级布局：probe-run 直接开工作台 + 子代理页（不点「打开」的自动跟随场景）
  localStorage.setItem(
    "lectern.task-layout",
    JSON.stringify({ version: 1, byTaskId: { "probe-run": { open: true, width: 440, tab: "subagent", tabExplicit: true, updatedAt: Date.now() } } }),
  );
  window.EventSource = class { close() {} };
});

const sid = () => "conversation";
const childTranscript = (label) => [
  { info: { id: `${label}-user`, role: "user", sessionId: label }, messageSeq: 1, parts: [{ id: `${label}-user-text`, messageId: `${label}-user`, sessionId: label, type: "text", text: `子任务 ${label} 的指令` }] },
  { info: { id: `${label}-assistant`, role: "assistant", sessionId: label }, messageSeq: 2, parts: [{ id: `${label}-assistant-text`, messageId: `${label}-assistant`, sessionId: label, type: "text", text: `子代理 ${label} 正在处理自己的那份工作。` }] },
];

await page.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  if (path === "/api/sessions")
    return route.fulfill({ json: [{ id: "probe-run", title: "子代理跟随验收", agent: "default", model: { providerId: "openai", modelId: "gpt-test" }, time: { created: "2026-10-09T00:00:00Z" } }] });
  if (path === "/api/sessions/probe-run/messages")
    return route.fulfill({
      json: {
        messages: [
          { info: { id: "user-1", role: "user", sessionId: sid() }, messageSeq: 1, parts: [{ id: "user-text", messageId: "user-1", sessionId: sid(), type: "text", text: "用子代理并行做两件事" }] },
          {
            info: { id: "assistant-1", role: "assistant", sessionId: sid() },
            messageSeq: 2,
            parts: [
              { id: "task-tool", messageId: "assistant-1", sessionId: sid(), type: "tool", tool: "task", state: { status: "running", input: { description: "并行两件事", prompt: "A 和 B", subagent_type: "general" }, time: { start: "2026-10-09T00:00:01Z" } } },
              { id: "subtask-a", messageId: "assistant-1", sessionId: sid(), type: "subtask", prompt: "处理 A", description: "调研 A 方案", agent: "general", childSessionId: "child-a" },
              { id: "subtask-b", messageId: "assistant-1", sessionId: sid(), type: "subtask", prompt: "处理 B", description: "整理 B 资料", agent: "general", childSessionId: "child-b" },
            ],
          },
        ],
        beforeCursor: null,
        hasMoreBefore: false,
        historyRevision: 1,
        snapshotSeq: 5,
        task: null,
        stateEvents: [
          { seq: 1, type: "session.status", data: { status: "running" } },
          { seq: 2, type: "subagent.started", data: { id: "child-a" } },
          { seq: 3, type: "subagent.step", data: { id: "child-a", tool: "read", title: "读 A 相关文件", state: "running" } },
          { seq: 4, type: "subagent.started", data: { id: "child-b" } },
          { seq: 5, type: "subagent.finished", data: { id: "child-b", state: "done", durationMs: 4200, toolCalls: 3 } },
        ],
      },
    });
  if (path === "/api/sessions/child-a/messages") return route.fulfill({ json: { messages: childTranscript("child-a"), beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0 } });
  if (path === "/api/sessions/child-b/messages") return route.fulfill({ json: { messages: childTranscript("child-b"), beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0 } });
  if (path.endsWith("/worktree")) return route.fulfill({ json: { enabled: false } });
  if (path === "/api/auth/status") return route.fulfill({ json: { loggedIn: true, user: { name: "Visual QA" } } });
  if (path === "/api/models") return route.fulfill({ json: { models: [], authenticated: true } });
  if (path === "/api/skills") return route.fulfill({ json: { skills: [] } });
  if (path === "/api/settings/permissions") return route.fulfill({ json: { permissions: {} } });
  if (path === "/api/projects") return route.fulfill({ json: { projects: [], activeId: "default" } });
  return route.fulfill({ json: {} });
});

try {
  await page.goto(process.env.LECTERN_TEST_URL || "http://127.0.0.1:3100", { waitUntil: "domcontentloaded" });
  await page.getByText("子代理跟随验收", { exact: true }).click();
  await page.locator(".chat-assistant-message").first().waitFor();

  // ① 状态行中文短语（原来会显示「正在使用 task」）
  await page.getByText("正在执行子任务", { exact: false }).waitFor({ timeout: 8000 });
  assert.equal(await page.getByText("正在使用 task").count(), 0, "no raw english tool name in the status row");

  // ② 中止按钮中性：墨底、无 danger 描边
  const abortButton = page.getByRole("button", { name: "中止", exact: true });
  await abortButton.waitFor();
  const abortClass = (await abortButton.getAttribute("class")) ?? "";
  assert.ok(abortClass.includes("bg-ink"), `abort should be ink-solid: ${abortClass}`);
  assert.ok(!abortClass.includes("danger"), `abort must not be danger-red: ${abortClass}`);

  // ③ 展开运行中的工具卡：不再有第二份「正在等待工具返回结果…」
  const toolRow = page.locator(".tool-card-trigger").first();
  await toolRow.click();
  await page.waitForTimeout(400);
  assert.equal(await page.getByText("正在等待工具返回结果").count(), 0, "no duplicated live status inside the tool detail");

  // ④ 子代理页自动跟随：没点过「打开」，直接展示 child-a（跑着的优先）。
  //    各 Tab 内容常驻 DOM（隐藏不卸载），必须锚到子代理面板自身。
  const pane = page.locator("[data-subagent-pane]");
  const paneBar = pane.locator(".wb-bar-sm");
  await paneBar.waitFor({ timeout: 8000 });
  const barText = await paneBar.innerText();
  assert.ok(barText.includes("调研 A 方案"), `pane should auto-follow the RUNNING child: ${barText}`);
  assert.equal(await page.getByText("还没有子代理").count(), 0, "no empty placeholder while a subagent exists");
  assert.equal(await page.getByText("子代理消息盒").count(), 0, "no meta-instruction placeholder copy");
  await pane.getByText("子代理 child-a 正在处理自己的那份工作。").waitFor({ timeout: 8000 });

  // ⑤ chips：两个子代理 → 切到 child-b 只换内容
  const chips = pane.locator("[data-subagent-chip]");
  assert.equal(await chips.count(), 2, "parallel subagents get switch chips");
  await chips.nth(1).click();
  await pane.getByText("子代理 child-b 正在处理自己的那份工作。").waitFor({ timeout: 8000 });

  await page.screenshot({ path: `${output}/subagent-follow.png`, fullPage: false });
  assert.deepEqual(errors, [], JSON.stringify(errors));
  console.log("subagent-pane-follow: all assertions passed");
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png`, fullPage: false }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
