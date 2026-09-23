/** W1 后 V1-S3：Electron 主进程浏览器 verifier（V1 设计 §1.2）。
 *
 *  Host 纯逻辑层（lib/browser-verification.ts）经 lib/browser-verifier-adapter.ts
 *  转发到本 endpoint。驱动 = Electron 自带 Chromium（零新依赖）：
 *  - 隐藏 BrowserWindow + 独立 partition（非 persist：每次验证全新内存态——
 *    spec §11.2.3「默认新建隔离 browser context」；显式复用登录 profile 属后续授权面）
 *  - 结构化操作/断言 = webContents.executeJavaScript（DOM/Accessibility 查询，
 *    绝不靠截图肉眼判定功能）
 *  - console error / 失败资源采集 = console-message / did-fail-resource-load 事件
 *  - 截图 = webContents.capturePage → base64（Host 侧落盘为证据附件）
 *
 *  通道：node:http + Bearer token（bootstrap 文件由调用方写——main.cjs）。
 *  真实浏览器行为验证在 V1-S5 e2e（Electron 模式）；本文件保持 node --check
 *  可过的纯 CommonJS。 */
const http = require("node:http");
const crypto = require("node:crypto");

/** @type {Map<string, {win: import("electron").BrowserWindow, consoleErrors: number, resourceFailures: number}>} */
const contexts = new Map();

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    return {};
  }
}

/** 结构化 DOM 操作/断言脚本（返回 JSON 字符串，杜绝序列化歧义）。
 *  click/type/assert_dom/assert_visual（首版机器可判定子集：存在/可见/文本）。 */
function domScript(step) {
  const target = String(step.target ?? "");
  const value = String(step.value ?? "");
  const expr = step.kind;
  return `(async () => {
    const target = ${JSON.stringify(target)};
    const value = ${JSON.stringify(value)};
    const kind = ${JSON.stringify(expr)};
    const el = target ? document.querySelector(target) : null;
    if (kind === "click") {
      if (!el) return { status: "failed", detail: "元素不存在：" + target };
      el.scrollIntoView({ block: "center" });
      el.click();
      return { status: "passed" };
    }
    if (kind === "type") {
      if (!el) return { status: "failed", detail: "元素不存在：" + target };
      el.focus?.();
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { status: "passed" };
    }
    if (kind === "assert_dom") {
      if (!el) return { status: "failed", detail: "断言失败：元素不存在 " + target };
      if (value && !((el.textContent || "")).includes(value)) {
        return { status: "failed", detail: "断言失败：" + target + " 文本不含 " + value };
      }
      return { status: "passed" };
    }
    if (kind === "assert_visual") {
      // 首版机器可判定子集（V1 设计 R-3）：可见性 + 尺寸；模型观察项不在此
      if (!el) return { status: "failed", detail: "断言失败：元素不存在 " + target };
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
      if (!visible) return { status: "failed", detail: "断言失败：" + target + " 不可见" };
      return { status: "passed", detail: JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) }) };
    }
    if (kind === "wait") {
      // target 选择器出现等待（默认 5s 上限，value 可传毫秒）
      const limit = Number(value) > 0 ? Number(value) : 5000;
      const t0 = Date.now();
      while (Date.now() - t0 < limit) {
        if (document.querySelector(target)) return { status: "passed" };
        await new Promise((r) => setTimeout(r, 100));
      }
      return { status: "failed", detail: "等待超时：" + target };
    }
    return { status: "unavailable", detail: "未知步骤类型：" + kind };
  })()`;
}

async function runStep(ctx, step, serviceOrigin) {
  const wc = ctx.win.webContents;
  const beforeErrors = ctx.consoleErrors;
  try {
    if (step.kind === "goto") {
      const url = /^https?:\/\//.test(String(step.target ?? "")) ? String(step.target) : `${serviceOrigin ?? ""}${step.target ?? "/"}`;
      if (!/^https?:\/\//.test(url)) return { status: "unavailable", detail: "无 serviceOrigin 且 target 非绝对 URL" };
      await wc.loadURL(url);
      return { status: "passed", detail: url };
    }
    const raw = await wc.executeJavaScript(domScript(step), true);
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      status: parsed.status === "passed" || parsed.status === "failed" ? parsed.status : "unavailable",
      ...(parsed.detail ? { detail: String(parsed.detail).slice(0, 240) } : {}),
      consoleErrors: ctx.consoleErrors - beforeErrors,
    };
  } catch (error) {
    return { status: "unavailable", detail: String(error?.message ?? error).slice(0, 240), consoleErrors: ctx.consoleErrors - beforeErrors };
  }
}

/** 起 verifier endpoint；返回 { server, port, token, closeAll() }。
 *  bootstrap 文件由 main.cjs 写（与 host.json 同目录同模式）。 */
async function startVerifierServer() {
  const { BrowserWindow } = require("electron");
  const token = crypto.randomBytes(32).toString("hex");

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "unauthorized" });
    const body = await readBody(req);

    if (req.method === "POST" && req.url === "/context/open") {
      const { contextKey, viewport } = body;
      if (!contextKey) return send(res, 400, { error: "contextKey 必填" });
      try {
        const win = new BrowserWindow({
          show: false,
          width: viewport?.width ?? 1280,
          height: viewport?.height ?? 800,
          webPreferences: {
            // 非 persist partition：每次验证全新内存态 context（spec §11.2.3）
            partition: `lectern-verify-${String(contextKey).replace(/[^A-Za-z0-9_-]/g, "_")}`,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        const ctx = { win, consoleErrors: 0, resourceFailures: 0 };
        win.webContents.on("console-message", (_e, level) => {
          // Electron level：0 verbose /1 info /2 warning /3 error
          if (Number(level) >= 2) ctx.consoleErrors += 1;
        });
        win.webContents.on("did-fail-resource-load", () => { ctx.resourceFailures += 1; });
        const id = `bctx_${crypto.randomBytes(8).toString("hex")}`;
        contexts.set(id, ctx);
        return send(res, 200, { browserContextId: id });
      } catch (error) {
        return send(res, 500, { reason: String(error?.message ?? error) });
      }
    }

    if (req.method === "POST" && req.url === "/step") {
      const ctx = contexts.get(String(body.browserContextId ?? ""));
      if (!ctx) return send(res, 404, { error: "context 不存在" });
      const result = await runStep(ctx, body.step ?? {}, body.serviceOrigin);
      return send(res, 200, result);
    }

    if (req.method === "POST" && req.url === "/screenshot") {
      const ctx = contexts.get(String(body.browserContextId ?? ""));
      if (!ctx) return send(res, 404, { error: "context 不存在" });
      try {
        const image = await ctx.win.webContents.capturePage();
        return send(res, 200, { pngBase64: image.toPNG().toString("base64") });
      } catch (error) {
        return send(res, 500, { error: String(error?.message ?? error) });
      }
    }

    if (req.method === "POST" && req.url === "/context/close") {
      const id = String(body.browserContextId ?? "");
      const ctx = contexts.get(id);
      if (ctx) {
        contexts.delete(id);
        ctx.win.destroy();
      }
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "not-found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const closeAll = () => {
    for (const [, ctx] of contexts) {
      try { ctx.win.destroy(); } catch { /* 已销毁 */ }
    }
    contexts.clear();
  };
  return { server, port, token, closeAll };
}

module.exports = { startVerifierServer };
