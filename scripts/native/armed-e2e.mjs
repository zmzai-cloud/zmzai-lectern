#!/usr/bin/env node
/** 发行物 armed 端到端（P0 2026-11-07）：与安装包内 Electron 拉起的两个进程一致——
 *  打包 Host bundle（host/dist/host/src/index.js）+ 生产 Next standalone（.next/standalone/server.js），
 *  Next 启动即 armed（LECTERN_HOST_GATEWAY）。经 UI 实际使用的 /api 路径逐族核对 Host 归属：
 *  会话建/列/改/删、读面、全局搜索、fs、git、预览、skills、plugins、repomap、交付概览、
 *  事件流实时性（经网关的 SSE 首帧延迟）、优雅收尾、Host 停止后 503 不回落。
 *
 *  隔离：临时数据目录与项目、relay 指向本地关闭端口（零外部流量、零模型调用），
 *  只清理本脚本启动的进程（按 pid）。用法：node scripts/native/armed-e2e.mjs [结果 JSON 路径] */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const out = process.argv[2] ?? path.join(root, "test-results/p0-release/armed-e2e.json");
const hostBundle = path.join(root, "host/dist/host/src/index.js");
const nextBin = path.join(root, "node_modules/next/dist/bin/next");
for (const f of [hostBundle, path.join(root, ".next/BUILD_ID"), nextBin]) if (!existsSync(f)) throw new Error(`缺少产物：${f}（先 pnpm host:build / pnpm build）`);
// 运行模式：生产构建产物（.next 编译输出）经 next start 服务。安装包里的 standalone
// 还需 build-mac 的 npm 实体化依赖与 asar 补丁（需联网），本脚本不覆盖这一步
const NEXT_MODE = "next-start（生产构建 .next；standalone 依赖实体化/asar 未执行）";

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const base = mkdtempSync(path.join(tmpdir(), "armed-e2e-"));
const dataDir = path.join(base, "data");
const hostData = path.join(base, "host");
const project = path.join(base, "project");
const defaultWs = path.join(base, "ws-default"); // 默认项目路径必须与登记项目不同（同路径双登记 = 归属冲突）
for (const d of [dataDir, hostData, project, defaultWs]) mkdirSync(d, { recursive: true });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
writeFileSync(path.join(project, "README.md"), "# armed e2e fixture\n");
writeFileSync(path.join(project, "page.png"), PNG);
mkdirSync(path.join(project, ".zmzai", "skills", "fixture-skill"), { recursive: true });
writeFileSync(path.join(project, ".zmzai", "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\n---\nbody\n");
mkdirSync(path.join(project, "src"), { recursive: true });
writeFileSync(path.join(project, "src", "math.mjs"), "export const add = (a, b) => a + b;\n");
execSync("git init -q -b main && git config user.email e2e@test.invalid && git config user.name e2e && git add -A && git commit -qm init", { cwd: project, shell: "/bin/bash" });
writeFileSync(path.join(dataDir, "projects.json"), JSON.stringify({ activeId: "p_e2e", projects: [{ id: "p_e2e", name: "E2E", path: project, createdAt: new Date().toISOString() }] }));

// 挂起的本地假 relay：接受连接但永不响应——运行稳定停在进行中（强杀重启场景需要
// 真实的在途运行），且零外部流量、零模型调用
const sockets = new Set();
const hangingRelay = createServer((sock) => { sockets.add(sock); sock.on("close", () => sockets.delete(sock)); });
await new Promise((resolve) => hangingRelay.listen(0, "127.0.0.1", resolve));
const deadRelay = `http://127.0.0.1:${hangingRelay.address().port}/api/v1`;
const commonEnv = { ...process.env, LECTERN_DATA_DIR: dataDir, LECTERN_WORKSPACE: defaultWs, RELAY_URL: deadRelay, OPENAI_BASE_URL: deadRelay, OPENAI_MODEL: "glm-5.3-flash" };
let hostErr = "";
let hostExit = null;
const procs = [];
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ""}`); };

try {
  const hostJson = path.join(hostData, "host.json");
  const startHost = async () => {
    rmSync(hostJson, { force: true });
    const h = spawn(process.execPath, [hostBundle], { env: { ...commonEnv, LECTERN_HOST_DATA: hostData, LECTERN_HOST_WORKSPACE: defaultWs }, stdio: ["ignore", "pipe", "pipe"] });
    procs.push(h);
    h.stderr.on("data", (d) => { hostErr += String(d); });
    h.stdout.on("data", (d) => { hostErr += String(d); });
    h.on("exit", (code, signal) => { hostExit = { code, signal, at: Date.now() }; });
    for (let i = 0; i < 200 && !existsSync(hostJson); i++) await new Promise((r) => setTimeout(r, 50));
    if (!existsSync(hostJson)) throw new Error(`Host 未就绪：${hostErr.slice(0, 300)}`);
    return h;
  };
  let host = await startHost();

  const port = await freePort();
  const next = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: root, env: { ...commonEnv, NODE_ENV: "production", LECTERN_HOST_GATEWAY: hostJson, LECTERN_HOST_BOOTSTRAP: hostJson }, stdio: "ignore" });
  procs.push(next);
  const web = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(`${web}/api/m2a/health`)).status < 500) break; } catch { /* 启动中 */ } await new Promise((r) => setTimeout(r, 100)); }

  const api = async (p, init = {}) => {
    const res = await fetch(`${web}${p}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
    const type = res.headers.get("content-type") ?? "";
    const body = type.includes("json") ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer());
    return { status: res.status, type, body, headers: res.headers };
  };

  // 会话创建（POST /api/sessions → Host /v1/session-create；显式 model 避免模型目录查询）
  const created = await api("/api/sessions", { method: "POST", body: JSON.stringify({ requestId: "e2e_create_0001", model: { providerId: "openai", modelId: "glm-5.3-flash" } }) });
  const sid = created.body?.id;
  check("会话创建经 Host，归属活动项目", created.status === 200 && sid && created.body.projectId === "p_e2e", `${created.status} ${JSON.stringify(created.body).slice(0, 120)}`);
  const listed = await api("/api/sessions");
  check("会话列表（Host 聚合）含新会话", Array.isArray(listed.body) && listed.body.some((s) => s.id === sid));
  check("会话改名（PATCH 经 Host）", (await api(`/api/sessions/${sid}`, { method: "PATCH", body: JSON.stringify({ title: "E2E 改名" }) })).status === 200
    && (await api("/api/sessions")).body.find((s) => s.id === sid)?.title === "E2E 改名");

  // 读面（UI 契约形状）
  const win = await api(`/api/sessions/${sid}/messages?view=window&limit=50`);
  check("消息窗口快照形状（projectId/historyRevision/task）", win.status === 200 && win.body?.projectId === "p_e2e" && "historyRevision" in (win.body ?? {}) && "task" in (win.body ?? {}));
  const usage = await api(`/api/sessions/${sid}/usage`);
  check("用量 UI 契约", usage.status === 200 && typeof usage.body?.contextWindow === "number" && "steps" in usage.body);
  check("会话内搜索形状", (await api(`/api/sessions/${sid}/search?q=e2e`)).body?.results !== undefined);
  check("已读状态读", (await api(`/api/sessions/${sid}/read-state`)).status === 200);
  check("全局搜索（Host）", (await api("/api/sessions/search?q=zzz")).status === 200);

  // 文件面 / git / 预览 / skills / plugins / repomap / 交付
  const tree = await api(`/api/fs/tree?path=&sessionId=${sid}`);
  check("fs/tree 根目录为会话归属项目", tree.body?.nodes?.some((n) => n.name === "README.md"));
  check("fs/file 读", (await api(`/api/fs/file?path=README.md&sessionId=${sid}`)).body?.content === "# armed e2e fixture\n");
  const put = await api("/api/fs/file", { method: "PUT", body: JSON.stringify({ path: "src/math.mjs", content: "export const add = (a, b) => a + b + 0;\n", sessionId: sid }) });
  check("fs/file 写落到项目目录", put.status === 200 && readFileSync(path.join(project, "src/math.mjs"), "utf8").includes("+ 0"));
  const diff = await api(`/api/git/diff?sessionId=${sid}`);
  check("git diff 反映写入", diff.body?.available === true && diff.body.files.some((f) => f.path === "src/math.mjs"));
  const snap = await api("/api/git/checkpoint", { method: "POST", body: JSON.stringify({ label: "e2e", sessionId: sid }) });
  check("git 检查点（Host 执行 commit）", snap.body?.ok === true && !!snap.body.hash);
  const preview = await api(`/api/preview/${sid}/page.png`);
  check("预览字节流经网关原样", preview.status === 200 && preview.type.startsWith("image/png") && Buffer.isBuffer(preview.body) && preview.body.equals(PNG));
  check("skills 按会话根", (await api(`/api/skills?sessionId=${sid}`)).body?.skills?.some((s) => s.name === "fixture-skill"));
  check("plugins（入口固定项目）", Array.isArray((await api("/api/plugins")).body?.plugins));
  const repomap = await api("/api/repomap");
  check("repomap（Host bundle 内 wasm 资源可定位）", repomap.status === 200 && repomap.body?.ok === true && typeof repomap.body.text === "string", repomap.body?.error ?? "");
  check("交付概览", (await api(`/api/deliveries?sessionId=${sid}`)).status === 200);

  // 事件流：经网关订阅 → 发 prompt（模型端点为关闭端口，run 会报错但事件照常产生）→ 测首帧到达
  const sse = new AbortController();
  const connectStarted = Date.now();
  const stream = await fetch(`${web}/api/sessions/${sid}/events`, { signal: sse.signal });
  const connectMs = Date.now() - connectStarted;
  check("SSE 经网关立即建立（空闲会话不等心跳）", stream.status === 200 && connectMs < 3000, `${connectMs}ms`);
  const reader = stream.body.getReader();
  const promptAt = Date.now();
  const prompted = await api(`/api/sessions/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text: "e2e 事件检查", requestId: "e2e_prompt_0001" }) });
  let firstFrameMs = null; let frames = "";
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise((res) => setTimeout(() => res({ timeout: true }), deadline - Date.now()))]);
    if (r.timeout || r.done) break;
    frames += new TextDecoder().decode(r.value);
    if (/\nid: \d+/.test(`\n${frames}`) && firstFrameMs === null) { firstFrameMs = Date.now() - promptAt; break; }
  }
  sse.abort();
  check("prompt 经 Host 受理", prompted.status === 200, `${prompted.status}`);
  check("事件经网关实时到达（远小于 1s 轮询）", firstFrameMs !== null && firstFrameMs < 900, `${firstFrameMs}ms`);

  // 优雅收尾经网关到 Host；删除会话
  const graceful = await api("/api/shutdown/graceful", { method: "POST" });
  check("优雅收尾在 Host 执行", graceful.status === 200 && graceful.body?.ok === true, JSON.stringify(graceful.body));
  check("会话删除经 Host", (await api(`/api/sessions/${sid}`, { method: "DELETE" })).status === 200
    && !(await api("/api/sessions")).body.some((s) => s.id === sid));

  // PC11：运行中强杀 Host（无优雅收尾）→ Next 不重启 → 重启 Host（新端口/token）→
  // Next 每请求重读握手继续服务；前任遗留的运行租约被立即接管收尾，不挂「执行中」
  const b = await api("/api/sessions", { method: "POST", body: JSON.stringify({ requestId: "e2e_create_0002", model: { providerId: "openai", modelId: "glm-5.3-flash" } }) });
  const sidB = b.body?.id;
  await api(`/api/sessions/${sidB}/prompt`, { method: "POST", body: JSON.stringify({ text: "将被强杀的运行", requestId: "e2e_prompt_0003" }) });
  await new Promise((r) => setTimeout(r, 600));
  const runningBefore = (await api("/api/sessions")).body?.find((s) => s.id === sidB)?.running;
  host.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 500));
  check("Host 被强杀期间命中路由 503（Next 不代执行）", (await api("/api/sessions")).status === 503);
  const restartAt = Date.now();
  host = await startHost();
  const relisted = await api("/api/sessions");
  check("Next 未重启即接上重启后的 Host（读新握手）", relisted.status === 200 && relisted.body.some((s) => s.id === sidB), `${Date.now() - restartAt}ms`);
  let recovered = false; let recoveredMs = null;
  for (let i = 0; i < 40 && !recovered; i++) {
    const evs = await fetch(`${web}/api/sessions/${sidB}/events?since=0`, { signal: AbortSignal.timeout(1500) }).then((r) => r.body.getReader()).then(async (reader) => {
      let txt = ""; const end = Date.now() + 1200;
      while (Date.now() < end) { const r = await Promise.race([reader.read(), new Promise((res) => setTimeout(() => res({ done: true }), end - Date.now()))]); if (r.done) break; txt += new TextDecoder().decode(r.value); }
      reader.cancel().catch(() => undefined); return txt;
    }).catch(() => "");
    if (evs.includes("服务重启中断")) { recovered = true; recoveredMs = Date.now() - restartAt; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  const runningAfter = (await api("/api/sessions")).body?.find((s) => s.id === sidB)?.running;
  check("强杀前运行中的会话：重启后立即收尾（中断事件 + 不再显示执行中）", recovered && runningAfter === false, `强杀前 running=${runningBefore}；收尾用时 ${recoveredMs}ms`);

  // Host 停止后：命中路由一律 503 HOST_UNAVAILABLE（不回落 Next 进程内）
  host.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  const down = await api(`/api/fs/tree?path=&sessionId=${sid}`);
  check("Host 停止 → 503 HOST_UNAVAILABLE 不回落", down.status === 503 && down.body?.detail?.code === "HOST_UNAVAILABLE");
  const downPrompt = await api(`/api/sessions/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text: "x", requestId: "e2e_prompt_0002" }) });
  check("命令在 Host 停止时带回 requestId（结果未知语义）", downPrompt.status === 503 && downPrompt.body?.detail?.requestId === "e2e_prompt_0002");
} catch (error) {
  check("执行异常", false, error instanceof Error ? error.message : String(error));
} finally {
  for (const p of procs) { try { p.kill("SIGTERM"); } catch { /* 已退出 */ } }
  for (const sock of sockets) sock.destroy();
  hangingRelay.close();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(base, { recursive: true, force: true });
}

const passed = results.filter((r) => r.ok).length;
if (passed !== results.length) {
  console.log(`--- Host 退出 ${JSON.stringify(hostExit)}；输出末尾 ---\n${hostErr.slice(-1500)}`);
  writeFileSync(path.join(path.dirname(out), "armed-e2e-host.log"), hostErr);
}
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ generated_at: new Date().toISOString(), commit: execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(), artifacts: { host: "host/dist/host/src/index.js", next: ".next（next start）", mode: NEXT_MODE }, passed, total: results.length, results }, null, 2));
console.log(`armed e2e: ${passed}/${results.length} 通过 → ${out}`);
process.exitCode = passed === results.length ? 0 : 1;
