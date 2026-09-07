function versionParts(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error("更新版本号无效");
  const parts = value.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error("更新版本号无效");
  return parts;
}
function selectRelease(manifest, current, platform, arch) {
  if (manifest?.schema !== 1) throw new Error("不支持的更新清单版本");
  const latest = versionParts(manifest.version), installed = versionParts(current);
  const first = latest.findIndex((n, i) => n !== installed[i]);
  if (first === -1 || latest[first] < installed[first]) return null;
  const name = platform === "darwin" && arch === "arm64" ? `Lectern-${manifest.version}-arm64-mac.zip`
    : platform === "win32" && arch === "x64" ? `Lectern-Setup-${manifest.version}.exe` : null;
  const file = manifest.platforms?.[`${platform}-${arch}`];
  if (!name || file?.path !== `v${manifest.version}/${name}` || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 2 ** 31
    || typeof file.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) throw new Error("更新清单中的安装包无效");
  return { version: manifest.version, name, path: file.path, size: file.size, sha512: file.sha512 };
}
module.exports = { selectRelease };
