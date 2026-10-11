import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

/**
 * UX 全流程走查（web-gui-tester 方法论）：环境准备阶段用 route mock 种出三种
 * 状态的会话（完成/运行/恢复），之后逐步 GUI 操作 + 截图。截图落在
 * test-results/ux-walkthrough/，每张都要视觉审（analyze_image）。
 *
 * 与断言型 e2e 不同：本脚本不断言对错，只忠实记录每个状态的样子，
 * 「哪里奇怪」由走查报告判断。
 */

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
const output = process.env.LECTERN_UI_OUTPUT || "test-results/ux-walkthrough";
mkdirSync(output, { recursive: true });

/** ---------- fixture：三种状态的会话 ---------- */
const sid = (s) => s;
const text = (s, id, t, role = "assistant") => ({
  info: { id, role, sessionId: s },
  messageSeq: 0,
  parts: [{ id: `${id}-t`, messageId: id, sessionId: s, type: "text", text: t }],
});
const tool = (s, id, name, title, input = {}) => ({
  id,
  messageId: "m2",
  sessionId: s,
  type: "tool",
  tool: name,
  state: { status: "completed", input, output: "（输出略）", title, time: { start: "2026-10-10T08:00:00Z", end: "2026-10-10T08:00:04Z" } },
});
const reasoning = (s, id, t) => ({ id, messageId: "m2", sessionId: s, type: "reasoning", text: t });
const subtask = (s, id, child, desc) => ({ id, messageId: "m2", sessionId: s, type: "subtask", prompt: desc, description: desc, agent: "general", childSessionId: child });

// 会话 A：完成态（有过程、子代理、交付）
const doneMessages = [
  text(sid("done"), "u1", "帮我看一下这个项目的结构，再并行调研两个依赖库的用法", "user"),
  {
    info: { id: "m2", role: "assistant", sessionId: sid("done") },
    messageSeq: 2,
    parts: [
      reasoning(sid("done"), "r1", "用户要看项目结构，还需要并行调研两个依赖。先读目录，再派两个子代理分别调研。"),
      tool(sid("done"), "t1", "read", "读取 package.json", { path: "package.json" }),
      tool(sid("done"), "t2", "glob", "查找 src 下全部文件", { pattern: "src/**/*.ts" }),
      tool(sid("done"), "t3", "bash", "执行 pnpm typecheck", { command: "pnpm typecheck" }),
      text(sid("done"), "t4p", "项目是一个 Next.js + Electron 的双端应用。接下来派两个子代理分别调研 exceljs 和 mammoth 的用法，稍等。"),
      subtask(sid("done"), "st1", "child-a", "调研 exceljs 导出能力"),
      subtask(sid("done"), "st2", "child-b", "整理 mammoth 文档转换要点"),
      text(sid("done"), "t8p", "两个子代理都完成了。汇总如下：exceljs 适合服务端生成 xlsx，mammoth 负责 docx → html。项目结构清晰，依赖合理。"),
    ],
  },
];
const doneEvents = [
  { seq: 1, type: "subagent.started", data: { id: "child-a" } },
  { seq: 2, type: "subagent.step", data: { id: "child-a", tool: "read", title: "读 exceljs README", state: "completed" } },
  { seq: 3, type: "subagent.finished", data: { id: "child-a", state: "done", durationMs: 84000, toolCalls: 6 } },
  { seq: 4, type: "subagent.started", data: { id: "child-b" } },
  { seq: 5, type: "subagent.finished", data: { id: "child-b", state: "done", durationMs: 61000, toolCalls: 4 } },
];
const childMessages = (label, desc) => [
  text(label, "cu1", desc, "user"),
  { info: { id: "ca1", role: "assistant", sessionId: label }, messageSeq: 2, parts: [
    reasoning(label, "cr1", "先查官方文档，再总结关键 API。"),
    tool(label, "ct1", "websearch", "搜索官方文档", { query: `${desc} 官方文档` }),
    text(label, "ct2", `调研完成：${desc} 的要点是……（子代理结论正文，长一点方便看排版。这条消息出现在右侧子代理消息盒里，验证转录的完整性与可读性。）`),
  ] },
];

// 会话 B：运行态
const runMessages = [
  text(sid("run"), "u1", "跑一下测试并修掉失败的那个", "user"),
  {
    info: { id: "m2", role: "assistant", sessionId: sid("run") },
    messageSeq: 2,
    parts: [
      reasoning(sid("run"), "r1", "先跑测试看失败情况。"),
      tool(sid("run"), "t1", "bash", "执行 pnpm test", { command: "pnpm test" }),
      { id: "tk1", messageId: "m2", sessionId: sid("run"), type: "tool", tool: "task", state: { status: "running", input: { description: "修复失败用例", prompt: "修 vitest 失败", subagent_type: "general" }, time: { start: "2026-10-10T08:10:00Z" } } },
      subtask(sid("run"), "st1", "child-r", "修复失败用例"),
    ],
  },
];
const runEvents = [
  { seq: 1, type: "session.status", data: { status: "running" } },
  { seq: 2, type: "subagent.started", data: { id: "child-r" } },
  { seq: 3, type: "subagent.step", data: { id: "child-r", tool: "read", title: "读失败用例源码", state: "completed" } },
  { seq: 4, type: "subagent.step", data: { id: "child-r", tool: "edit", title: "修改断言", state: "running" } },
];

// 会话 C：中断恢复态（错误行 + needsUser 卡）
const recMessages = [
  text(sid("rec"), "u1", "重构一下上传模块", "user"),
  {
    info: { id: "m2", role: "assistant", sessionId: sid("rec") },
    messageSeq: 2,
    parts: [tool(sid("rec"), "t1", "read", "读取上传模块", { path: "lib/upload.ts" })],
  },
  { info: { id: "m3", role: "assistant", sessionId: sid("rec") }, messageSeq: 3, parts: [], error: { name: "UpstreamStalled", message: "上游长时间无响应，模型可能卡住或不支持该输入（如非视觉模型收到图片）" } },
];
const recEvents = [{ seq: 1, type: "session.status", data: { status: "error" } }];

const pageSpecs = {
  done: { messages: doneMessages, events: doneEvents },
  run: { messages: runMessages, events: runEvents },
  rec: { messages: recMessages, events: recEvents },
};

const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && consoleErrors.push(`console: ${m.text().slice(0, 200)}`));

await page.addInitScript(() => {
  localStorage.removeItem("lectern.task-layout");
  localStorage.removeItem("lectern:workbench-open");
  window.EventSource = class { close() {} };
});

let promptCount = 0;
await page.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  if (path === "/api/sessions")
    return route.fulfill({ json: [
      { id: "done", title: "看项目结构 + 并行调研依赖", agent: "default", model: { providerId: "openai", modelId: "glm-5.3" }, time: { created: "2026-10-10T08:00:00Z" } },
      { id: "run", title: "跑测试并修复", agent: "default", model: { providerId: "openai", modelId: "glm-5.3" }, time: { created: "2026-10-10T08:10:00Z" } },
      { id: "rec", title: "重构上传模块（中断）", agent: "default", model: { providerId: "openai", modelId: "glm-5.3" }, time: { created: "2026-10-10T07:40:00Z" } },
    ] });
  for (const [key, spec] of Object.entries(pageSpecs)) {
    if (path === `/api/sessions/${key}/messages`)
      return route.fulfill({ json: { messages: spec.messages, beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 10, task: key === "done" ? {
        id: "task-done", sessionId: "done", goal: "看项目结构 + 并行调研依赖", status: "delivered",
        steps: [], acceptanceCriteria: [], revision: 1, attemptCount: 2, constraints: [], createdAt: "2026-10-10T08:00:00Z", updatedAt: "2026-10-10T08:12:00Z",
        deliveredAt: "2026-10-10T08:12:00Z", activeMs: 612000,
        result: { outcome: "结构梳理完成，两个依赖的用法调研已汇总。", changes: ["docs/deps-notes.md"], verification: ["两个子代理结论均已回收"], remaining: [] },
        evidence: { count: 3, recent: [{ kind: "artifact", summary: "依赖调研汇总" }] },
      } : null, stateEvents: spec.events } });
  }
  if (path === "/api/sessions/child-a/messages") return route.fulfill({ json: { messages: childMessages("child-a", "调研 exceljs 导出能力"), beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0 } });
  if (path === "/api/sessions/child-b/messages") return route.fulfill({ json: { messages: childMessages("child-b", "整理 mammoth 文档转换要点"), beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0 } });
  if (path === "/api/sessions/child-r/messages") return route.fulfill({ json: { messages: childMessages("child-r", "修复失败用例"), beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0 } });
  if (path.endsWith("/prompt")) {
    promptCount++;
    await new Promise((r) => setTimeout(r, 1200));
    return route.fulfill({ json: { userMessageId: `um-${promptCount}`, requestId: `req-${promptCount}` } });
  }
  if (path.endsWith("/worktree")) return route.fulfill({ json: { enabled: false } });
  if (path === "/api/auth/status") return route.fulfill({ json: { loggedIn: true, user: { name: "走查" } } });
  if (path === "/api/models") return route.fulfill({ json: { models: [{ providerId: "openai", modelId: "glm-5.3", displayName: "GLM-5.3" }, { providerId: "openai", modelId: "glm-5.3-flash", displayName: "GLM-5.3 Flash" }], authenticated: true } });
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

/** ---------- 正式走查开始 ---------- */
await page.goto(process.env.LECTERN_TEST_URL || "http://127.0.0.1:3100", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);

await step("01-cold-start", () => {});
await step("02-open-done-session", () => page.getByText("看项目结构 + 并行调研依赖", { exact: true }).click());
await step("03-workflow-expand", () => page.locator(".chat-workflow-toggle").first().click());
await step("04-subtask-expand", () => page.locator(".chat-subtask-toggle").first().click());
await step("05-open-child-pane", () => page.getByRole("button", { name: "打开", exact: true }).first().click());
await step("06-child-chips", () => {
  const chip = page.locator("[data-subagent-chip]");
  if (chip.count() > 1) chip.nth(1).click().catch(() => {});
});
await step("07-workbench-tabs", async () => {
  await page.locator(".wb-tab", { hasText: "审查" }).first().click();
});
await step("08-files-tab", () => page.locator(".wb-tab", { hasText: "文件" }).first().click());
await step("09-preview-tab", () => page.locator(".wb-tab", { hasText: "成果预览" }).first().click());

await step("10-switch-run-session", () => page.getByText("跑测试并修复", { exact: true }).click());
await step("11-run-detail-expand", () => page.locator(".tool-card-trigger").first().click());
// 运行态会话：打字但无发送按钮（发现①：唯一可见动作是中止，Enter 排队不可见）
await step("12-running-typed", async () => {
  const ta = page.locator("textarea").first();
  ta.fill("顺便把 lint 也跑一下");
});
await step("13-switch-idle-session", () => page.getByText("看项目结构 + 并行调研依赖", { exact: true }).click());
await step("14-send-clicked", async () => {
  const ta = page.locator("textarea").first();
  ta.fill("追问：这两个库有替代品吗");
  await page.getByRole("button", { name: "发送", exact: true }).click();
});
await step("15-after-send", () => page.waitForTimeout(1600));

await step("15-switch-rec-session", () => page.getByText("重构上传模块", { exact: false }).first().click());
await step("16-error-expand", () => page.locator(".chat-error-toggle, [data-error-toggle]").first().click().catch(() => {}));
await step("17-search-open", () => page.getByRole("button", { name: "搜索消息", exact: true }).click().catch(() => {}));
await step("18-search-opened", () => page.locator("input[placeholder*='搜索']").first().fill("测试").catch(() => {}));
await step("19-run-config", () => page.getByRole("button", { name: "运行配置", exact: true }).click());
await step("20-narrow", async () => { await page.setViewportSize({ width: 1024, height: 800 }); await page.waitForTimeout(400); });
await step("21-narrow-overlay", async () => {
  await page.getByRole("button", { name: "展开会话栏", exact: true }).click().catch(() => {});
});
await page.setViewportSize({ width: 1600, height: 900 });

console.log("\nconsole/page errors:", consoleErrors.length ? consoleErrors : "无");
await browser.close();
