// 一条命令发版的纯逻辑：参数、版本比较、site/release.json 与 GitHub Release
// 正文。副作用全部留在 release-desktop.mjs，这里可以在 node:test 里直接跑。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { assertReleaseNotes } = require("../electron/update-contract.cjs");

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SITE_NOTE_MAX = 160;

export function parseVersion(value) {
  if (typeof value !== "string" || !VERSION.test(value)) throw new Error(`版本号无效：${value}（需 x.y.z）`);
  return value.split(".").map(Number);
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** 站点 asset_rev：同一天多次发版递增尾字母，跨天重置为 a。 */
export function nextAssetRev(previous, date) {
  const prefix = date.replace(/-/g, "");
  const match = /^(\d{8})([a-z])$/.exec(previous ?? "");
  if (match && match[1] === prefix) {
    const code = match[2].charCodeAt(0);
    if (code >= 122) throw new Error(`asset_rev 当日已用尽：${previous}`);
    return `${prefix}${String.fromCharCode(code + 1)}`;
  }
  return `${prefix}a`;
}

export function loadReleaseNotes(root, version) {
  parseVersion(version);
  const path = join(root, "release-notes", `${version}.json`);
  if (!existsSync(path)) {
    throw new Error(`缺少发布日志：release-notes/${version}.json`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`release-notes/${version}.json 不是合法 JSON：${error.message}`);
  }
  return assertReleaseNotes(raw);
}

/** 站点下载按钮旁的一句话。默认取发布日志第一条；太长则截断。 */
export function defaultSiteNote(notes) {
  const first = notes?.sections?.[0]?.items?.[0];
  if (typeof first !== "string" || !first.trim()) throw new Error("发布日志没有可用于站点说明的条目");
  return first.trim().length > 120 ? `${first.trim().slice(0, 119)}…` : first.trim();
}

function assertSiteNote(note) {
  const value = typeof note === "string" ? note.trim() : "";
  if (value.length < 4 || value.length > SITE_NOTE_MAX) {
    throw new Error(`站点说明需为 4-${SITE_NOTE_MAX} 字：${value}`);
  }
  // release_note 会被 sync-version.py 直接嵌进 HTML；日志是自家人写的，
  // 但仍在这里挡住会破坏页面或注入标签的字符。
  if (/[<>\r\n]/.test(value)) throw new Error("站点说明不能包含 < > 或换行");
  return value;
}

export function siteReleaseConfig(previous, { version, date, note }) {
  parseVersion(version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new Error(`发布日期无效：${date}`);
  const ossBase = (previous?.oss_base ?? "https://zmzai.oss-cn-beijing.aliyuncs.com/releases/harness").replace(/\/+$/, "");
  return {
    ...previous,
    version,
    release_date: date,
    pill: `v${version} · 更新日志`,
    release_note: assertSiteNote(note),
    asset_rev: nextAssetRev(previous?.asset_rev, date),
    site_url: previous?.site_url ?? "https://lectern.zmzai.cloud",
    oss_base: ossBase,
    artifacts: {
      macos_dmg: `Lectern-${version}-arm64.dmg`,
      macos_zip: `Lectern-${version}-arm64-mac.zip`,
      windows_exe: `Lectern-Setup-${version}.exe`,
      windows_zip: `Lectern-${version}-win.zip`,
      sha256: "SHA256SUMS.txt",
    },
  };
}

/** GitHub Release 只放说明与 OSS 直链（v0.11.2 起不挂安装包）。 */
export function githubReleaseBody({ version, notes, ossBase }) {
  parseVersion(version);
  const base = ossBase.replace(/\/+$/, "");
  const sections = notes.sections
    .map((section) => `### ${section.title}\n\n${section.items.map((item) => `- ${item}`).join("\n")}`)
    .join("\n\n");
  const links = [
    `- [macOS（Apple Silicon，DMG）](${base}/v${version}/Lectern-${version}-arm64.dmg)`,
    `- [macOS（ZIP，自动更新包）](${base}/v${version}/Lectern-${version}-arm64-mac.zip)`,
    `- [Windows（安装器）](${base}/v${version}/Lectern-Setup-${version}.exe)`,
    `- [Windows（ZIP）](${base}/v${version}/Lectern-${version}-win.zip)`,
    `- [SHA256 校验和](${base}/v${version}/SHA256SUMS.txt)`,
  ];
  return `## Lectern v${version}\n\n发布日志（${notes.date}）\n\n${sections}\n\n## 下载\n\n${links.join("\n")}\n`;
}

export function parseReleaseArgs(argv) {
  const options = {
    help: false, version: null, yes: false, dryRun: false, skipTests: false, skipBuild: false,
    skipUpdatePath: false, skipSite: false, skipGithub: false, force: false,
    siteDir: null, siteNote: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help": options.help = true; break;
      case "--version":
        if (!argv[i + 1]) throw new Error("--version 需要值");
        options.version = argv[++i]; break;
      case "--site-dir":
        if (!argv[i + 1]) throw new Error("--site-dir 需要值");
        options.siteDir = argv[++i]; break;
      case "--site-note":
        if (!argv[i + 1]) throw new Error("--site-note 需要值");
        options.siteNote = argv[++i]; break;
      case "--yes": options.yes = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--skip-tests": options.skipTests = true; break;
      case "--skip-build": options.skipBuild = true; break;
      case "--skip-update-path": options.skipUpdatePath = true; break;
      case "--skip-site": options.skipSite = true; break;
      case "--skip-github": options.skipGithub = true; break;
      case "--force": options.force = true; break;
      default: throw new Error(`未知参数：${arg}`);
    }
  }
  if (options.yes && options.dryRun) throw new Error("--yes 与 --dry-run 不能同时使用");
  return options;
}

/** dry-run 时打印的执行计划；顺序本身是发布正确性的一部分。 */
export function releaseSteps(options) {
  const steps = [];
  if (!options.skipTests) steps.push("typecheck + vitest + release tests");
  if (!options.skipBuild) {
    steps.push("macOS 构建");
    steps.push("macOS packaged smoke");
    steps.push("Windows 交叉构建（mac 产物保留/恢复）");
  }
  steps.push("双平台产物校验");
  steps.push("OSS 上传");
  steps.push("线上回读校验 verify:public");
  if (!options.skipUpdatePath) steps.push("旧版升级通道验证 verify:update-path");
  if (!options.skipSite) steps.push("lectern-site 同步 + 推送部署 + 线上校验");
  if (!options.skipGithub) steps.push("GitHub Release（仅说明与 OSS 直链）");
  return steps;
}
