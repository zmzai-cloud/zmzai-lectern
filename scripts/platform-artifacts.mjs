// 双平台发版的产物保留：
// build-win-cross.sh 必须清空 dist 才能避免旧 Windows 产物混入，但 mac 产物
// 已经构建好、还等着和 win 一起上传。这里在清理前把「另一个平台」的产物
// 挪到 .release-preserve/<version>/，构建结束（或脚本失败退出）再挪回来。
//
// 用同卷 rename 而不是 copy：dist 里的 .app/.dmg 有几百 MB，复制纯属浪费。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BLOCKMAP = ".blockmap";

/** 产物 → 平台。未知文件返回 null（不保留，随 dist 一起清理）。 */
export function artifactPlatform(name, version) {
  if (name === "latest-mac.yml" || name === "mac-arm64" || name === "mac") return "darwin";
  if (name === "latest.yml" || name === "win-unpacked" || name === "win") return "win32";
  const base = name.endsWith(BLOCKMAP) ? name.slice(0, -BLOCKMAP.length) : name;
  if (!base.includes(`-${version}`)) return null;
  if (/^Lectern-.*-arm64(?:-mac)?\.(?:zip|dmg)$/.test(base)) return "darwin";
  if (/^Lectern-Setup-.*\.exe$/.test(base) || /^Lectern-.*-win\.zip$/.test(base)) return "win32";
  return null;
}

export function storeDir(root, version) {
  return join(root, ".release-preserve", version);
}

/** 把 dist 里属于「非 platform」的产物挪进保留区，返回挪走的文件名。 */
export function preservePlatformArtifacts({ root, platform, version }) {
  const dist = join(root, "dist");
  if (!existsSync(dist)) return [];
  const names = readdirSync(dist).filter((name) => {
    const owner = artifactPlatform(name, version);
    return owner !== null && owner !== platform;
  });
  if (!names.length) return [];
  const store = storeDir(root, version);
  mkdirSync(store, { recursive: true });
  for (const name of names) {
    const target = join(store, name);
    if (existsSync(target)) {
      throw new Error(`保留区已有同名产物：${target}（上次构建中断？先跑 restore）`);
    }
    renameSync(join(dist, name), target);
  }
  return names;
}

/** 把保留区产物挪回 dist，返回恢复的文件名。 */
export function restorePlatformArtifacts({ root, platform, version }) {
  const store = storeDir(root, version);
  if (!existsSync(store)) return [];
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  const names = [];
  for (const name of readdirSync(store)) {
    if (artifactPlatform(name, version) === platform) {
      throw new Error(`保留区混入当前平台产物：${name}`);
    }
    const target = join(dist, name);
    if (existsSync(target)) {
      throw new Error(`恢复目标已存在：${target}（分平台构建残留，先清理再重跑）`);
    }
    renameSync(join(store, name), target);
    names.push(name);
  }
  rmdirSync(store);
  try { rmdirSync(join(root, ".release-preserve")); } catch { /* 还有其他版本的保留区 */ }
  return names;
}

function main(argv) {
  const [command, platform] = argv;
  if (!["preserve", "restore"].includes(command) || !["darwin", "win32"].includes(platform)) {
    console.error("用法：node scripts/platform-artifacts.mjs preserve|restore darwin|win32");
    return 2;
  }
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const names = command === "preserve"
    ? preservePlatformArtifacts({ root, platform, version })
    : restorePlatformArtifacts({ root, platform, version });
  const label = command === "preserve" ? "保留" : "恢复";
  console.log(`${label} ${platform} 的对侧产物：${names.length ? names.join("、") : "无"}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
