import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { extractFile, listPackage, statFile } from "@electron/asar";

export async function digest(file, algorithm = "sha512", encoding = "base64") {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

// @electron/asar 在 win32 上按 path.sep（反斜杠）切分查找键；
// electron-builder 在 Windows 打出的 asar 头也是反斜杠路径。
// 所有带分隔符的 asar 查询必须先经此转换，否则 win32 必抛 "was not found"。
export function asarPath(p) {
  return p.split("/").join(sep);
}

export function artifactNames(version, platform) {
  requireThat(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version), "Invalid release version");
  if (platform === "darwin") return [`Lectern-${version}-arm64-mac.zip`];
  if (platform === "win32") return [`Lectern-Setup-${version}.exe`, `Lectern-${version}-win.zip`];
  throw new Error(`Unsupported release platform: ${platform}`);
}

export function stableManifest(raw, version) {
  const manifest = parse(raw);
  requireThat(manifest?.version === version, "Stable manifest version mismatch");
  requireThat(typeof manifest.path === "string" && Array.isArray(manifest.files), "Invalid update manifest");
  const prefix = `v${version}/`;
  return {
    ...manifest,
    path: prefix + manifest.path,
    files: manifest.files.map((file) => ({ ...file, url: prefix + file.url })),
  };
}

function safeFile(dir, name) {
  requireThat(typeof name === "string" && name.length > 0 && name === basename(name)
    && !/[\\/:?#%]/.test(name) && name !== "." && name !== "..", "Unsafe artifact filename");
  const path = join(dir, name);
  requireThat(existsSync(path) && statSync(path).isFile(), `Missing artifact: ${name}`);
  requireThat(statSync(path).size > 0, `Empty artifact: ${name}`);
  return path;
}

export async function verifyRelease(dir, version, platforms) {
  const verified = new Set();
  for (const platform of platforms) {
    const expected = artifactNames(version, platform);
    for (const name of expected) safeFile(dir, name);
    const manifestName = platform === "darwin" ? "latest-mac.yml" : "latest.yml";
    const manifest = parse(readFileSync(safeFile(dir, manifestName), "utf8"));
    requireThat(manifest?.version === version, `${manifestName}: version mismatch`);
    requireThat(Array.isArray(manifest.files) && manifest.files.length > 0, `${manifestName}: no files`);
    const seen = new Set();
    for (const entry of manifest.files) {
      const file = safeFile(dir, entry.url);
      requireThat(entry.url.includes(`-${version}`), `${manifestName}: stale artifact`);
      requireThat(!seen.has(entry.url), `${manifestName}: duplicate artifact`);
      seen.add(entry.url);
      requireThat(entry.size === statSync(file).size, `${entry.url}: size mismatch`);
      requireThat(entry.sha512 === await digest(file), `${entry.url}: SHA-512 mismatch`);
      verified.add(entry.url);
    }
    requireThat(seen.has(expected[0]), `${manifestName}: primary artifact missing`);
    requireThat(manifest.path === expected[0], `${manifestName}: primary path mismatch`);
    requireThat(manifest.sha512 === await digest(safeFile(dir, manifest.path)), `${manifestName}: legacy SHA-512 mismatch`);
    for (const name of expected) verified.add(name);
    verified.add(manifestName);
  }
  // Prevent a previous build or temporary NSIS uninstaller from being published.
  for (const name of readdirSync(dir)) {
    if (/\.(zip|exe|dmg)$/.test(name)) {
      requireThat(verified.has(name), `Unverified artifact in release directory: ${name}`);
    }
    if (name.endsWith(".blockmap")) {
      requireThat(verified.has(name.slice(0, -9)), `Orphan blockmap: ${name}`);
      safeFile(dir, name);
      verified.add(name);
    }
  }
  return [...verified].sort();
}

export function privatePackagePaths(files) {
  return files.filter((file) => {
    const path = file.replaceAll("\\", "/");
    if (/(^|\/)\.secret$|\.db(?:-wal|-shm)?$|\/\.env(?:\.[^/]*)?$/.test(path)) return true;
    // Dependency packages legitimately contain data directories and test fixtures.
    if (path.includes("/node_modules/")) return false;
    return /(^|\/)(data|\.workspace|\.harness-data|logs)(\/|$)|\.(jsonl|pem|p12|pfx)$|\/(settings|projects)\.json$/.test(path);
  });
}

export function verifyPackage(archive, version, platform, arch) {
  requireThat((platform === "darwin" && arch === "arm64") || (platform === "win32" && arch === "x64"), "Unsupported package target");
  const files = listPackage(archive).map((p) => p.replaceAll("\\", "/"));
  const forbidden = privatePackagePaths(files);
  requireThat(forbidden.length === 0, `Private data in package: ${forbidden.join(", ")}`);
  const pkg = JSON.parse(extractFile(archive, "package.json"));
  requireThat(pkg.version === version, "Packaged version mismatch");
  const root = ".next/standalone/";
  const server = extractFile(archive, asarPath(`${root}server.js`)).toString();
  requireThat(!/process\.chdir\(__dirname\)/.test(server), "Standalone server still changes cwd into asar");
  requireThat(files.some((p) => p.startsWith(`/${root}.next/static/`)), "Missing Next static resources");
  const target = `${platform}-${arch}`;
  const nativePaths = [
    platform === "darwin" ? `@next/swc-${target}/next-swc.${target}.node` : `@next/swc-${target}-msvc/next-swc.${target}-msvc.node`,
    `@img/sharp-${target}/lib/sharp-${target}.node`,
    `node-pty/prebuilds/${target}/pty.node`,
  ];
  if (platform === "win32") nativePaths[2] = `node-pty/prebuilds/${target}/conpty.node`;
  for (const native of nativePaths) {
    const relative = `${root}node_modules/${native}`;
    requireThat(files.includes(`/${relative}`), `Missing native module: ${native}`);
    requireThat(statFile(archive, asarPath(relative)).unpacked === true, `Native module packed inside asar: ${native}`);
    requireThat(existsSync(`${archive}.unpacked/${relative}`), `Missing unpacked native module: ${native}`);
  }
  if (platform === "darwin") {
    const helper = `${archive}.unpacked/${root}node_modules/node-pty/prebuilds/${target}/spawn-helper`;
    requireThat(existsSync(helper) && (statSync(helper).mode & 0o111) !== 0, "spawn-helper is not executable");
  }
  const opposite = platform === "win32" ? "darwin" : "win32";
  requireThat(!files.some((p) => new RegExp(`/(?:@next/swc-|@img/sharp-|node-pty/prebuilds/)${opposite}-`).test(p)), "Wrong-platform native dependencies");
  return { version, platform, arch, files: files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, target, platform] = process.argv.slice(2);
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  try {
    if (mode === "package") {
      console.log(verifyPackage(target, version, platform, platform === "darwin" ? "arm64" : "x64"));
    } else if (mode === "release") {
      console.log(await verifyRelease(target ?? "dist", version, platform ? [platform] : ["darwin", "win32"]));
    } else throw new Error("Usage: release-validation.mjs package <app.asar> <darwin|win32> | release <dist> [platform]");
  } catch (error) {
    console.error(`[release-validation] ${error.message}`);
    process.exitCode = 1;
  }
}
