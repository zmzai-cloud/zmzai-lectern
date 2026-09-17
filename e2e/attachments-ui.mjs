import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

/**
 * 附件入口与卡片状态机验收（规格 2 §7 / §14 / §17.1 / §17.3 / §18）。
 *
 * 【这一层测什么、不测什么】上传协议、嗅探、解析、归属校验由单测覆盖（含走真实
 * PDF/Office 解析器的端到端管线）。这里要证的是**渲染进程**那一半：三条入口
 * （选择/粘贴/拖放）产出的是不是同一张卡、失败时用户能不能看懂原因并重试、
 * 发不出去时草稿会不会被清掉。边界就这样画，所以这里的 API 是 mock 的。
 *
 * 【关于跨平台】这里跑 Chromium——Electron 的渲染进程就是 Chromium，所以覆盖的是
 * 同一份实现。macOS Finder 的原生「复制文件」与 Windows Explorer 的剪贴板格式在这个
 * 环境里无法自动化，**未纳入断言**，验收报告里如实标为未验证，不假装跑过。
 */

const SES = "ses_attach";
const BASE = process.env.LECTERN_TEST_URL || "http://127.0.0.1:3100";
mkdirSync(process.env.LECTERN_UI_OUTPUT || "test-results/attachments", { recursive: true });

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001",
  "hex",
);

const errors = [];
const prompts = [];
const deletes = [];
/** 上传与发送的返回由用例改写。 */
let uploadStatus = 200;
let uploadReceiptStatus = "ready";
let promptStatus = 200;
/** 上传回执上记的文件名从 multipart 正文里取（服务端记录的就是这个名字）。 */
let uploadSeq = 0;
let lastReceipt = null;
/** GET 单个附件依次返回的状态，用来模拟「解析中 → 就绪」。 */
let attachmentStatuses = [];

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.removeItem("lectern.task-layout");
    localStorage.removeItem("lectern:task-layout");
    window.EventSource = class { close() {} };
    // 对象 URL 的创建与回收都要能被观察到（规格 §17.1.8）
    window.__objectUrls = { created: [], revoked: [] };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const url = create(blob); window.__objectUrls.created.push(url); return url; };
    URL.revokeObjectURL = (url) => { window.__objectUrls.revoked.push(url); return revoke(url); };
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === "/api/sessions") {
      return route.fulfill({
        json: [{ id: SES, title: "附件验收", agent: "default", model: { providerId: "openai", modelId: "gpt-test" }, time: { created: "2026-09-17T00:00:00Z" } }],
      });
    }
    if (path === `/api/sessions/${SES}/messages`) {
      return route.fulfill({ json: { messages: [], beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0 } });
    }
    if (method === "POST" && /\/attachments$/.test(path)) {
      if (uploadStatus !== 200) return route.fulfill({ status: uploadStatus, json: { error: "上传失败", code: "server" } });
      // multipart 正文里有 `filename="…"`：服务端记录的名字就是这个
      const raw = request.postDataBuffer()?.toString("latin1") ?? "";
      const name = /filename="([^"]*)"/.exec(raw)?.[1] ?? "file";
      lastReceipt = {
        attachmentId: `att_${String((uploadSeq += 1)).padStart(4, "0")}`,
        filename: name,
        mediaType: "application/pdf",
        size: PDF.byteLength,
        sha256: "0".repeat(64),
        kind: name.endsWith(".png") ? "image" : "document",
        status: uploadReceiptStatus,
      };
      return route.fulfill({ json: { ok: true, attachment: lastReceipt } });
    }
    if (method === "GET" && /\/attachments\/[^/]+$/.test(path)) {
      const status = attachmentStatuses.length > 0 ? attachmentStatuses.shift() : "ready";
      return route.fulfill({ json: { attachment: { ...lastReceipt, status }, availability: true } });
    }
    if (method === "DELETE" && /\/attachments\/[^/]+$/.test(path)) {
      deletes.push(path);
      return route.fulfill({ json: { ok: true } });
    }
    if (path === `/api/sessions/${SES}/prompt`) {
      const body = request.postDataJSON();
      prompts.push(body);
      if (promptStatus !== 200) return route.fulfill({ status: promptStatus, json: { error: "模型服务暂时不可用，请稍后重试" } });
      return route.fulfill({ json: { requestId: "req_e2e", userMessageId: `msg_${prompts.length}` } });
    }
    if (path.endsWith("/worktree")) return route.fulfill({ json: { enabled: false } });
    if (path === "/api/auth/status") return route.fulfill({ json: { loggedIn: true, user: { name: "Attachment QA" } } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], authenticated: true } });
    if (path === "/api/skills") return route.fulfill({ json: { skills: [] } });
    if (path === "/api/settings/permissions") return route.fulfill({ json: { permissions: {} } });
    if (path === "/api/projects") return route.fulfill({ json: { projects: [], activeId: "default" } });
    return route.fulfill({ json: {} });
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.getByText("附件验收", { exact: true }).click();
  await page.locator(".chat-composer").waitFor();
  return page;
}

const composer = (page) => page.locator(".chat-composer");
const textarea = (page) => page.locator('textarea[aria-label="消息"]');
const cards = (page) => page.locator('ul[aria-label^="待发送附件"] > li');
const sendButton = (page) => page.locator('button[aria-label="发送"]');
const notice = (page) => page.locator('p[role="status"]');

const waitCardStatus = (page, status) =>
  page.waitForFunction((expected) => document.querySelector('ul[aria-label^="待发送附件"] li')?.dataset.status === expected, status);

/**
 * 在页面里造一个 DataTransfer 并派发粘贴或拖放。
 *
 * 【为什么事件在页面里造而不是用 dispatchEvent 的 init】Chromium 的 `ClipboardEvent`
 * 构造器不认 init 里的 `clipboardData`（实测构造出来是 null），只能构造完再用
 * `defineProperty` 补上。`DragEvent` 两种都行，但统一走同一条路少一个变量。
 */
function dispatchFiles(page, type, selector, entries) {
  return page.evaluate(
    ({ type, selector, entries }) => {
      const transfer = new DataTransfer();
      for (const entry of entries) {
        if (entry.text !== undefined) transfer.setData("text/plain", entry.text);
        else {
          const bytes = entry.fill === undefined ? new Uint8Array(entry.bytes) : new Uint8Array(entry.length).fill(entry.fill);
          transfer.items.add(new File([bytes], entry.name, { type: entry.type ?? "" }));
        }
      }
      const event = type === "paste"
        ? new ClipboardEvent("paste", { bubbles: true, cancelable: true })
        : new DragEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", { value: transfer });
      document.querySelector(selector).dispatchEvent(event);
    },
    { type, selector, entries },
  );
}

/** 卡片的可比较指纹：三条入口产出的必须是同一张卡；颜色与 DOM 细节不算。 */
async function cardFingerprints(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('ul[aria-label^="待发送附件"] > li')].map((item) => ({
      name: item.querySelector("[title]")?.getAttribute("title") ?? "",
      meta: item.querySelectorAll("span.block")[1]?.textContent?.trim() ?? "",
      icon: (item.querySelector("svg")?.getAttribute("class") ?? "").match(/lucide-[a-z-]+/)?.[0] ?? "",
      status: item.getAttribute("data-status"),
    })),
  );
}

async function removeAll(page) {
  while ((await cards(page).count()) > 0) await page.locator('button[aria-label^="移除 "]').first().click();
  await page.waitForFunction(() => document.querySelectorAll('ul[aria-label^="待发送附件"] > li').length === 0);
}

/** 恢复默认，避免用例之间互相污染。 */
function resetPlan() {
  uploadStatus = 200;
  uploadReceiptStatus = "ready";
  promptStatus = 200;
  attachmentStatuses = [];
}

const results = [];
function check(label, condition, detail) {
  results.push({ label, ok: Boolean(condition) });
  assert.ok(condition, `${label}${detail === undefined ? "" : ` — ${detail}`}`);
}

try {
  // ── §18.2 回形针表达「添加文件」，且「引用项目文件」可被发现 ─────────────
  {
    resetPlan();
    const page = await openPage();
    const paperclip = page.locator('button[aria-label="添加文件"]').first();
    check("回形针的提示写着「添加文件」", (await paperclip.getAttribute("title")) === "添加文件");
    // 主按钮直接开选择器（省一次点击）；相邻箭头展开两种入口
    await page.locator('button[aria-label="更多添加方式"]').click();
    const menu = page.locator('[role="menu"][aria-label="添加文件"]');
    await menu.waitFor();
    const items = await menu.locator('[role="menuitem"]').allInnerTexts();
    check("菜单里「引用项目文件」与「从电脑选择」并列，不必去别处找", items.join("|").includes("从电脑选择") && items.join("|").includes("引用项目文件"), items.join("|"));
    // 文件选择器的 accept 来自唯一格式表，不再只写图片
    const accept = await page.locator('input[type="file"]').getAttribute("accept");
    check("accept 覆盖 PDF 与 Office 而不只是图片", accept.includes(".pdf") && accept.includes(".docx") && accept.includes(".pptx"), accept);
    await page.close();
  }

  // ── §18.1 三条入口产出一致的附件卡；§7.5 / §18.4 只有附件也能发送 ──────
  {
    resetPlan();
    const page = await openPage();
    const fingerprints = [];
    const FILE = [{ name: "合同.pdf", type: "application/pdf", bytes: [...PDF] }];

    await page.setInputFiles('input[type="file"]', { name: "合同.pdf", mimeType: "application/pdf", buffer: PDF });
    await waitCardStatus(page, "ready");
    fingerprints.push(await cardFingerprints(page));

    await removeAll(page);
    await dispatchFiles(page, "paste", 'textarea[aria-label="消息"]', FILE);
    await waitCardStatus(page, "ready");
    fingerprints.push(await cardFingerprints(page));

    await removeAll(page);
    await dispatchFiles(page, "dragover", ".chat-composer", FILE);
    await page.waitForFunction(() => document.querySelector(".chat-composer")?.getAttribute("data-dropping") === "true");
    const dropActive = "true";
    await dispatchFiles(page, "drop", ".chat-composer", FILE);
    await waitCardStatus(page, "ready");
    fingerprints.push(await cardFingerprints(page));

    check("拖入文件时出现 drop target", dropActive === "true", String(dropActive));
    check(
      "选择 / 粘贴 / 拖放产出同一张卡",
      JSON.stringify(fingerprints[0]) === JSON.stringify(fingerprints[1]) && JSON.stringify(fingerprints[1]) === JSON.stringify(fingerprints[2]),
      JSON.stringify(fingerprints),
    );
    check("卡片给出格式与可读大小", /\d/.test(fingerprints[0][0]?.meta ?? ""), fingerprints[0][0]?.meta);

    check("只有附件没有文字时发送按钮可用", await sendButton(page).isEnabled());
    await sendButton(page).click();
    await page.waitForFunction(() => document.querySelectorAll('ul[aria-label^="待发送附件"] > li').length === 0);
    const body = prompts.at(-1);
    check("prompt 只提交 attachment id", Array.isArray(body?.attachmentIds) && body.attachmentIds.length === 1, JSON.stringify(body));
    const serialized = JSON.stringify(body);
    check("载荷里没有本地绝对路径", !/\/Users\/|[A-Za-z]:\\\\/.test(serialized), serialized);
    check("载荷里没有 base64 原文", !serialized.includes("base64") && !serialized.includes("JVBERi"), serialized);
    check("只有附件时正文不插入伪文字", !body?.text, JSON.stringify(body?.text));
    await page.close();
  }

  // ── §7.2.4 粘贴文件与文字同时存在时，文字不丢 ──────────────────────────
  {
    resetPlan();
    const page = await openPage();
    await dispatchFiles(page, "paste", 'textarea[aria-label="消息"]', [
      { name: "合同.pdf", type: "application/pdf", bytes: [...PDF] },
      { text: "这是我附在文件旁的说明" },
    ]);
    await waitCardStatus(page, "ready");
    check("粘贴文件时保留同时存在的文字", (await textarea(page).inputValue()).includes("这是我附在文件旁的说明"), await textarea(page).inputValue());
    check("粘贴的纯文本说明不产生第二张卡", (await cards(page).count()) === 1);
    await page.close();
  }

  // ── §18.8 超限与不支持的格式各给具体原因，不静默丢文件 ─────────────────
  {
    resetPlan();
    const page = await openPage();

    await dispatchFiles(page, "paste", 'textarea[aria-label="消息"]', [
      { name: "很长的记录.txt", type: "text/plain", length: 2.5 * 1024 * 1024, fill: 97 },
    ]);
    await notice(page).waitFor();
    const oversizeText = await notice(page).innerText();
    check("超限文件点名上限值", oversizeText.includes("2.0MB"), oversizeText);
    check("被拒的文件不进附件列表", (await cards(page).count()) === 0);

    await page.waitForFunction(() => document.querySelector('p[role="status"]') === null);
    await dispatchFiles(page, "paste", 'textarea[aria-label="消息"]', [{ name: "setup.exe", type: "application/octet-stream", bytes: [1, 2, 3, 4] }]);
    await notice(page).waitFor();
    const unsupportedText = await notice(page).innerText();
    check("不支持的格式点名扩展名与文件名", unsupportedText.includes(".exe") && unsupportedText.includes("setup.exe"), unsupportedText);
    await page.close();
  }

  // ── §18.9 上传失败可单独重试；未就绪时发送被拦并说明原因 ────────────────
  {
    resetPlan();
    const page = await openPage();
    uploadStatus = 500;
    await page.setInputFiles('input[type="file"]', { name: "合同.pdf", mimeType: "application/pdf", buffer: PDF });
    await waitCardStatus(page, "error");
    check("上传失败后卡片保留并标为失败", (await cards(page).count()) === 1);
    check("失败卡片给出重试入口", (await page.locator('button[aria-label^="重试上传 "]').count()) === 1);
    check("有失败附件时发送被拦", !(await sendButton(page).isEnabled()));
    const blocked = await sendButton(page).getAttribute("title");
    check("发送被拦时说明该怎么处理", /重试或移除/.test(blocked ?? ""), blocked);

    uploadStatus = 200;
    await page.locator('button[aria-label^="重试上传 "]').click();
    await waitCardStatus(page, "ready");
    check("重试成功后转为就绪且没有多出附件", (await cards(page).count()) === 1);
    check("重试后发送恢复可用", await sendButton(page).isEnabled());
    await page.close();
  }

  // ── §18.9 发送失败时文字与附件完整保留，重试不重复上传 ─────────────────
  {
    resetPlan();
    const page = await openPage();
    await page.setInputFiles('input[type="file"]', { name: "合同.pdf", mimeType: "application/pdf", buffer: PDF });
    await waitCardStatus(page, "ready");
    await textarea(page).fill("看一下这份合同");
    const uploadsBefore = uploadSeq;

    promptStatus = 500;
    await sendButton(page).click();
    await notice(page).waitFor();
    check("发送失败后文字保留", (await textarea(page).inputValue()) === "看一下这份合同", await textarea(page).inputValue());
    check("发送失败后附件保留", (await cards(page).count()) === 1);
    check("发送失败把服务端原因告诉用户", (await notice(page).innerText()).includes("模型服务暂时不可用"), await notice(page).innerText());

    promptStatus = 200;
    await sendButton(page).click();
    await page.waitForFunction(() => document.querySelectorAll('ul[aria-label^="待发送附件"] > li').length === 0);
    check("重试发送不重复上传文件", uploadSeq === uploadsBefore, `${uploadsBefore} → ${uploadSeq}`);
    check("发送成功后清空文字", (await textarea(page).inputValue()) === "");
    await page.close();
  }

  // ── §7.5 解析中：按钮说明原因，解析完成后自动放行 ─────────────────────
  {
    resetPlan();
    const page = await openPage();
    uploadReceiptStatus = "processing";
    attachmentStatuses = ["processing", "processing", "ready"];
    await page.setInputFiles('input[type="file"]', { name: "大合同.pdf", mimeType: "application/pdf", buffer: PDF });
    await waitCardStatus(page, "processing");
    check("解析中的卡片写明「解析中」", (await cards(page).innerText()).includes("解析中"), await cards(page).innerText());
    check("解析中时发送按钮不可用", !(await sendButton(page).isEnabled()));
    const reason = await sendButton(page).getAttribute("title");
    check("解析中给出等待原因", /正在处理/.test(reason ?? ""), reason);
    await page.waitForFunction(() => document.querySelector('ul[aria-label^="待发送附件"] li')?.dataset.status === "ready", null, { timeout: 20_000 });
    check("解析完成后自动放行发送", await sendButton(page).isEnabled());
    await page.close();
  }

  // ── §18.12 图片能力无回归；§17.1.8 / §14 移除图片回收对象 URL 并删除草稿 ─
  {
    resetPlan();
    const page = await openPage();
    await page.setInputFiles('input[type="file"]', { name: "截图.png", mimeType: "image/png", buffer: PNG });
    await waitCardStatus(page, "ready");
    check("图片附件显示缩略图", (await page.locator('ul[aria-label^="待发送附件"] img').count()) === 1);
    check("图片附件产出了对象 URL", (await page.evaluate(() => window.__objectUrls.created.length)) === 1);
    const deletedBefore = deletes.length;
    await page.locator('button[aria-label^="移除 "]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('ul[aria-label^="待发送附件"] > li').length === 0);
    check("移除后对象 URL 被回收", (await page.evaluate(() => window.__objectUrls.revoked.length)) === 1, JSON.stringify(await page.evaluate(() => window.__objectUrls)));
    // 已上传但未绑定的附件要真删掉，否则会留在存储里等 TTL 过期（规格 §14）
    check(
      "移除未发送的附件会删掉服务端草稿附件",
      deletes.length === deletedBefore + 1 && deletes.at(-1)?.endsWith(lastReceipt.attachmentId),
      JSON.stringify(deletes),
    );
    await page.close();
  }

  resetPlan();
  check("页面运行期没有未捕获错误", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
}

console.log(`\n附件入口与卡片状态机：${results.length} 项断言全部通过`);
for (const result of results) console.log(`  ✓ ${result.label}`);
