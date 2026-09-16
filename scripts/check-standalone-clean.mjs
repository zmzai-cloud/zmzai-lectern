#!/usr/bin/env node
/** 构建后断言：standalone 产物里不得混入本机数据。
 *
 * 背景：Next 的 standalone 文件追踪会按 `outputFileTracingRoot`（= 仓库根）把
 * `data/**` 复制进 `.next/standalone/data/`，而仓库根的 data/ 是历史遗留的老
 * 数据目录（已 gitignore），里面是开发者的真实会话库（zmzai.db / *.jsonl）与
 * 本地密钥材料 .secret。一旦混入就会随安装包公开发布 —— v0.2.0 至 v0.4.3 的
 * 双平台产物全部中招，只能全线下架重发。
 *
 * next.config.mjs 的 outputFileTracingExcludes 是主防线，本脚本是兜底：
 * 任何一层失效都会让打包在发布前失败，而不是带着隐私数据发出去。
 *
 * 用法：node scripts/check-standalone-clean.mjs [--dir <standalone 路径>]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const dirIdx = process.argv.indexOf("--dir");
const standalone =
  dirIdx >= 0 ? resolve(process.argv[dirIdx + 1]) : resolve(process.cwd(), ".next", "standalone");

if (!existsSync(standalone)) {
  console.error(`❌ 找不到 standalone 目录：${standalone}`);
  process.exit(1);
}

// 出现任一特征即视为混入了本机数据
const FORBIDDEN_NAMES = new Set([".secret", "settings.json", "projects.json", "zmzai.db"]);
const FORBIDDEN_SUFFIX = [".db", ".db-shm", ".db-wal", ".jsonl"];
const FORBIDDEN_DIRS = new Set(["data", "sessions", "messages", "parts"]);

// standalone 根目录白名单：只认产���该有的东西，其余一律中止。
// 白名单而非黑名单——运行时残留（在 standalone 目录下起过服务就会留下 .workspace、
// logs/、.secret 等）不该靠"猜特征"拦截，靠"只放行已知项"更稳。
const ROOT_ALLOWLIST = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".next",
  "node_modules",
  "package.json",
  "public",
  "server.js",
]);
const rootStrays = [];

/** 失败时自证：把可疑条目描述清楚，避免只看到一句"多了个 app"。
 *  Windows 原生构建上还可能出现 Next 的越界追踪——`.nft.json` 里出现本仓库之外的
 *  绝对路径（例如另一个盘符上的 C:\Users\…），Next 会把它拼成
 *  `.next/standalone/C:\Users\…` 再 mkdir，报 ENOENT。两者症状同源，都得看得见。 */
function describe(entryPath) {
  try {
    const st = statSync(entryPath);
    if (st.isSymbolicLink()) return `symlink -> ${readlinkSync(entryPath)}`;
    if (st.isDirectory()) {
      const kids = readdirSync(entryPath).slice(0, 8);
      const more = readdirSync(entryPath).length - kids.length;
      return `dir, ${kids.join(", ")}${more > 0 ? ` …(+${more})` : ""}`;
    }
    return `file, ${st.size} bytes`;
  } catch (err) {
    return `无法读取（${err.code ?? err.message}）`;
  }
}

/** 扫描 `.next/**\/*.nft.json`，按三类「异常追踪条目」归集：
 *  - outside：解析后落在仓库之外（构建机绝对路径直陈）；
 *  - drive：路径里出现盘符伪段（如 `..\..\..\..\..\C:\Users\…`——Next 的 trace
 *    插件把 nft 给的绝对路径当相对路径 join 进仓库根，`C:` 沦为普通目录名。
 *    这类条目 resolve 后仍在「仓库内」，单靠前缀比对必然漏报）；
 *  - source：解析后落在仓库的源码目录（app/lib/components/…）——源码不该进
 *    standalone，物化后会变成根部残留目录。
 *  三类都只报告不判定成败：真正会进产物的问题由根部白名单 + 特征扫描兜住。 */
const SOURCE_TOP_DIRS = new Set([
  "app",
  "lib",
  "components",
  "electron",
  "scripts",
  "docs",
  "legacy",
  "e2e",
  "tests",
  "demos",
]);

function suspiciousTraces(root, maxPerFile = 6) {
  const nftRoot = join(root, ".next");
  if (!existsSync(nftRoot)) return [];
  const files = [];
  (function walkNft(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkNft(p);
      else if (e.name.endsWith(".nft.json")) files.push(p);
    }
  })(nftRoot);

  const out = [];
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const dir = file.slice(0, file.lastIndexOf(sep));
    const kinds = { outside: [], drive: [], source: [] };
    for (const rel of data.files ?? []) {
      // 盘符伪段按原始条目判定（分隔符两种都拆），不依赖 resolve 语义
      const rawSegments = String(rel).split(/[\\/]/);
      if (rawSegments.some((s) => /^[A-Za-z]:$/.test(s))) {
        kinds.drive.push(rel);
        continue;
      }
      const abs = resolve(dir, rel);
      if (!abs.startsWith(root + sep)) {
        kinds.outside.push(rel);
        continue;
      }
      const relToRoot = abs.slice(root.length + 1);
      if (SOURCE_TOP_DIRS.has(relToRoot.split(sep)[0])) kinds.source.push(rel);
    }
    const present = Object.entries(kinds).filter(([, v]) => v.length > 0);
    if (present.length) {
      out.push({
        file: file.slice(root.length + 1),
        kinds: Object.fromEntries(present.map(([k, v]) => [k, { total: v.length, sample: v.slice(0, maxPerFile) }])),
      });
    }
  }
  return out;
}

const hits = [];

function walk(dir, depth, relBase) {
  if (depth > 4) return; // 只查浅层，node_modules 无需遍历
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (depth === 0) {
      if (name === "node_modules" || name === ".next") continue;
      if (!ROOT_ALLOWLIST.has(name)) {
        rootStrays.push(name);
        continue;
      }
    }
    const full = join(dir, name);
    const rel = relBase ? `${relBase}/${name}` : name;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (depth === 0 && FORBIDDEN_DIRS.has(name)) {
        hits.push(`${rel}/（目录）`);
        continue;
      }
      walk(full, depth + 1, rel);
      continue;
    }
    if (FORBIDDEN_NAMES.has(name)) hits.push(rel);
    else if (FORBIDDEN_SUFFIX.some((s) => name.endsWith(s))) hits.push(rel);
  }
}

walk(standalone, 0, "");

const root = resolve(process.cwd());
const report = [];

if (rootStrays.length > 0) {
  report.push("❌ standalone 根目录出现非预期条目，禁止打包：\n");
  for (const s of rootStrays) report.push(`   · ${s} —— ${describe(join(standalone, s))}`);
  report.push(
    "\n常见原因：曾在 .next/standalone 目录下直接起过服务做验证，" +
      "留下了 .workspace / logs / data 等运行时残留。\n" +
      "      next build 不会清理它们，而 files 规则 `.next/standalone/**` 会把它们一起打进包。\n" +
      "      处理：mv 走再重新 pnpm build。\n" +
      "      每条后面的括号是它下一层的内容，用来判断它到底是什么。",
  );
}

if (hits.length > 0) {
  report.push("❌ standalone 产物中检测到疑似本机数据，禁止打包：\n");
  for (const h of hits.slice(0, 40)) report.push(`   · ${h}`);
  if (hits.length > 40) report.push(`   … 另有 ${hits.length - 40} 项`);
  report.push(
    "\n排查：仓库根 data/ 是否被 Next 文件追踪带进来了？\n" +
      "      next.config.mjs 的 outputFileTracingExcludes 是否生效？\n" +
      "      如确需发布，请先确认这些文件不含任何私有数据。",
  );
}

// 异常追踪单独报告：它们本身不决定成败（越界/盘符条目在 Windows 上因路径非法
// 复制必失败，源码残留由 strip-standalone-source.mjs 在守卫之前清理），但它们
// 说明了「构建机路径或源码进了追踪图」，必须看得见。
const KIND_LABELS = {
  outside: "解析后落在仓库之外（构建机绝对路径）",
  drive: "含盘符伪段（Next 把绝对路径当相对路径 join，如 ..\\..\\C:\\Users\\…）",
  source: "指向仓库源码目录（源码不该进 standalone）",
};
const suspicious = suspiciousTraces(root);
if (suspicious.length > 0) {
  report.push("\n⚠️ .nft.json 中存在异常追踪条目：\n");
  for (const s of suspicious) {
    report.push(`   · ${s.file}`);
    for (const [kind, info] of Object.entries(s.kinds)) {
      report.push(`       [${kind}] ${info.total} 条 —— ${KIND_LABELS[kind] ?? kind}，例如：`);
      for (const sample of info.sample) report.push(`         ${sample}`);
    }
  }
  report.push(
    "\n影响：outside/drive 类条目若与仓库同盘会被真的复制进产物（历史 data/ 泄漏同机制）；\n" +
      "      跨盘 / 含盘符伪段时 mkdir 必失败（Next 会打 Failed to copy traced files 警告，构建不中断）。\n" +
      "      source 类条目物化为 standalone 根部源码目录，由 strip-standalone-source.mjs 镜像校验后清理。\n" +
      "      排查方向：模块顶层是否读了 process.env.APPDATA / os.homedir()；Next trace 插件在 Windows 上的路径处理。",
  );
}

if (report.length > 0) {
  const text = report.join("\n");
  console.error(text);
  // 落盘一份：CI 里 build 脚本会立刻中断，stdout 可能被截断，文件更可靠。
  try {
    const outDir = join(root, "test-results");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "standalone-diagnostic.txt"), text + "\n");
    console.error("\n（完整诊断已写入 test-results/standalone-diagnostic.txt）");
  } catch {
    /* 落盘失败不影响判定 */
  }
}

if (rootStrays.length > 0 || hits.length > 0) process.exit(1);

console.log("✅ standalone 产物干净（无 .secret / 会话库 / 本机数据）");
if (suspicious.length === 0) console.log("✅ 追踪图无异常条目（无越界 / 盘符伪段 / 源码目录指向）");
