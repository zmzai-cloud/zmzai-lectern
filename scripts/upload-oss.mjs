// harness 发布产物上传 OSS（阿里云，与 muzhi 同款 ali-oss / authorizationV4）。
//
// 用法（构建完成后）：
//   node scripts/upload-oss.mjs                     # 上传 dist/ 全部产物
//   node scripts/upload-oss.mjs --dry               # 只列出将上传的文件与目标 key
//   node scripts/upload-oss.mjs --prefix custom/    # 覆盖路径前缀
//
// 配置来源（优先级）：环境变量 > harness/.env.release。
// 必填：OSS_REGION（如 oss-cn-hangzhou）、OSS_BUCKET、OSS_ACCESS_KEY_ID、OSS_ACCESS_KEY_SECRET
// 可选：OSS_ENDPOINT、OSS_PATH_PREFIX（默认 releases/harness）、OSS_PUBLIC_ACL（默认 true → 对象公共读）
//
// 对象级 ACL：bucket 可保持私有，上传时对单个对象设置 public-read，
// landing 的常驻直链才不会过期（muzhi 的材料下载是私有+签名 URL，两者用途不同）。
// 上传完成生成：dist/SHA256SUMS.txt（本地+远端各一份）与 dist/release-links.md（直链清单）。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { digest, stableManifest, verifyRelease } from "./release-validation.mjs";
import { checkUiE2eGate, formatGateResult } from "./ui-e2e-gate.mjs";
import { parse, stringify } from "yaml";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const prefixIdx = args.indexOf("--prefix");
const prefixOverride = prefixIdx >= 0 ? args[prefixIdx + 1] : undefined;

// ── 配置加载 ──
function loadEnvRelease() {
  const path = resolve(process.cwd(), ".env.release");
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

const env = { ...loadEnvRelease(), ...process.env };
const required = ["OSS_REGION", "OSS_BUCKET", "OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET"];
const missing = required.filter((k) => !env[k] || /填你的|placeholder/i.test(env[k]));
if (missing.length) {
  console.error(`❌ OSS 配置缺失或仍是占位值：${missing.join(", ")}`);
  console.error("   请在 harness/.env.release（已 gitignore）或环境变量中填写真实值。");
  console.error("   模板见 scripts/.env.release.example。");
  process.exit(1);
}

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const prefix = (prefixOverride ?? env.OSS_PATH_PREFIX ?? "releases/harness").replace(/^\/|\/$/g, "");
const keyBase = `${prefix}/v${version}`;
const usePublicAcl = (env.OSS_PUBLIC_ACL ?? "true") !== "false";
const distDir = resolve(process.cwd(), "dist");

// ── 产物清单 ──
// latest(-mac).yml 是 electron-updater 自动更新的配置（指向真实产物名），必须一并上传；
// 否则客户端拉 latest.yml 拿到 404。
const platforms = [];
if (existsSync(join(distDir, "latest-mac.yml"))) platforms.push("darwin");
if (existsSync(join(distDir, "latest.yml"))) platforms.push("win32");
const files = await verifyRelease(distDir, version, platforms);
if (!files.length) {
  console.error(`❌ dist/ 下没有可发布的产物（.dmg/.zip/.exe）。先跑 pnpm build:mac / build:win。`);
  process.exit(1);
}

// ── SHA256 清单 ──
const sumLines = [];
for (const file of files.filter((f) => f !== "SHA256SUMS.txt").sort()) {
  sumLines.push(`${await digest(join(distDir, file), "sha256", "hex")}  ${file}`);
}
const sums = sumLines.join("\n");
writeFileSync(join(distDir, "SHA256SUMS.txt"), sums + "\n");
if (!files.includes("SHA256SUMS.txt")) files.push("SHA256SUMS.txt");

const host = `${env.OSS_BUCKET}.${env.OSS_REGION}.aliyuncs.com`;
const links = files
  .slice()
  .sort()
  .map((f) => `- ${encodeURI(`https://${host}/${keyBase}/${f}`)}`);
const stableManifests = files
  .filter((f) => f === "latest.yml" || f === "latest-mac.yml")
  .map((f) => {
    const manifest = stableManifest(readFileSync(join(distDir, f), "utf8"), version);
    return { name: f, body: stringify(manifest) };
  });
// One atomic cross-platform feed for the unsigned, user-confirmed installer flow.
if (platforms.includes("darwin") && platforms.includes("win32")) {
  const desktop = { schema: 1, version, platforms: {} };
  for (const [platform, arch, filename] of [["darwin", "arm64", "latest-mac.yml"], ["win32", "x64", "latest.yml"]]) {
    const manifest = parse(readFileSync(join(distDir, filename), "utf8"));
    const artifact = manifest.files.find((file) => file.url === manifest.path);
    desktop.platforms[`${platform}-${arch}`] = { path: `v${version}/${artifact.url}`, size: artifact.size, sha512: artifact.sha512 };
  }
  stableManifests.push({ name: "latest-desktop.json", body: JSON.stringify(desktop, null, 2) + "\n" });
}
const stableLinks = stableManifests.map(({ name }) => `- ${encodeURI(`https://${host}/${prefix}/${name}`)}`);

console.log(`版本 v${version} · 目标 ${env.OSS_BUCKET}.${env.OSS_REGION}.aliyuncs.com/${keyBase}/`);
console.log(files.map((f) => `  · ${f}`).join("\n"));
if (stableManifests.length) console.log(stableManifests.map(({ name }) => `  · ${name} (stable root)`).join("\n"));

// ── 渲染层 E2E 门禁（fail closed）──
// 放在真实上传之前、产物校验之后：本地产物先报错（离线、快），再查需要网络的结论。
// 判据是**将要发布的那个 commit** 上 `ui-e2e` 的结论——不是本机某个目录的状态，
// 所以「改坏了界面但没跑 CI」这种情况在这里被拦下。规则见 docs/release-gates.md。
const gate = checkUiE2eGate({ cwd: process.cwd() });
if (gate.ok) {
  console.log(`\n${formatGateResult(gate)}`);
} else if (dry) {
  // dry-run 不产生任何发布效果，因此只警告不阻止——它的用途是「预览会传什么」。
  console.warn(`\n⚠️  ${formatGateResult(gate)}`);
  console.warn("   dry-run 未实际上传，故不阻止；真实上传会被这条门禁拦下。");
} else {
  console.error(`\n❌ ${formatGateResult(gate)}`);
  console.error("   渲染层 E2E 未在将要发布的 commit 上通过，拒绝上传（fail closed）。");
  console.error("   查看运行：gh run list --workflow=ui-e2e.yml");
  console.error("   门禁规则：docs/release-gates.md 的「Release gate: rendering-layer E2E」一节。");
  process.exit(1);
}

if (dry) {
  console.log("\n(dry-run：未实际上传)");
  process.exit(0);
}

// ── 上传 ──
const { default: OSS } = await import("ali-oss");
const client = new OSS({
  region: env.OSS_REGION,
  bucket: env.OSS_BUCKET,
  endpoint: env.OSS_ENDPOINT || undefined,
  accessKeyId: env.OSS_ACCESS_KEY_ID,
  accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
  stsToken: env.OSS_SESSION_TOKEN || undefined,
  secure: true,
  // 大安装包（300MB+）PUT 耗时远超默认 60s，放宽到 10 分钟
  timeout: 600000,
  // authorizationV4: true, // 用默认 V3（V4 未真实验证）
});

const headers = { "Content-Type": "application/octet-stream" };
if (usePublicAcl) headers["x-oss-object-acl"] = "public-read";

let failed = 0;
for (const f of files) {
  const key = `${keyBase}/${f}`;
  try {
    process.stdout.write(`↑ ${f} … `);
    await client.put(key, join(distDir, f), { headers });
    console.log("OK");
  } catch (err) {
    failed += 1;
    console.log(`失败（${err.code ?? err.message}）`);
  }
}
// Never advertise a release whose immutable objects failed to upload.
if (failed) {
  console.error(`\n${failed} 个版本文件上传失败，稳定更新清单保持不变。`);
  process.exit(1);
}
for (const stable of stableManifests) {
  try {
    process.stdout.write(`↑ stable/${stable.name} … `);
    await client.put(`${prefix}/${stable.name}`, Buffer.from(stable.body), { headers: { ...headers, "Content-Type": stable.name.endsWith(".json") ? "application/json" : "text/yaml", "Cache-Control": "no-cache" } });
    console.log("OK");
  } catch (err) {
    failed += 1;
    console.log(`失败（${err.code ?? err.message}）`);
  }
}
if (failed) {
  console.error(`\n❌ ${failed} 个文件上传失败，修正后重跑（已成功的会覆盖，幂等）。`);
  process.exit(1);
}

// ── 直链清单 ──
writeFileSync(
  join(distDir, "release-links.md"),
  `# Lectern v${version} 下载直链\n\n${links.join("\n")}\n\n## 自动更新稳定清单\n\n${stableLinks.join("\n")}\n`,
);
console.log(`\n✅ 全部上传完成。直链清单已写入 dist/release-links.md：\n`);
console.log(links.join("\n"));
console.log(`\n下一步：把上述链接更新进 landing page 的下载区（zmzai-lectern-landing.html），并发布 GitHub Release 归档。`);
