import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

/**
 * 对话优先界面验收（对话优先视觉改版规格 §11.1 / §11.4 / §12）。
 *
 * 断言：工作台默认收起、顶部只有一条主状态、运行配置聚合入口、消息列与 Composer
 * 共轴、圆角令牌符合 §6.1、用户消息不超过内容列 78%、1180 并排 / 1179 覆盖、
 * 覆盖层互斥且全宽、浅深主题与全部关键尺寸无横向溢出。
 */

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
const output = process.env.LECTERN_UI_OUTPUT || "test-results/conversation-first";
mkdirSync(output, { recursive: true });

/** 规格 §6.1 圆角表：结构 0 / 控件 6 / 菜单 8 / Composer 与气泡 12。 */
const RADIUS_CONTROL = "6px";
const RADIUS_CONVERSATION = "12px";
/** 规格 §7.2：用户消息最大宽度为内容列的 78%。 */
const USER_BUBBLE_RATIO = 0.78;
const CONVERSATION_MIN = 480;
/** 规格 §7.2：会话内容列统一宽度（--conversation-content-max），建议 760–840px。 */
const CONVERSATION_CONTENT_MAX = 800;

const noHorizontalOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

const longCopy = "会话是 Lectern 的主要工作区域。右侧工作台打开后，这段内容仍需保持自然换行、完整可读，并且不能产生页面级横向滚动。".repeat(4);
/** 已完成工具调用的轻量 part（规格 §5.2）：读完的文件进入「已读 N 个文件」折叠摘要。 */
const readTool = (messageId, index, path) => ({
  id: `read-${index}`,
  messageId,
  sessionId: "conversation",
  type: "tool",
  tool: "read",
  state: { status: "completed", input: { path }, output: "内容略", title: `读取 ${path}` },
});
const transcript = [
  {
    info: { id: "user-1", role: "user", sessionId: "conversation" },
    messageSeq: 1,
    parts: [{ id: "user-text", messageId: "user-1", sessionId: "conversation", type: "text", text: longCopy }],
  },
  {
    info: { id: "assistant-1", role: "assistant", sessionId: "conversation" },
    messageSeq: 2,
    parts: [{ id: "assistant-text", messageId: "assistant-1", sessionId: "conversation", type: "text", text: `${longCopy}\n\n下一步可以按需打开成果或审查。` }],
  },
  {
    info: { id: "assistant-2", role: "assistant", sessionId: "conversation" },
    messageSeq: 3,
    parts: [
      readTool("assistant-2", 1, "app/page.tsx"),
      readTool("assistant-2", 2, "lib/task-layout.ts"),
      readTool("assistant-2", 3, "components/WorkbenchPanel.tsx"),
      { id: "assistant-2-text", messageId: "assistant-2", sessionId: "conversation", type: "text", text: "已读完这三个文件。" },
    ],
  },
];

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.removeItem("lectern.task-layout");
    localStorage.removeItem("lectern:task-layout");
    localStorage.removeItem("lectern:workbench-open");
    localStorage.removeItem("lectern:workbench-width");
    window.EventSource = class { close() {} };
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/sessions") return route.fulfill({ json: [{ id: "conversation", title: "对话优先验收", agent: "default", model: { providerId: "openai", modelId: "gpt-test" }, time: { created: "2026-09-17T00:00:00Z" } }] });
    if (path === "/api/sessions/conversation/messages") return route.fulfill({ json: { messages: transcript, beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0 } });
    if (path.endsWith("/worktree")) return route.fulfill({ json: { enabled: false } });
    if (path === "/api/auth/status") return route.fulfill({ json: { loggedIn: true, user: { name: "Visual QA" } } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], authenticated: true } });
    if (path === "/api/skills") return route.fulfill({ json: { skills: [] } });
    if (path === "/api/settings/permissions") return route.fulfill({ json: { permissions: {} } });
    if (path === "/api/projects") return route.fulfill({ json: { projects: [], activeId: "default" } });
    if (path === "/api/fs/file") return route.fulfill({ json: { path: url.searchParams.get("path") ?? "", size: 24, content: "export const answer = 42;\n", binary: false, mediaType: "text/plain" } });
    return route.fulfill({ json: {} });
  });

  await page.goto(process.env.LECTERN_TEST_URL || "http://127.0.0.1:3100", { waitUntil: "domcontentloaded" });
  await page.getByText("对话优先验收", { exact: true }).click();
  await page.locator(".chat-assistant-message").first().waitFor();

  // ── 默认状态：工作台收起、状态不重复、运行配置聚合（规格 §4.2 / §12.1/2/6/7）──
  assert.equal(await page.locator(".workbench-shell").count(), 0, "workbench defaults closed");
  assert.equal(await page.locator('[data-task-primary-status="true"]').count(), 1, "one primary task status");
  assert.equal(await page.getByRole("button", { name: "运行配置" }).count(), 1, "runtime controls are consolidated");

  // ── 已读文件折叠为一行摘要、工具过程收拢成轻量折叠行（规格 §5.2 / §12.8）──
  const readContext = page.locator(".chat-read-context");
  assert.equal(await readContext.count(), 1, "read files collapse into a single summary row");
  assert.equal(await readContext.evaluate((element) => element.open), false, "the read summary is collapsed by default");
  const readSummary = await readContext.locator("summary").innerText();
  assert.ok(/已读取\s*3\s*个文件/.test(readSummary), readSummary);
  const toolGroup = page.locator(".zmz-tool-group-trigger");
  assert.equal(await toolGroup.count(), 1, "completed tool calls collapse into one lightweight row");
  const toolGroupHeight = (await toolGroup.boundingBox())?.height ?? 0;
  assert.ok(toolGroupHeight <= 32, `the tool group must stay a compact row: ${toolGroupHeight}`);
  await readContext.locator("summary").click();
  await page.locator(".chat-read-context button").first().waitFor();
  assert.equal(await readContext.locator("button").count(), 3, "expanding the summary reveals the file list");
  // 明显入口必须打开**正确**标签（规格 §12.2）：点已读文件 → 工作台在「文件」标签并排打开
  await readContext.locator("button").first().click();
  await page.locator(".workbench-shell").waitFor();
  assert.equal(await page.locator("#wb-tab-files").getAttribute("aria-selected"), "true", "a read file opens the files tab");
  assert.equal(await page.locator(".panel-overlay-right").count(), 0, "the desktop entry opens side by side");
  await readContext.locator("summary").click();
  await page.waitForFunction(() => document.querySelector(".chat-read-context")?.open === false);
  assert.equal(await readContext.locator("button").first().isVisible(), false, "collapsing hides the file list again");

  // ── 单一阅读轴：消息正文左边界与 Composer 卡片左边缘重合（规格 §5.2 / §7.2）──
  const axis = await page.evaluate(() => {
    const messages = document.querySelector(".messages");
    const composer = document.querySelector(".chat-composer");
    const reads = document.querySelector(".chat-read-context");
    if (!messages || !composer || !reads) return null;
    const m = messages.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(messages).paddingLeft);
    const c = composer.getBoundingClientRect();
    const r = reads.getBoundingClientRect();
    const rPad = parseFloat(getComputedStyle(reads).paddingLeft);
    return {
      messageTextLeft: m.x + pad,
      messageTextRight: m.right - pad,
      composerLeft: c.x,
      composerRight: c.right,
      readLeft: r.x + rPad,
      readRight: r.right - rPad,
    };
  });
  assert.ok(axis, "message column, read summary and composer must all exist");
  assert.ok(Math.abs(axis.messageTextLeft - axis.composerLeft) <= 1, JSON.stringify(axis));
  assert.ok(Math.abs(axis.messageTextRight - axis.composerRight) <= 1, JSON.stringify(axis));
  assert.ok(Math.abs(axis.readLeft - axis.messageTextLeft) <= 1, JSON.stringify(axis));
  assert.ok(Math.abs(axis.readRight - axis.messageTextRight) <= 1, JSON.stringify(axis));

  // ── 圆角令牌（规格 §6.1）────────────────────────────────────────────────
  const radii = await page.evaluate(() => ({
    bubble: getComputedStyle(document.querySelector(".chat-user-bubble")).borderTopLeftRadius,
    composer: getComputedStyle(document.querySelector(".chat-composer")).borderTopLeftRadius,
  }));
  assert.equal(radii.bubble, RADIUS_CONVERSATION, "user bubble is 12px");
  assert.equal(radii.composer, RADIUS_CONVERSATION, "composer is 12px");

  // ── 用户消息不超过内容列 78%（规格 §7.2）────────────────────────────────
  const bubbleRatio = await page.evaluate(() => {
    const messages = document.querySelector(".messages");
    const bubble = document.querySelector(".chat-user-bubble");
    const m = messages.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(messages).paddingLeft);
    const b = bubble.getBoundingClientRect();
    return b.width / (m.width - pad * 2);
  });
  assert.ok(bubbleRatio <= USER_BUBBLE_RATIO + 0.02, `user bubble ratio ${bubbleRatio}`);

  // ── 桌面并排：工作台就位后会话仍 ≥480，且无横向溢出（规格 §7 / §11.4）──────
  for (const [width, height] of [[1600, 900], [1440, 900], [1180, 900]]) {
    await page.setViewportSize({ width, height });
    const workbenchButton = page.getByRole("button", { name: /右侧工作区/ });
    if (await page.locator(".workbench-shell").count() === 0) await workbenchButton.click();
    await page.locator(".workbench-shell").waitFor();
    const chat = await page.locator(".chat-view").boundingBox();
    assert.ok(chat && chat.width >= CONVERSATION_MIN, JSON.stringify({ width, chat }));
    assert.equal(await page.locator(".panel-overlay-right").count(), 0, `${width}px must be side by side, not an overlay`);
    // 长用户消息右边界不越出会话 pane，Composer 不超出统一阅读轴（规格 §11.4 / §7.2）
    const edges = await page.evaluate(() => {
      const pane = document.querySelector(".chat-view").getBoundingClientRect();
      const bubble = document.querySelector(".chat-user-bubble").getBoundingClientRect();
      const composer = document.querySelector(".chat-composer").getBoundingClientRect();
      return { paneRight: pane.right, bubbleRight: bubble.right, composerWidth: composer.width };
    });
    assert.ok(edges.bubbleRight <= edges.paneRight + 1, JSON.stringify({ width, edges }));
    assert.ok(edges.composerWidth <= CONVERSATION_CONTENT_MAX + 1, JSON.stringify({ width, edges }));
    assert.equal(await noHorizontalOverflow(page), true);
    // 工作台标签也是紧凑控件，走 6px 令牌（规格 §6.1）
    const tabRadius = await page.evaluate(() => getComputedStyle(document.querySelector(".wb-tab")).borderTopLeftRadius);
    assert.equal(tabRadius, RADIUS_CONTROL, `workbench tab is 6px at ${width}px`);
    await page.screenshot({ path: `${output}/desktop-${width}.png`, animations: "disabled" });
  }

  // ── 1179 必须落回覆盖层，且覆盖层默认关闭（规格 §7 / §12.12）──────────────
  // 规格明文：768–1179px 下侧栏与工作台都是覆盖层、**默认关闭**，不看桌面偏好；
  // 桌面偏好只负责「回到 ≥1180px 后恢复」。
  await page.setViewportSize({ width: 1179, height: 900 });
  // 确定性等待：并排用的内联分隔条消失即代表断点切换已经提交
  await page.getByRole("separator", { name: "调整右侧工作区宽度" }).waitFor({ state: "detached" });
  assert.equal(await page.locator(".panel-overlay-right").count(), 0, "compact workbench overlay starts closed");
  assert.equal(await page.locator(".workbench-shell").count(), 0, "no inline workbench below the desktop breakpoint");
  assert.equal(await noHorizontalOverflow(page), true);
  await page.getByRole("button", { name: "展开右侧工作区" }).click();
  await page.locator(".panel-overlay-right").waitFor();
  assert.equal(await noHorizontalOverflow(page), true);
  await page.screenshot({ path: `${output}/compact-1179.png`, animations: "disabled" });

  // ── 覆盖层：互斥、窄屏全宽、无横向溢出（规格 §7 / §12.12）────────────────
  for (const [width, height] of [[960, 800], [768, 900], [767, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.locator(".panel-overlay-right").waitFor();
    assert.equal(await noHorizontalOverflow(page), true);
    if (width < 768) {
      const overlay = await page.locator(".panel-overlay-right").boundingBox();
      assert.ok(overlay && Math.abs(overlay.width - width) <= 1, JSON.stringify({ width, overlay }));
    }
    await page.getByRole("button", { name: "展开会话栏" }).click();
    await page.locator(".panel-overlay-left").waitFor();
    assert.equal(await page.locator(".panel-overlay-right").count(), 0, "compact overlays are mutually exclusive");
    assert.equal(await noHorizontalOverflow(page), true);
    await page.screenshot({ path: `${output}/compact-${width}.png`, animations: "disabled" });
    // 用确定性的标题栏开关关闭覆盖层（窄屏下覆盖层占满宽度，没有可点的遮罩区域）
    await page.getByRole("button", { name: "收起会话栏" }).click();
    await page.locator(".panel-overlay-left").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "展开右侧工作区" }).click();
    await page.locator(".panel-overlay-right").waitFor();
  }

  // ── 深色主题同样无溢出（规格 §11.1）─────────────────────────────────────
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  assert.equal(await noHorizontalOverflow(page), true);
  await page.screenshot({ path: `${output}/dark-390.png`, animations: "disabled" });

  // ── 键盘可达与可操作（规格 §11.2 / §11.4）────────────────────────────────
  // 回到桌面宽度：窄断点期间的临时开合不得污染桌面偏好，保存的开合状态原样回来
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.locator(".workbench-shell").waitFor();
  const workbenchToggle = page.getByRole("button", { name: "收起右侧工作区" });
  await workbenchToggle.focus();
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    "收起右侧工作区",
    "the workbench entry must be keyboard focusable",
  );
  await page.keyboard.press("Enter");
  await page.locator(".workbench-shell").waitFor({ state: "detached" });
  await page.keyboard.press("Enter");
  await page.locator(".workbench-shell").waitFor();
  assert.equal(await noHorizontalOverflow(page), true);

  const separator = page.getByRole("separator", { name: "调整右侧工作区宽度" });
  await separator.focus();
  const widthBeforeKeys = Number(await separator.getAttribute("aria-valuenow"));
  await page.keyboard.press("ArrowLeft");
  assert.equal(Number(await separator.getAttribute("aria-valuenow")), widthBeforeKeys + 16, "separator is keyboard operable");

  const composerInput = page.getByRole("textbox", { name: "消息" });
  await composerInput.focus();
  await page.keyboard.type("keyboard input");
  assert.equal(await composerInput.inputValue(), "keyboard input", "composer accepts keyboard input");
  assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isEnabled(), true, "typing enables send");
  // 文案以规格 2 为准：附件入口的按钮叫「添加文件」（另有「更多添加方式」）。
  // 规格 1 落地时它叫「添加附件」，规格 2 重做入口时改了名——两个规格各自在自己的
  // 分支上跑绿，合并后才在这里撞出来。
  for (const label of ["添加文件", "运行配置"]) {
    assert.equal(await page.getByRole("button", { name: label, exact: true }).count(), 1, `${label} must be a named button`);
  }
  const taskRow = page.locator(".task-row").first();
  await taskRow.focus();
  assert.equal(await taskRow.evaluate((element) => element === document.activeElement), true, "task rows are keyboard focusable");

  // ── 字号与触达区（规格 §6.3 / §12.9 / §12.10）────────────────────────────
  const metrics = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector)?.getBoundingClientRect();
    const fontSize = (selector) => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
    return {
      send: box(".chat-primary-action"),
      titlebar: box(".titlebar-button"),
      readSummary: fontSize(".chat-read-context summary"),
      composer: fontSize(".chat-composer textarea"),
      body: fontSize(".chat-text-block > div:first-child"),
    };
  });
  assert.ok(metrics.send && metrics.send.width >= 32 && metrics.send.height >= 32, `send hit area ${JSON.stringify(metrics.send)}`);
  assert.ok(metrics.titlebar && metrics.titlebar.width >= 28 && metrics.titlebar.height >= 28, `titlebar hit area ${JSON.stringify(metrics.titlebar)}`);
  assert.ok(metrics.readSummary >= 12, `supporting text must be >= 12px: ${metrics.readSummary}`);
  assert.ok(metrics.composer >= 14, `composer type ${metrics.composer}px`);
  assert.ok(metrics.body >= 14, `conversation body type ${metrics.body}px`);

  // ── 视觉验收截图矩阵（规格 §11.1 / §12.16）───────────────────────────────
  // 8 个关键宽度 × 浅/深主题。全部取「会话优先」默认态：桌面收起工作台，窄断点
  // 不留覆盖层——这正是规格要证明的「会话是页面最宽且最清晰的区域」。
  if (await page.locator(".workbench-shell").count()) {
    await page.getByRole("button", { name: /右侧工作区/ }).click();
    await page.locator(".workbench-shell").waitFor({ state: "detached" });
  }
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const [width, height] of [[1600, 900], [1440, 900], [1180, 900], [1179, 900], [960, 800], [768, 900], [767, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.locator(".workbench-shell").count(), 0, `${theme}/${width}: default state keeps the workbench closed`);
      assert.equal(await page.locator(".panel-overlay").count(), 0, `${theme}/${width}: default state shows no overlay`);
      assert.equal(await noHorizontalOverflow(page), true, `${theme}/${width} must not scroll horizontally`);
      await page.screenshot({ path: `${output}/matrix-${theme}-${width}.png`, animations: "disabled" });
    }
  }

  assert.deepEqual(errors, []);
  console.log("PASS: conversation-first hierarchy, single reading axis, radius tokens, desktop sizing, compact overlay exclusivity, keyboard reachability, overflow across breakpoints and themes");
} finally {
  await browser.close();
}
