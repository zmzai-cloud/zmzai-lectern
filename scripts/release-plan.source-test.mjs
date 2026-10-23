import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions, defaultSiteNote, githubReleaseBody, loadReleaseNotes, nextAssetRev,
  parseReleaseArgs, parseVersion, releaseSteps, siteReleaseConfig,
} from "./release-plan.mjs";

const notes = {
  date: "2026-10-23",
  sections: [
    { title: "更新", items: ["下载支持断点续传与暂停", "安装失败会在下次启动给出原因"] },
    { title: "修复", items: ["修复 Windows 构建清空 mac 产物的问题"] },
  ],
};

test("versions compare numerically, not lexicographically", () => {
  assert.equal(compareVersions("0.16.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.16.0", "0.16.0"), 0);
  assert.equal(compareVersions("0.16.0", "0.16.1"), -1);
  assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
  for (const value of ["1.2", "v1.2.3", "01.2.3", "1.2.3-beta"]) assert.throws(() => parseVersion(value));
});

test("asset revision resets per day and increments within a day", () => {
  assert.equal(nextAssetRev("20261021a", "2026-10-23"), "20261023a");
  assert.equal(nextAssetRev("20261023a", "2026-10-23"), "20261023b");
  assert.throws(() => nextAssetRev("20261023z", "2026-10-23"), /已用尽/);
});

test("release notes must exist and pass the same contract as the updater", (t) => {
  const root = mkdtempSync(join(tmpdir(), "lectern-plan-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "release-notes"));
  writeFileSync(join(root, "release-notes", "0.16.0.json"), JSON.stringify(notes));
  assert.deepEqual(loadReleaseNotes(root, "0.16.0"), notes);
  assert.throws(() => loadReleaseNotes(root, "0.16.1"), /缺少发布日志/);

  writeFileSync(join(root, "release-notes", "0.16.1.json"), "{");
  assert.throws(() => loadReleaseNotes(root, "0.16.1"), /不是合法 JSON/);

  writeFileSync(join(root, "release-notes", "0.16.2.json"), JSON.stringify({ date: "2026-02-30", sections: [] }));
  assert.throws(() => loadReleaseNotes(root, "0.16.2"), /更新说明格式无效/);
});

test("site note defaults to the first release-note item and is bounded", () => {
  assert.equal(defaultSiteNote(notes), "下载支持断点续传与暂停");
  const long = { ...notes, sections: [{ title: "更新", items: ["长".repeat(130)] }] };
  const shortened = defaultSiteNote(long);
  assert.equal(shortened.length, 120);
  assert.ok(shortened.endsWith("…"));
});

test("site release.json keeps site identity and derives every versioned field", () => {
  const previous = {
    version: "0.16.0", release_date: "2026-10-21", pill: "v0.16.0 · 更新日志",
    release_note: "旧说明", asset_rev: "20261021a",
    site_url: "https://lectern.zmzai.cloud", oss_base: "https://example.com/harness/",
  };
  const config = siteReleaseConfig(previous, { version: "0.17.0", date: "2026-10-23", note: "一条新的说明" });
  assert.equal(config.version, "0.17.0");
  assert.equal(config.release_date, "2026-10-23");
  assert.equal(config.pill, "v0.17.0 · 更新日志");
  assert.equal(config.asset_rev, "20261023a");
  assert.equal(config.oss_base, "https://example.com/harness");
  assert.equal(config.site_url, previous.site_url);
  assert.deepEqual(config.artifacts, {
    macos_dmg: "Lectern-0.17.0-arm64.dmg",
    macos_zip: "Lectern-0.17.0-arm64-mac.zip",
    windows_exe: "Lectern-Setup-0.17.0.exe",
    windows_zip: "Lectern-0.17.0-win.zip",
    sha256: "SHA256SUMS.txt",
  });
  assert.throws(() => siteReleaseConfig(previous, { version: "0.17.0", date: "2026-10-23", note: "<b>坏</b>" }), /不能包含/);
  assert.throws(() => siteReleaseConfig(previous, { version: "0.17.0", date: "2026-10-23", note: "短" }), /4-160/);
});

test("GitHub release body carries notes and OSS links only", () => {
  const body = githubReleaseBody({ version: "0.17.0", notes, ossBase: "https://example.com/harness/" });
  assert.match(body, /## Lectern v0\.17\.0/);
  assert.match(body, /### 更新/);
  assert.match(body, /- 下载支持断点续传与暂停/);
  assert.match(body, /https:\/\/example\.com\/harness\/v0\.17\.0\/Lectern-Setup-0\.17\.0\.exe/);
  assert.match(body, /SHA256SUMS\.txt/);
});

test("CLI arguments parse strictly and mutually exclusive modes are rejected", () => {
  const parsed = parseReleaseArgs(["--version", "0.17.0", "--yes", "--skip-site", "--site-dir", "../site", "--force"]);
  assert.equal(parsed.version, "0.17.0");
  assert.equal(parsed.yes, true);
  assert.equal(parsed.skipSite, true);
  assert.equal(parsed.siteDir, "../site");
  assert.equal(parsed.force, true);
  assert.throws(() => parseReleaseArgs(["--nope"]), /未知参数/);
  assert.throws(() => parseReleaseArgs(["--yes", "--dry-run"]), /不能同时使用/);
  assert.throws(() => parseReleaseArgs(["--version"]), /需要值/);
});

test("release steps keep the irreversible ordering", () => {
  const steps = releaseSteps({});
  const index = (text) => steps.findIndex((step) => step.includes(text));
  assert.ok(index("macOS 构建") < index("Windows 交叉构建"));
  assert.ok(index("Windows 交叉构建") < index("双平台产物校验"));
  assert.ok(index("双平台产物校验") < index("OSS 上传"));
  assert.ok(index("OSS 上传") < index("verify:public"));
  assert.ok(index("verify:public") < index("verify:update-path"));
  assert.ok(index("verify:update-path") < index("lectern-site"));
  assert.ok(index("lectern-site") < index("GitHub Release"));
  assert.deepEqual(releaseSteps({ skipTests: true, skipBuild: true, skipSite: true, skipGithub: true, skipUpdatePath: true }),
    ["双平台产物校验", "OSS 上传", "线上回读校验 verify:public"]);
});
