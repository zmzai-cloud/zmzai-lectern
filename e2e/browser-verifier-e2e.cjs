#!/usr/bin/env node
/** V1-S5 e2e：真实浏览器 fixture 验证（spec §17.1 V1 放行条件）。
 *
 *  直接驱动 electron/verifier.cjs（S3 真浏览器驱动）：Electron 起 verifier
 *  endpoint → 本地 http fixture → 走协议全链路（openContext/goto/click/type/
 *  assert_dom/assert_visual/console 采集/screenshot PNG）+ V02 场景（交互失败
 *  但截图正常 → required 断言失败不假报）。
 *
 *  跑法：corepack pnpm exec electron e2e/browser-verifier-e2e.cjs
 *  （Host 编排层由 vitest 全覆盖；本脚本验证真 Chromium 行为。） */
const http = require("node:http");
const path = require("node:path");

const { app } = require("electron");
const { startVerifierServer } = require(path.join(__dirname, "..", "electron", "verifier.cjs"));

const FIXTURE_HTML = `<!doctype html><html><head><title>E2E Fixture App</title></head><body>
  <div id="main">hello-v1</div>
  <button id="btn" onclick="document.getElementById('out').textContent='clicked'">go</button>
  <div id="out">initial</div>
  <div id="hidden" style="display:none">secret</div>
  <script>console.error("fixture-error-A")</script>
</body></html>`;

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`[v1-e2e] PASS ${name}`);
  else { failures += 1; console.log(`[v1-e2e] FAIL ${name} ${detail}`); }
}

function serveFixture() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function call(base, token, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

app.whenReady().then(async () => {
  const fixture = await serveFixture();
  const origin = `http://127.0.0.1:${fixture.port}`;
  const verifier = await startVerifierServer();
  const base = `http://127.0.0.1:${verifier.port}`;
  let code = 1;
  try {
    // 鉴权
    const unauth = await call(base, "wrong", "/context/open", { contextKey: "x", viewport: { width: 800, height: 600 } });
    check("token 鉴权（错 token 401）", unauth.status === 401);

    // context 开 + goto
    const opened = await call(base, verifier.token, "/context/open", { contextKey: "e2e", viewport: { width: 800, height: 600 } });
    check("openContext", opened.status === 200 && typeof opened.body.browserContextId === "string");
    const ctxId = opened.body.browserContextId;

    const step = (s) => call(base, verifier.token, "/step", { browserContextId: ctxId, serviceOrigin: origin, step: s });

    const goto = await step({ kind: "goto", target: "/", requirement: "required" });
    check("goto 加载 fixture", goto.body.status === "passed", JSON.stringify(goto.body));

    const dom = await step({ kind: "assert_dom", target: "#main", value: "hello-v1", requirement: "required" });
    check("assert_dom 命中内容", dom.body.status === "passed", JSON.stringify(dom.body));

    // 交互：click → JS 副作用 → 断言结果（功能断言，不是看截图）
    await step({ kind: "click", target: "#btn", requirement: "required" });
    const after = await step({ kind: "assert_dom", target: "#out", value: "clicked", requirement: "required" });
    check("click 后功能断言", after.body.status === "passed", JSON.stringify(after.body));

    // type 交互
    const typed = await step({ kind: "type", target: "#out", value: "typed-text", requirement: "advisory" });
    check("type 交互", typed.body.status === "passed", JSON.stringify(typed.body));

    // 视觉机器可判定子集：可见性（#hidden 不可见应 failed）
    const visOk = await step({ kind: "assert_visual", target: "#main", requirement: "advisory" });
    check("assert_visual 可见元素通过", visOk.body.status === "passed", JSON.stringify(visOk.body));
    const visHidden = await step({ kind: "assert_visual", target: "#hidden", requirement: "advisory" });
    check("assert_visual 隐藏元素拒绝", visHidden.body.status === "failed", JSON.stringify(visHidden.body));

    // console error 采集（fixture 注入了一条 console.error）
    const consoleProbe = await step({ kind: "assert_dom", target: "#main", requirement: "advisory" });
    check("console error 采集（>=1）", Number(consoleProbe.body.consoleErrors ?? 0) >= 1, JSON.stringify(consoleProbe.body));

    // V02 场景：required 断言失败（元素缺失）——即使页面/截图一切正常也不假报
    const missing = await step({ kind: "assert_dom", target: "#does-not-exist", value: "x", requirement: "required" });
    check("V02 required 断言失败如实报 failed", missing.body.status === "failed", JSON.stringify(missing.body));

    // 截图：真 PNG
    const shot = await call(base, verifier.token, "/screenshot", { browserContextId: ctxId });
    const png = Buffer.from(String(shot.body.pngBase64 ?? ""), "base64");
    check("截图为 PNG", png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) && png.length > 1000, `bytes=${png.length}`);

    // 关闭
    const closed = await call(base, verifier.token, "/context/close", { browserContextId: ctxId });
    check("closeContext", closed.status === 200);
  } catch (error) {
    failures += 1;
    console.log(`[v1-e2e] FAIL 异常：${error?.stack ?? error}`);
  } finally {
    console.log(`[v1-e2e] ${failures === 0 ? "ALL PASS" : `${failures} 项失败`}`);
    verifier.closeAll();
    verifier.server.close();
    fixture.server.close();
    code = failures === 0 ? 0 : 1;
    app.exit(code);
  }
});
