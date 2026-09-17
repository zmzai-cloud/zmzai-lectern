import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

/**
 * 对话优先布局回归（对话优先视觉改版规格 §11.2 / §11.3 / §11.4）。
 *
 * 覆盖：拖动收缩会话、消息换行不裁切、拖到极值被 clamp、双击复位、键盘调整、
 * 按任务隔离、窄断点覆盖层互斥且不污染桌面偏好、Debug Area 不改变会话列宽、
 * 全程无页面级横向滚动。
 */

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
const output = process.env.LECTERN_UI_OUTPUT || "test-results/workbench-resize";
mkdirSync(output, { recursive: true });

/** 规格 §5.5.2 的边界：min 360，max = min(760, available * 0.58)。 */
const WORKBENCH_MIN = 360;
const WORKBENCH_MAX_FOR_1600 = 760;
const WORKBENCH_DEFAULT = 384;
const CONVERSATION_MIN = 480;

const readStore = page => page.evaluate(() => JSON.parse(localStorage.getItem("lectern.task-layout") || "{}"));
const layoutOf = (store, id) => store.byTaskId?.[id];
const noHorizontalOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    // 只有版本化的整表结构才是合法来源（规格 §9）。
    localStorage.setItem("lectern.task-layout", JSON.stringify({
      version: 1,
      byTaskId: {
        resize: { open: true, width: 384, tab: "review", tabExplicit: true, updatedAt: 1 },
      },
    }));
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
    if (path === "/api/sessions") return route.fulfill({ json: [
      { id: "resize", title: "分栏收缩测试", agent: "default", model: { providerId: "test", modelId: "test" }, time: { created: "2026-09-17T00:00:00Z" } },
      { id: "second", title: "独立布局测试", agent: "default", model: { providerId: "test", modelId: "test" }, time: { created: "2026-09-17T00:01:00Z" } },
    ] });
    if (path === "/api/sessions/resize/messages") return route.fulfill({ json: { messages: transcript, beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0 } });
    if (path === "/api/sessions/second/messages") return route.fulfill({ json: { messages: [], beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0 } });
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
  const valueNow = async () => Number(await splitter.getAttribute("aria-valuenow"));
  const dragSplitterTo = async targetX => {
    const handle = await splitter.boundingBox();
    assert.ok(handle, "splitter must be visible while side by side");
    const y = handle.y + handle.height / 2;
    await page.mouse.move(handle.x + handle.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(targetX, y, { steps: 8 });
    await page.mouse.up();
  };

  const beforeChat = await page.locator(".chat-view").boundingBox();
  assert.ok(beforeChat, "chat pane must be measurable");
  assert.ok(beforeChat.width >= CONVERSATION_MIN, `conversation pane >= ${CONVERSATION_MIN}: ${JSON.stringify(beforeChat)}`);
  assert.equal(await valueNow(), WORKBENCH_DEFAULT, "seeded workbench width is restored per task");
  await page.screenshot({ path: `${output}/before.png`, animations: "disabled" });

  // ── 1. 拖动只改变两侧宽度，会话内容跟随换行、不被裁切（规格 §11.2）──────────
  await dragSplitterTo(beforeChat.x + 300);
  const afterChat = await page.locator(".chat-view").boundingBox();
  assert.ok(afterChat && afterChat.width < beforeChat.width - 200, JSON.stringify({ beforeChat, afterChat }));
  const overflow = await page.locator(".chat-view").evaluate(root => {
    const boundary = root.getBoundingClientRect().right;
    return [...root.querySelectorAll(".chat-assistant-message, .chat-user-bubble")].map(element => {
      const rect = element.getBoundingClientRect();
      return { right: rect.right, boundary, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
  });
  assert.ok(overflow.length >= 2, "both user and assistant messages must be rendered");
  for (const item of overflow) {
    assert.ok(item.right <= item.boundary + 1, JSON.stringify(item));
    assert.ok(item.scrollWidth <= item.clientWidth + 1, JSON.stringify(item));
  }
  assert.equal(await noHorizontalOverflow(page), true, "dragging must not create page-level horizontal scroll");

  // ── 2. 拖到极值被 clamp，且不回弹（规格 §5.5.2 / §11.4）───────────────────
  await dragSplitterTo(50);
  assert.equal(await valueNow(), WORKBENCH_MAX_FOR_1600, "drag past max clamps to min(760, available*0.58)");
  await dragSplitterTo(1595);
  assert.equal(await valueNow(), WORKBENCH_MIN, "drag past min clamps to 360");
  assert.equal(await noHorizontalOverflow(page), true);

  // ── 3. 双击复位到推荐宽度（规格 §5.5.2）──────────────────────────────────
  await splitter.dblclick();
  assert.equal(await valueNow(), WORKBENCH_DEFAULT, "double click restores the recommended width");

  // ── 4. 键盘可聚焦并调整，Shift 加速（规格 §5.5.2 / §11.2）────────────────
  await splitter.focus();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "调整右侧工作区宽度");
  assert.equal(await splitter.getAttribute("role"), "separator");
  assert.equal(await splitter.getAttribute("aria-valuemin"), String(WORKBENCH_MIN));
  assert.equal(await splitter.getAttribute("aria-valuemax"), String(WORKBENCH_MAX_FOR_1600));
  await page.keyboard.press("ArrowLeft");
  assert.equal(await valueNow(), WORKBENCH_DEFAULT + 16, "arrow key steps 16px");
  await page.keyboard.press("Shift+ArrowLeft");
  assert.equal(await valueNow(), WORKBENCH_DEFAULT + 16 + 48, "shift+arrow steps 48px");

  // ── 5. 布局按任务持久化并相互隔离（规格 §11.4 / §12.3）───────────────────
  const tuned = WORKBENCH_DEFAULT + 64;
  let store = await readStore(page);
  assert.equal(store.version, 1, "layout store carries a version");
  assert.deepEqual(
    { open: layoutOf(store, "resize")?.open, width: layoutOf(store, "resize")?.width },
    { open: true, width: tuned },
    `resize task persisted ${tuned}`,
  );

  await page.getByText("独立布局测试", { exact: true }).click();
  assert.equal(await page.locator(".workbench-shell").count(), 0, "a task without saved state defaults to a closed workbench");
  store = await readStore(page);
  const secondRecord = layoutOf(store, "second");
  assert.notEqual(
    secondRecord?.open,
    true,
    `the second task must not inherit the first task's open state: ${JSON.stringify(secondRecord)}`,
  );
  assert.deepEqual(
    { open: layoutOf(store, "resize")?.open, width: layoutOf(store, "resize")?.width },
    { open: true, width: tuned },
    "switching tasks must not overwrite the previous task's width",
  );

  // 在第二个任务里打开工作台并切到「文件」标签 → 开合 / 宽度 / 标签三个维度互不串台
  await page.getByRole("button", { name: "展开右侧工作区" }).click();
  await page.locator(".workbench-shell").waitFor();
  await page.locator("#wb-tab-files").click();
  await page.waitForFunction(() => {
    const raw = JSON.parse(localStorage.getItem("lectern.task-layout") || "{}");
    return raw.byTaskId?.second?.tab === "files";
  });
  store = await readStore(page);
  assert.equal(layoutOf(store, "second")?.tab, "files", "the second task keeps its own tab");
  assert.equal(layoutOf(store, "second")?.open, true, "the second task keeps its own open state");
  assert.equal(layoutOf(store, "resize")?.tab, "review", "the first task's tab must not change");
  assert.equal(layoutOf(store, "resize")?.width, tuned, "the first task's width must not change");

  await page.getByText("分栏收缩测试", { exact: true }).click();
  await page.locator(".workbench-shell").waitFor();
  assert.equal(await valueNow(), tuned, "returning to a task restores its own width");
  assert.equal(
    await page.locator("#wb-tab-review").getAttribute("aria-selected"),
    "true",
    "returning to a task restores its own tab",
  );

  // ── 6. Debug Area 只改变会话可见高度，不改变会话列宽（规格 §5.6 / §11.4）──
  const chatBeforeTerminal = await page.locator(".chat-view").boundingBox();
  await page.getByRole("button", { name: "打开终端", exact: true }).click();
  await page.locator("[data-terminal-pane]").waitFor();
  const chatWithTerminal = await page.locator(".chat-view").boundingBox();
  assert.ok(
    chatBeforeTerminal && chatWithTerminal && Math.abs(chatWithTerminal.width - chatBeforeTerminal.width) <= 1,
    JSON.stringify({ chatBeforeTerminal, chatWithTerminal }),
  );
  assert.ok(chatWithTerminal.height <= chatBeforeTerminal.height, "terminal only takes height");
  assert.equal(await noHorizontalOverflow(page), true);
  await page.getByRole("button", { name: "收起终端", exact: true }).click();

  // ── 7. 窄断点：覆盖层默认关闭、互斥，且不写回桌面偏好（规格 §7 / §7.1 / §12.12）──
  await page.setViewportSize({ width: 960, height: 800 });
  // 确定性等待：并排用的内联分隔条消失即代表已切到覆盖层模式
  await page.getByRole("separator", { name: "调整右侧工作区宽度" }).waitFor({ state: "detached" });
  assert.equal(await page.locator(".workbench-shell").count(), 0, "the compact range starts with the workbench closed");
  assert.equal(await page.locator(".panel-overlay-right").count(), 0, "no drawer before the user asks for it");
  assert.equal(await valueNow().catch(() => null), null, "no inline splitter in compact mode");
  assert.equal(await noHorizontalOverflow(page), true);

  // 用户显式打开 → 覆盖层出现，但保存的桌面开合与宽度不得被改写
  await page.getByRole("button", { name: "展开右侧工作区" }).click();
  await page.locator(".panel-overlay-right").waitFor();
  const compactDrawer = await page.locator(".panel-overlay-right").boundingBox();
  assert.ok(compactDrawer && compactDrawer.width <= 960, JSON.stringify(compactDrawer));
  store = await readStore(page);
  assert.deepEqual(
    { open: layoutOf(store, "resize")?.open, width: layoutOf(store, "resize")?.width },
    { open: true, width: tuned },
    "opening an overlay must not rewrite the saved desktop preference",
  );

  // 收起工作台 → 只改临时覆盖层
  await page.locator(".panel-scrim").click({ position: { x: 5, y: 10 } });
  assert.equal(await page.locator(".panel-overlay-right").count(), 0, "drawer closes");
  store = await readStore(page);
  assert.deepEqual(
    { open: layoutOf(store, "resize")?.open, width: layoutOf(store, "resize")?.width },
    { open: true, width: tuned },
    "closing an overlay must not overwrite the saved desktop preference",
  );

  // 打开另一个覆盖层 → 两者互斥
  await page.getByRole("button", { name: "展开右侧工作区" }).click();
  await page.locator(".panel-overlay-right").waitFor();
  await page.getByRole("button", { name: "展开会话栏" }).click();
  await page.locator(".panel-overlay-left").waitFor();
  assert.equal(await page.locator(".panel-overlay-right").count(), 0, "compact overlays are mutually exclusive");
  assert.equal(await noHorizontalOverflow(page), true);
  await page.screenshot({ path: `${output}/compact-960.png`, animations: "disabled" });

  // 选中任务后覆盖层自动关闭，会话交还用户
  await page.getByText("分栏收缩测试", { exact: true }).click();
  assert.equal(await page.locator(".panel-overlay-left").count(), 0, "selecting a task closes the sidebar overlay");

  // ── 8. 回到 ≥1180px：恢复已保存的桌面状态（规格 §12.12）──────────────────
  await page.setViewportSize({ width: 1600, height: 900 });
  await splitter.waitFor();
  assert.equal(await valueNow(), tuned, "desktop width restored after leaving the compact range");
  assert.equal(await noHorizontalOverflow(page), true);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${output}/after.png`, animations: "disabled" });
  console.log("PASS: drag/clamp/reset/keyboard, per-task layout isolation, terminal height-only, compact overlay separation, no overflow");
} finally {
  await browser.close();
}
