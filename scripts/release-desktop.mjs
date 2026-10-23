#!/usr/bin/env node
// Lectern 双平台一键发布：
//   预检（版本/日志/工作区/OSS/CI 门禁）→ 测试 → mac 构建 + smoke → win 交叉构建
//   → 双平台校验 → OSS 上传 → 线上回读 → 升级通道 → lectern-site → GitHub Release。
//
// 用法：
//   node scripts/release-desktop.mjs --version 0.17.0              # 只预检并打印计划
//   node scripts/release-desktop.mjs --version 0.17.0 --dry-run    # 同上（显式）
//   node scripts/release-desktop.mjs --version 0.17.0 --yes        # 真正执行
//
// 固定顺序 mac → win：build-win-cross.sh 会保留并恢复 mac 产物，反向重跑则
// build-mac.sh 的 clean-dist 会清掉 win 产物。发布脚本不会替你换顺序。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions, defaultSiteNote, githubReleaseBody, loadReleaseNotes,
  parseReleaseArgs, parseVersion, releaseSteps, siteReleaseConfig,
} from "./release-plan.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RELEASE_HOST = "https://zmzai.oss-cn-beijing.aliyuncs.com/releases/harness";
const DEFAULT_OSS_BASE = RELEASE_HOST;
const options = (() => {
  try { return parseReleaseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`❌ ${error.message}`); process.exit(2); }
})();

function log(title) { console.log(`\n=== ${title} ===`); }
function warn(message) { console.warn(`⚠️  ${message}`); }

function capture(command, args, { cwd = ROOT } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  if (result.error) throw new Error(`无法执行 ${command}：${result.error.message}`);
  return result;
}

function must(command, args, optionsCapture) {
  const result = capture(command, args, optionsCapture);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} 失败（退出码 ${result.status}）：${(result.stderr ?? "").trim()}`);
  }
  return result.stdout.trim();
}

function run(command, args, { cwd = ROOT } = {}) {
  console.log(`\n▶ ${[command, ...args].join(" ")}${cwd === ROOT ? "" : `（cwd: ${cwd}）`}`);
  if (options.dryRun) return;
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    throw new Error(`命令失败（退出码 ${result.status}）：${command} ${args.join(" ")}`);
  }
}

function loadReleaseEnv() {
  const path = join(ROOT, ".env.release");
  const file = {};
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && !(match[1] in process.env)) file[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  }
  return { ...file, ...process.env };
}

function assertOssConfig() {
  const env = loadReleaseEnv();
  const missing = ["OSS_REGION", "OSS_BUCKET", "OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET"]
    .filter((key) => !env[key] || /填你的|placeholder/i.test(env[key]));
  if (missing.length) {
    throw new Error(`OSS 配置缺失或仍是占位值：${missing.join(", ")}（写到 .env.release 或环境变量）`);
  }
}

function assertCleanRepo(cwd, label) {
  const dirty = must("git", ["status", "--porcelain", "--untracked-files=no"], { cwd });
  if (dirty) {
    throw new Error(`${label} 有未提交改动，先提交再发版：\n${dirty}`);
  }
}

function siteRoot() {
  return resolve(ROOT, options.siteDir ?? "../lectern-site");
}

function preflightSite(version) {
  const site = siteRoot();
  for (const required of ["release.json", "index.html", "scripts/sync-version.py", "scripts/check-release.py"]) {
    if (!existsSync(join(site, required))) throw new Error(`lectern-site 缺少 ${required}：${site}`);
  }
  assertCleanRepo(site, "lectern-site");
  const branch = must("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: site });
  if (branch !== "main") warn(`lectern-site 当前分支是 ${branch}，脚本只会 push origin main`);
  const previous = JSON.parse(readFileSync(join(site, "release.json"), "utf8"));
  if (!options.force && compareVersions(previous.version, version) >= 0) {
    throw new Error(`lectern-site 已是 v${previous.version}，目标 v${version} 不更新；确需重发加 --force`);
  }
  if (capture("python3", ["--version"]).status !== 0) throw new Error("找不到 python3（lectern-site 同步脚本需要）");
  return { site, previous };
}

async function assertFeedAccepts(version) {
  let response;
  try {
    response = await fetch(`${RELEASE_HOST}/latest-desktop.json`, {
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw new Error(`无法读取线上更新清单：${error.message}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`无法读取线上更新清单（HTTP ${response.status}）`);
  const live = await response.json();
  if (typeof live?.version !== "string") throw new Error("线上更新清单缺少 version");
  const comparison = compareVersions(version, live.version);
  if (comparison < 0) throw new Error(`目标 v${version} 低于线上 v${live.version}，拒绝降级发布`);
  if (comparison === 0 && !options.force) {
    throw new Error(`v${version} 已发布；确需覆盖同一版本请加 --force`);
  }
  return live;
}

function runRenderingGate(head) {
  log("渲染层 E2E 门禁");
  const result = spawnSync("node", ["scripts/ui-e2e-gate.mjs", "--sha", head], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error("渲染层 E2E 未在待发布 commit 上通过，停止发布（fail closed）");
  }
}

async function waitForSite(siteUrl, version, timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${siteUrl}/?deploy=${Date.now()}`, {
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
      });
      if (response.ok && (await response.text()).includes(`v${version}`)) return;
    } catch { /* 部署中，继续等 */ }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 15000));
  }
  throw new Error(`等待 ${siteUrl} 部署 v${version} 超时（10 分钟）；检查 lectern-site 的 deploy workflow`);
}

function releaseSite({ site, previous, notes, version }) {
  const note = options.siteNote ?? defaultSiteNote(notes);
  const config = siteReleaseConfig(previous, { version, date: notes.date, note });
  log(`lectern-site → v${version}`);
  writeFileSync(join(site, "release.json"), JSON.stringify(config, null, 2) + "\n");
  run("python3", ["scripts/sync-version.py"], { cwd: site });
  run("python3", ["scripts/check-release.py"], { cwd: site });
  run("git", ["add", "release.json", "index.html", "features.html", "why.html", "roadmap.html"], { cwd: site });
  const staged = capture("git", ["diff", "--cached", "--quiet"], { cwd: site });
  if (staged.status !== 0) {
    run("git", ["commit", "-m", `chore(site): 发布 v${version}`], { cwd: site });
  } else {
    console.log("· site 无变化，跳过提交");
  }
  run("git", ["push", "origin", "main"], { cwd: site });
  return config;
}

async function main() {
  if (options.help) {
    console.log(`Lectern 一键发布

用法：
  node scripts/release-desktop.mjs --version <x.y.z> [--yes|--dry-run] [选项]

不传 --yes / --dry-run 时只做预检并打印计划，不构建、不上传、不推送。

选项：
  --yes                 执行完整发布（构建、上传 OSS、推送 site、创建 GitHub Release）
  --dry-run             只预检 + 打印计划
  --skip-tests          跳过 typecheck / vitest / test:release
  --skip-build          复用 dist 现有双平台产物（仍会全量校验）
  --skip-update-path    跳过 verify:update-path（本机没装旧版时用）
  --skip-site           不改 lectern-site
  --skip-github         不创建 GitHub Release
  --site-dir <path>     lectern-site 路径（默认 ../lectern-site）
  --site-note <text>    site 下载区说明（默认取发布日志第一条）
  --force               允许覆盖已发布版本 / 已存在的 GitHub Release
  --help                显示本帮助

固定顺序 mac → win；Windows 构建会保留并恢复 mac 产物。`);
    return;
  }

  log("预检");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const version = options.version ?? pkg.version;
  parseVersion(version);
  if (version !== pkg.version) {
    throw new Error(`package.json 是 v${pkg.version}，目标是 v${version}；先改版本号并提交`);
  }
  const notes = loadReleaseNotes(ROOT, version);
  console.log(`版本 v${version} · 发布日志 ${notes.date} · ${notes.sections.length} 节`);
  const today = new Date().toISOString().slice(0, 10);
  if (notes.date > today) warn(`发布日志日期 ${notes.date} 晚于今天 ${today}`);
  const note = options.siteNote ?? defaultSiteNote(notes);
  // 站点说明会被直接嵌进 HTML；在预检阶段就挡住坏值，避免构建完才发现。
  siteReleaseConfig({}, { version, date: notes.date, note });

  assertCleanRepo(ROOT, "zmzai-lectern");
  if (capture("git", ["ls-files", "--error-unmatch", `release-notes/${version}.json`]).status !== 0) {
    throw new Error(`release-notes/${version}.json 尚未纳入 git，先提交再发版`);
  }
  const branch = must("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") warn(`当前分支是 ${branch}；CI 门禁只认已推送的 commit`);
  const head = must("git", ["rev-parse", "HEAD"]);
  console.log(`commit ${head.slice(0, 12)}（${branch}）`);

  assertOssConfig();
  if (!options.skipGithub && capture("gh", ["auth", "status"]).status !== 0) {
    throw new Error("gh 未登录：GitHub Release 需要 gh auth login（或用 --skip-github）");
  }
  const sitePreflight = options.skipSite ? null : preflightSite(version);
  const live = await assertFeedAccepts(version);
  if (live) console.log(`线上当前 v${live.version}${options.force ? "（--force 允许覆盖同版本）" : ""}`);

  runRenderingGate(head);

  if (!options.yes && !options.dryRun) {
    console.log("\n预检通过。以下步骤尚未执行：");
    releaseSteps(options).forEach((step, index) => console.log(`  ${index + 1}. ${step}`));
    console.log(`\n加 --yes 执行完整发布（版本 v${version}）。`);
    return;
  }
  if (options.dryRun) {
    console.log("\n预检通过。dry-run 执行计划：");
    releaseSteps(options).forEach((step, index) => console.log(`  ${index + 1}. ${step}`));
    return;
  }

  if (!options.skipTests) {
    log("测试");
    run("corepack", ["pnpm", "typecheck"]);
    run("corepack", ["pnpm", "test"]);
    run("corepack", ["pnpm", "test:release"]);
  }

  if (!options.skipBuild) {
    log("macOS 构建 + packaged smoke");
    run("corepack", ["pnpm", "build:mac"]);
    run("corepack", ["pnpm", "test:packaged"]);
    log("Windows 交叉构建（保留并恢复 macOS 产物）");
    run("corepack", ["pnpm", "build:win:cross"]);
  }

  log("双平台产物校验");
  run("node", ["scripts/release-validation.mjs", "release", "dist"]);

  log("上传 OSS");
  run("node", ["scripts/upload-oss.mjs"]);

  log("线上回读校验");
  run("corepack", ["pnpm", "verify:public"]);

  if (!options.skipUpdatePath) {
    log("旧版升级通道");
    run("corepack", ["pnpm", "verify:update-path"]);
  }

  let config = null;
  if (sitePreflight) {
    config = releaseSite({ ...sitePreflight, notes, version });
    log("等待站点部署");
    await waitForSite(config.site_url, version);
    run("python3", ["scripts/check-release.py", "--live"], { cwd: sitePreflight.site });
  }

  if (!options.skipGithub) {
    log("GitHub Release");
    const ossBase = (config?.oss_base ?? DEFAULT_OSS_BASE).replace(/\/+$/, "");
    const bodyPath = join(ROOT, "dist", "github-release-notes.md");
    writeFileSync(bodyPath, githubReleaseBody({ version, notes, ossBase }));
    const existing = capture("gh", ["release", "view", `v${version}`, "--json", "tagName"]);
    if (existing.status === 0) {
      if (!options.force) {
        throw new Error(`GitHub Release v${version} 已存在；--force 会用新说明覆盖（不重新上传安装包）`);
      }
      run("gh", ["release", "edit", `v${version}`, "--notes-file", bodyPath]);
    } else {
      run("gh", ["release", "create", `v${version}`, "--target", head, "--title", `v${version}`, "--notes-file", bodyPath]);
    }
  }

  log("完成");
  console.log(`版本      v${version}`);
  console.log(`更新清单  ${RELEASE_HOST}/latest-desktop.json`);
  if (config) console.log(`站点      ${config.site_url}`);
  console.log(`日志       ${options.skipGithub ? "（已跳过 GitHub Release）" : `gh release view v${version}`}`);
}

main().catch((error) => {
  console.error(`\n❌ 发布中止：${error.message}`);
  process.exit(1);
});
