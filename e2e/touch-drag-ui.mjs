import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

/**
 * 触摸拖拽回归（对话优先视觉改版规格 §5.5.2 的触摸路径）。
 *
 * 【为什么单开一个文件】workbench-resize-ui.mjs 用 page.mouse 驱动，走的是鼠标合成
 * 路径。触摸不是「鼠标减去 hover」：浏览器在收下 touchstart 之后要先做手势仲裁，
 * 一旦把这次按下判定为平移/滚动，后续 pointermove 会变成 pointercancel，拖动在中途
 * 静默失效——鼠标事件永远测不出这一类失败。唯一能证伪的是真实触摸事件流。
 *
 * 【注入方式】Input.dispatchTouchEvent 进的是浏览器的触摸输入源，Chromium 会走与
 * 真机相同的 pointer events 与手势仲裁代码（包括 touch-action 的计算），因此
 * 「触摸能不能拖动」这个问题在这里有确定的答案。它证不了的是真机独有的部分：
 * 硬件驱动、系统级边缘手势、手指抖动下的实际手感。所以本文件通过 ≠ 真机触摸屏
 * 已验证，验收报告里的措辞必须保持这个区分。
 */

const BASE = process.env.LECTERN_TEST_URL || "http://127.0.0.1:3100";
const output = process.env.LECTERN_UI_OUTPUT || "test-results/touch-drag";
mkdirSync(output, { recursive: true });

const SES = "touch";
const TITLE = "触摸拖拽测试";
const WORKBENCH_MIN = 360;
const WORKBENCH_MAX_FOR_1600 = 760;
const WORKBENCH_DEFAULT = 384;
const SIDEBAR_DEFAULT = 256;

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });

try {
  // hasTouch 打开触摸输入源；CDP 的 touch 事件在 headless 下同样有效。
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.addInitScript(({ ses }) => {
    localStorage.setItem("lectern.task-layout", JSON.stringify({
      version: 1,
      byTaskId: { [ses]: { open: true, width: 384, tab: "review", tabExplicit: true, updatedAt: 1 } },
    }));
    window.EventSource = class { close() {} };
    // 捕获阶段记下指针事件流：断言「触摸真的进来了」以及「没有被手势仲裁打断」。
    window.__touchLog = { down: [], up: [], cancel: [], move: 0 };
    window.addEventListener("pointerdown", (event) => {
      window.__touchLog.down.push({ pointerType: event.pointerType, id: event.pointerId });
    }, true);
    window.addEventListener("pointerup", (event) => {
      window.__touchLog.up.push({ pointerType: event.pointerType, id: event.pointerId });
    }, true);
    window.addEventListener("pointercancel", (event) => {
      window.__touchLog.cancel.push({ pointerType: event.pointerType, id: event.pointerId });
    }, true);
    window.addEventListener("pointermove", () => { window.__touchLog.move += 1; }, true);
  }, { ses: SES });

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/sessions") return route.fulfill({ json: [
      { id: SES, title: TITLE, agent: "default", model: { providerId: "test", modelId: "test" }, time: { created: "2026-09-18T00:00:00Z" } },
    ] });
    if (path === `/api/sessions/${SES}/messages`) return route.fulfill({ json: {
      messages: [
        { info: { id: "u1", role: "user", sessionId: SES }, messageSeq: 1, parts: [{ id: "p1", messageId: "u1", sessionId: SES, type: "text", text: "触摸拖动右侧分隔条时，这段内容必须跟着可用宽度重新换行，不能被面板裁断，也不能触发页面级横向滚动。".repeat(3) }] },
        { info: { id: "a1", role: "assistant", sessionId: SES }, messageSeq: 2, parts: [{ id: "p2", messageId: "a1", sessionId: SES, type: "text", text: "收到。".repeat(40) }] },
      ],
      beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0,
    } });
    if (path.endsWith("/worktree")) return route.fulfill({ json: { enabled: false } });
    if (path === "/api/auth/status") return route.fulfill({ json: { loggedIn: true, user: { name: "Touch QA" } } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], authenticated: true } });
    if (path === "/api/skills") return route.fulfill({ json: { skills: [] } });
    if (path === "/api/settings/permissions") return route.fulfill({ json: { permissions: {} } });
    if (path === "/api/projects") return route.fulfill({ json: { projects: [], activeId: "default" } });
    return route.fulfill({ json: {} });
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.getByText(TITLE, { exact: true }).click();
  await page.locator(".chat-assistant-message").waitFor();

  const cdp = await context.newCDPSession(page);
  const workbench = page.getByRole("separator", { name: "调整右侧工作区宽度" });
  const sidebar = page.getByRole("separator", { name: "调整会话栏宽度" });
  const valueNow = async (locator) => Number(await locator.getAttribute("aria-valuenow"));

  const resetLog = () => page.evaluate(() => {
    window.__touchLog = { down: [], up: [], cancel: [], move: 0 };
  });

  /**
   * 以触摸事件流拖动：touchStart → 多段 touchMove → touchEnd。
   * touchPoints 里的 id 必须全场一致，Chromium 靠它把多指手势拆开。
   *
   * 日志在每次拖动前清空——否则读到的第一个 pointerdown 是选中任务那一下鼠标点击，
   * 会把「触摸类型」的断言判错。
   */
  const touchDrag = async (locator, axis, to) => {
    const box = await locator.boundingBox();
    assert.ok(box, "splitter must be visible before a touch drag");
    await resetLog();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const from = axis === "x" ? x : y;
    const point = (value) => (axis === "x" ? { x: value, y, id: 1 } : { x, y: value, id: 1 });
    const steps = 8;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(from)] });
    for (let step = 1; step <= steps; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(from + ((to - from) * step) / steps)] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return { from, steps, log: await page.evaluate(() => window.__touchLog) };
  };

  // ── 0. 前提：触摸能拖动，靠的是分隔条上的 touch-action: none ──────────────────
  // 少了它，浏览器会把横向触摸判成平移并发出 pointercancel，拖动直接失效。
  // 这条断言把「为什么能工作」钉在 CSS 上，而不只是碰巧通过。
  const touchAction = await workbench.evaluate((element) => getComputedStyle(element).touchAction);
  assert.equal(touchAction, "none", `分隔条必须声明 touch-action: none（实际 ${touchAction}）`);
  assert.equal(await valueNow(workbench), WORKBENCH_DEFAULT, "起始宽度来自按任务保存的布局");

  // ── 1. 触摸拖动改变宽度，且全程没有 pointercancel ────────────────────────────
  const first = await touchDrag(workbench, "x", 50);
  const log = first.log;
  assert.equal(log.down.length, 1, `一次触摸拖动应恰好产生一次 pointerdown（实际 ${log.down.length}）`);
  assert.equal(log.down[0].pointerType, "touch", `pointerdown 的类型应为 touch（实际 ${log.down[0].pointerType}）`);
  assert.deepEqual(log.cancel, [], "拖动期间不得出现 pointercancel（出现即代表浏览器把手势判成了滚动）");
  assert.equal(log.move >= 8, true, `应收到全部触摸移动（实际 ${log.move}）`);
  assert.equal(log.up.length, 1, `抬手应恰好产生一次 pointerup（实际 ${log.up.length}）`);
  assert.equal(log.up[0].pointerType, "touch", "pointerup 的类型应同为 touch");

  // ── 2. 拖到两侧极值都被 clamp，且与鼠标路径给出同一个答案 ─────────────────────
  assert.equal(await valueNow(workbench), WORKBENCH_MAX_FOR_1600, "向左拖过头应 clamp 到 min(760, available*0.58)");
  await touchDrag(workbench, "x", 1595);
  assert.equal(await valueNow(workbench), WORKBENCH_MIN, "向右拖过头应 clamp 到 360");

  // ── 3. 位移按 pointerdown 时的起点计算（不是每帧累加），值可精确预期 ───────────
  const exact = await touchDrag(workbench, "x", (await workbench.boundingBox()).x + 6 - 200);
  assert.equal(
    await valueNow(workbench),
    WORKBENCH_MIN + 200,
    `向左触摸拖动 200px 应恰好增加 200（起点 ${Math.round(exact.from)}）`,
  );

  // ── 4. 抬手后拖动状态必须清干净，否则页面会卡在「透明捕获层吃掉所有点击」────
  assert.equal(await workbench.getAttribute("data-dragging"), "false", "抬手后不得停留在拖动态");
  assert.deepEqual(
    await page.evaluate(() => ({ cursor: document.body.style.cursor, userSelect: document.body.style.userSelect })),
    { cursor: "", userSelect: "" },
    "抬手后应清掉全局光标与禁选",
  );
  assert.equal(
    await page.locator(".splitter-capture").count(),
    0,
    "抬手后不得残留页面级拖拽捕获层",
  );

  // ── 5. 会话栏分隔条（另一段代码路径，同一套手势前提）──────────────────────────
  assert.equal(await valueNow(sidebar), SIDEBAR_DEFAULT, "会话栏起始宽度为推荐值");
  await touchDrag(sidebar, "x", (await sidebar.boundingBox()).x + 6 + 64);
  assert.equal(await valueNow(sidebar), SIDEBAR_DEFAULT + 64, "向右触摸拖动 64px 应恰好增加 64");

  // ── 6. 底部调试面板用纵向手势：往上拖变高，方向不能反 ─────────────────────────
  await page.getByRole("button", { name: "打开终端", exact: true }).click();
  await page.locator("[data-terminal-pane]").waitFor();
  const bottom = page.getByRole("separator", { name: "调整底部调试面板高度" });
  const heightBefore = await valueNow(bottom);
  await touchDrag(bottom, "y", (await bottom.boundingBox()).y + 6 - 48);
  assert.equal(await valueNow(bottom), heightBefore + 48, "向上触摸拖动 48px 应恰好增加 48");

  // ── 7. 触摸拖动不得制造页面级滚动，也不得把消息挤出面板 ────────────────────────
  const overflow = await page.locator(".chat-view").evaluate((root) => {
    const boundary = root.getBoundingClientRect().right;
    return [...root.querySelectorAll(".chat-assistant-message, .chat-user-bubble")].map((element) => {
      const rect = element.getBoundingClientRect();
      return { right: rect.right, boundary, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
  });
  assert.equal(overflow.length >= 2, true, "两条消息都应渲染");
  for (const item of overflow) {
    assert.equal(item.right <= item.boundary + 1, true, JSON.stringify(item));
    assert.equal(item.scrollWidth <= item.clientWidth + 1, true, JSON.stringify(item));
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "触摸拖动不得产生页面级横向滚动");
  assert.deepEqual(errors, []);

  await page.screenshot({ path: `${output}/touch-drag.png`, animations: "disabled" });
  console.log("PASS: 触摸拖动在分隔条上成立（touch-action: none、无 pointercancel、clamp 与精确位移、状态清理、横纵两个方向）");
  console.log(`      触摸事件计数：pointerdown ${log.down.length} / pointermove ${log.move} / pointerup ${log.up.length} / pointercancel ${log.cancel.length}`);
  console.log("      注：这是 Chromium 触摸事件路径，不等同于真机触摸屏验证。");
} finally {
  await browser.close();
}
