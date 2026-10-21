function versionParts(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error("更新版本号无效");
  const parts = value.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error("更新版本号无效");
  return parts;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isText(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
}

// 更新说明是纯展示字段：格式不对时宁可不展示，也不能让用户因此收不到更新。
function normalizeReleaseNotes(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || !validDate(value.date)
      || !Array.isArray(value.sections) || value.sections.length === 0 || value.sections.length > 8) return null;
    const sections = value.sections.map((section) => {
      if (!section || typeof section !== "object" || Array.isArray(section) || !isText(section.title, 40)
        || !Array.isArray(section.items) || section.items.length === 0 || section.items.length > 30) throw new Error("invalid");
      const items = section.items.map((item) => {
        if (!isText(item, 240)) throw new Error("invalid");
        return item.trim();
      });
      return { title: section.title.trim(), items };
    });
    const notes = { date: value.date, sections };
    return JSON.stringify(notes).length > 16 * 1024 ? null : notes;
  } catch {
    return null;
  }
}

// 发布侧严格校验：坏配置必须在上传前失败，而不是被客户端静默忽略。
function assertReleaseNotes(value) {
  const notes = normalizeReleaseNotes(value);
  if (!notes) throw new Error("更新说明格式无效：需 { date: YYYY-MM-DD, sections: [{ title, items: [...] }] }，序列化后不超过 16KB");
  return notes;
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
  return { version: manifest.version, name, path: file.path, size: file.size, sha512: file.sha512, releaseNotes: normalizeReleaseNotes(manifest.releaseNotes) };
}

module.exports = { selectRelease, normalizeReleaseNotes, assertReleaseNotes };
