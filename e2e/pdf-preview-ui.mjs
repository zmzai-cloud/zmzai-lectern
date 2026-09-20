import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { assertServingThisBuild } from "./serve-guard.mjs";

/** 二进制产物的预览路径（PDF 渲染挂掉的那一次）。
 *
 *  【这一层钉的是什么】用户看到的症状是「PDF 渲染直接跪了」：任务交付了一份
 *  ReportLab 生成的贴纸页 PDF，点开却是一屏 `/BaseFont /STSong-Light /W [ 1 [
 *  207 270 342 … ] ]` 的源码。根因有两条，都在渲染进程这一侧显形：
 *
 *  ① 文件 Tab 把二进制当文本打开了——旧判据是 `buf.includes(0)`，而这份 PDF 零 NUL、
 *     99.97% 可打印 ASCII（单测 `lib/file-content.test.ts` 钉的就是这条判据）；
 *  ② 成果预览只认 HTML，于是「打开成果」对一份 PDF 只能给出空态，产物卡点击也只能
 *     落到文件 Tab。
 *
 *  【为什么是浏览器 E2E 而不是单测】单测钉得住判据与路由的返回体，钉不住「点击产物
 *  卡之后工作台落在哪个 tab、画布给出的 iframe 长什么样」——那正是用户看到的那一屏。
 *  至于 PDF 最终有没有被画出来：Chromium 内建阅读器在 headless 下的行为无保证，
 *  这里不假装断言像素，改用真实 Electron 单独实测（Electron 44 上 `<iframe src=…pdf>`
 *  不带 sandbox 能出页面，带 sandbox 恒白屏——见 CanvasPane 的文件头说明）。
 *
 *  【在跑的】产物卡点击 → 成果预览 tab + 指向 .pdf 的无 sandbox iframe；
 *  文件 Tab 打开同一份 PDF → 占位而不是源码。 */

const url = process.env.LECTERN_TEST_URL || "http://127.0.0.1:3106";
const output = process.env.LECTERN_UI_OUTPUT || "test-results/pdf-preview";
mkdirSync(output, { recursive: true });

const SES = "pdf-preview";
const PDF_PATH = "packages/vehicles/dist/xiaoman-vehicles-sticker-sheet.pdf";

/** 手工拼一份**结构合法**的最小 PDF（带真实 xref 表）。
 *
 *  【为什么不用一段 "%PDF-1.4 …" 就完事】浏览器内建阅读器会先解析再决定画什么：
 *  交叉引用表坏了它就只画一句「未能加载 PDF 文档」。那样这份用例就只能证明「iframe
 *  起来了」，证明不了「阅读器认了这份文件」——而后者才是用户说的「渲染」。 */
function buildPdf() {
  const content = "BT /F1 24 Tf 40 120 Td (Xiaoman Vehicles - Sticker Sheet) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const PDF = buildPdf();

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
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

  /** 画布到底向服务端要了哪个 URL（含内容类型），记下来当断言材料。 */
  const previewHits = [];
  const fsFileHits = [];

  const session = { id: SES, title: "PDF 预览验收", agent: "default", model: { providerId: "openai", modelId: "test" }, time: { created: "2026-09-20T00:00:00Z" } };
  const transcript = [
    { info: { id: "u1", role: "user", sessionId: SES }, messageSeq: 1, parts: [{ id: "u1-text", messageId: "u1", sessionId: SES, type: "text", text: "把贴纸页导成 PDF" }] },
    { info: { id: "a1", role: "assistant", sessionId: SES }, messageSeq: 2, parts: [{ id: "a1-text", messageId: "a1", sessionId: SES, type: "text", text: "导好了。" }] },
  ];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const parsed = new URL(request.url());
    const path = parsed.pathname;

    if (path.startsWith("/api/preview/")) {
      previewHits.push({ url: path, contentType: "application/pdf" });
      await route.fulfill({ body: PDF, headers: { "content-type": "application/pdf", "x-content-type-options": "nosniff" } });
      return;
    }
    if (path === "/api/fs/file") {
      const target = parsed.searchParams.get("path") ?? "";
      fsFileHits.push(target);
      if (target.endsWith(".pdf")) {
        // 服务端现在的真实返回：**200 + binary**，不是 4xx（二进制不是错误，见路由注释）。
        await route.fulfill({ json: { path: target, size: PDF.length, content: "", binary: true, mediaType: "application/pdf" } });
        return;
      }
      await route.fulfill({ json: { path: target, size: 20, content: "export const a = 1;\n", binary: false, mediaType: "text/plain" } });
      return;
    }
    if (path === "/api/sessions") return route.fulfill({ json: [session] });
    if (path === `/api/sessions/${SES}/messages`) {
      return route.fulfill({ json: { messages: transcript, beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0 } });
    }
    if (path.endsWith("/worktree")) return route.fulfill({ json: { enabled: false } });
    if (path === "/api/auth/status") return route.fulfill({ json: { loggedIn: true, user: { name: "PDF QA" } } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], authenticated: true } });
    if (path === "/api/skills") return route.fulfill({ json: { skills: [] } });
    if (path === "/api/settings/permissions") return route.fulfill({ json: { permissions: {} } });
    if (path === "/api/projects") return route.fulfill({ json: { projects: [], activeId: "default" } });
    return route.fulfill({ json: {} });
  });

  // 先验证被测服务就是本仓这次的构建——否则下面所有断言都在比一份别的产物。
  await assertServingThisBuild(page, url);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByText("PDF 预览验收", { exact: true }).click();
  await page.locator(".chat-assistant-message").first().waitFor();
  await page.waitForFunction(() => (window.__streams ?? []).length > 0);

  await page.evaluate(({ path }) => {
    const stream = window.__streams.at(-1);
    let seq = 0;
    const frame = (type, data) => stream.onmessage({ data: JSON.stringify({ sessionId: "pdf-preview", seq: ++seq, type, data }) });
    // 产物（artifact.created）与「动过的文件」（file.edited）是两条独立投影：
    // 一次「跑脚本生成 PDF」的交付里，产物清单上是那份 PDF，编辑路径上是脚本。
    frame("file.edited", { path, diff: "@@ +1,1 @@" });
    frame("artifact.created", {
      artifactId: "art_pdf_1",
      path,
      bytes: 11845,
      contentType: "application/pdf",
      downloadUrl: `/api/preview/_/${path}?download=1`,
    });
    frame("session.summary", { text: "贴纸页已导出为 PDF。", kind: "completed", meta: { filesEdited: 1, toolCalls: 2, durationMs: 800 } });
  }, { path: PDF_PATH });

  // 1) 产物卡在「本轮产物」里出现
  const artifactCard = page.getByTitle(`${PDF_PATH} · 点击打开`);
  await artifactCard.waitFor();

  // 2) 点它 → 落到成果预览，而不是文件 Tab（旧行为在这里把用户送到源码前面）
  await artifactCard.click();
  const previewTab = page.locator("#wb-tab-preview");
  await previewTab.waitFor();
  assert.equal(await previewTab.getAttribute("aria-selected"), "true", "点击产物卡应落到成果预览");

  const pdfFrame = page.locator("iframe[data-canvas-pdf]");
  await pdfFrame.waitFor();
  const src = await pdfFrame.getAttribute("src");
  assert.ok(src?.includes("/api/preview/") && src.includes(".pdf"), `画布的 src 应指向该 PDF：${src}`);
  assert.equal(
    await pdfFrame.getAttribute("sandbox"),
    null,
    "PDF 的 iframe 不能带 sandbox——实测带上去只有白屏",
  );
  assert.ok(previewHits.some((hit) => hit.url.endsWith(".pdf")), "画布应向预览路由请求过这份 PDF");

  // 2b) 浏览器把这一帧交给了内建 PDF 阅读器——不是当下载，也不是当文本。
  //
  // 【这一条能证到哪、证不到哪】阅读器跑在插件进程里，它的页面（含页内文字）
  // 从 JS 侧取不到：能观测到的是「帧的 document 是 PDF 阅读器的嵌入页」。
  // 阅读器有没有把内文画出来，本用例断言不了，也不假装断言——那条走真实 Electron
  // 的像素统计（见文件头说明）。
  await page.waitForFunction(() => {
    const doc = document.querySelector("iframe[data-canvas-pdf]")?.contentDocument;
    return Boolean(doc && [...doc.querySelectorAll("link")].some((l) => (l.getAttribute("href") ?? "").includes("pdf_embedder")));
  }, undefined, { timeout: 15_000 });
  const viewer = await page.evaluate(() => {
    const doc = document.querySelector("iframe[data-canvas-pdf]")?.contentDocument;
    return { contentType: doc?.contentType ?? null, title: doc?.title ?? null };
  });
  assert.equal(viewer.contentType, "application/pdf", "iframe 的文档类型应是 PDF（否则会被当下载）");
  await page.screenshot({ path: `${output}/preview-tab.png`, animations: "disabled" });

  // 3) 文件 Tab 打开同一份 PDF：占位，而不是把字节摊成源码。
  //    「本轮改动」chips 是 button[title=完整路径]——产物卡里同名的那个是 span，
  //    所以这里必须限定 button。
  await page.locator("#wb-tab-files").click();
  const chip = page.locator(`button[title="${PDF_PATH}"]`);
  await chip.waitFor();
  await chip.click();
  await page.getByText("这不是文本文件，编辑器不打开它").waitFor();
  assert.ok(fsFileHits.includes(PDF_PATH), "文件 Tab 应向 fs/file 请求过这个路径");
  const body = await page.locator("body").innerText();
  assert.ok(!body.includes("/BaseFont"), "PDF 源码不能出现在界面上");
  assert.ok(!body.includes("%PDF-1.4"), "PDF 文件头不能出现在界面上");
  assert.equal(await page.locator(".cm-editor").count(), 0, "二进制文件不该开编辑器");
  // 占位里给出的那条路要真的能走回去
  assert.ok(body.includes("在成果预览中打开"), "占位要给出去成果预览的路");

  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${output}/pdf-preview.png`, animations: "disabled" });
  console.log("PASS: PDF 产物进成果预览（无 sandbox 的 iframe）、文件 Tab 给占位而不是源码");
} finally {
  await browser.close();
}
