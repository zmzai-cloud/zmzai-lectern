import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

/**
 * 乐观发送验收（2026-10-09）：点击发送的瞬间输入框就该清空、气泡上屏
 * （page.send 的 setEcho 同帧生效），不再等 prompt 往返回来才清。
 *
 * ① prompt 慢 1.5s：点击后 300ms 内 textarea 已空 + 乐观气泡可见；
 * ② prompt 失败 500：文字完整恢复到输入框（规格 §7.5），附件队列不动；
 * ③ 成功后附件队列清空（服务端已绑定）。
 */

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
const output = process.env.LECTERN_UI_OUTPUT || "test-results/optimistic-send";
mkdirSync(output, { recursive: true });

const base = () => ({
  info: { id: "user-0", role: "user", sessionId: "probe-send" },
  messageSeq: 1,
  parts: [{ id: "user-0-text", messageId: "user-0", sessionId: "probe-send", type: "text", text: "历史消息" }],
});

async function runCase(name, { promptDelay, promptStatus, promptBody }) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.removeItem("lectern.task-layout");
    localStorage.removeItem("lectern:task-layout");
    window.EventSource = class { close() {} };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/sessions")
      return route.fulfill({ json: [{ id: "probe-send", title: "乐观发送验收", agent: "default", model: { providerId: "openai", modelId: "gpt-test" }, time: { created: "2026-10-09T00:00:00Z" } }] });
    if (path === "/api/sessions/probe-send/messages")
      return route.fulfill({ json: { messages: [base()], beforeCursor: null, hasMoreBefore: false, historyRevision: 1, snapshotSeq: 0, task: null, stateEvents: [] } });
    if (path === "/api/sessions/probe-send/prompt") {
      await new Promise((resolve) => setTimeout(resolve, promptDelay));
      if (promptBody) return route.fulfill(promptBody);
      if (promptStatus === 500) return route.fulfill({ status: 500, json: { error: "发送失败（探针注入）" } });
      return route.fulfill({ json: { userMessageId: "server-echo", requestId: "req-1" } });
    }
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
    await page.getByText("乐观发送验收", { exact: true }).click();
    await page.locator(".chat-user-bubble").first().waitFor();

    const textarea = page.locator("textarea").first();
    const sent = "这条消息点击发送后应该立刻从输入框消失";
    await textarea.fill(sent);
    const sendButton = page.getByRole("button", { name: "发送", exact: true });
    await sendButton.click();

    // ① 乐观清空：prompt 还在路上（1.5s），输入框必须已经空了
    await page.waitForTimeout(300);
    assert.equal(await textarea.inputValue(), "", `${name}: input must clear instantly on send`);
    assert.ok(await page.getByText(sent, { exact: false }).first().isVisible(), `${name}: optimistic bubble must be visible immediately`);

    if (promptBody) {
      // ④ RECOVERY_REQUIRED（Host 网关形状）：横幅必须出现（detail.code 或裸码
      //    error 字段都要能识别），toast 不得是英文裸码，原文回到输入框。
      const banner = page.getByRole("button", { name: "核对并继续上次任务", exact: true });
      await banner.waitFor({ timeout: 5000 });
      await page.getByText(promptBody.expectToast, { exact: false }).first().waitFor({ timeout: 5000 });
      assert.equal(await page.getByText("RECOVERY_REQUIRED", { exact: true }).count(), 0, `${name}: raw code must not leak into the toast`);
      await page.waitForTimeout(200);
      assert.equal(await textarea.inputValue(), sent, `${name}: text restored on recovery-required`);
    } else if (promptStatus === 500) {
      // ② 失败恢复：toast 出现 + 原文回到输入框
      await page.getByText("发送失败（探针注入）").waitFor({ timeout: 5000 });
      await page.waitForTimeout(200);
      assert.equal(await textarea.inputValue(), sent, `${name}: text must be restored on failure`);
    } else {
      // ③ 成功：气泡保持，输入框保持空
      await page.waitForTimeout(promptDelay + 600);
      assert.equal(await textarea.inputValue(), "", `${name}: input stays cleared after acceptance`);
      assert.ok(await page.getByText(sent, { exact: false }).first().isVisible(), `${name}: bubble persists`);
    }
    assert.deepEqual(errors, [], JSON.stringify(errors));
    await page.screenshot({ path: `${output}/${name}.png` });
    console.log(`optimistic-send[${name}]: passed`);
  } catch (error) {
    await page.screenshot({ path: `${output}/${name}-failure.png` }).catch(() => {});
    console.error(`[${name}]`, error);
    process.exitCode = 1;
  } finally {
    await page.close();
  }
}

await runCase("instant-clear", { promptDelay: 1500, promptStatus: 200 });
await runCase("failure-restore", { promptDelay: 1500, promptStatus: 500 });
// Host 网关两种错误形状都要出「核对并继续」横幅（旧版 Host 只有裸码 error 字段，
// 没有 detail.code——修复前桌面模式横幅永远不触发，用户只看到一行英文码 toast）。
await runCase("recovery-host-legacy", {
  promptDelay: 600,
  promptBody: { status: 409, json: { error: "RECOVERY_REQUIRED", message: "恢复后重试" }, expectToast: "恢复后重试" },
});
await runCase("recovery-host-aligned", {
  promptDelay: 600,
  promptBody: {
    status: 409,
    json: { error: "上一任务的外部副作用尚未确认，请先核对后再继续", message: "上一任务的外部副作用尚未确认，请先核对后再继续", detail: { code: "RECOVERY_REQUIRED", message: "上一任务的外部副作用尚未确认，请先核对后再继续" } },
    expectToast: "上一任务的外部副作用尚未确认",
  },
});
await browser.close();
if (process.exitCode) throw new Error("optimistic-send failed");
console.log("optimistic-send: all assertions passed");
