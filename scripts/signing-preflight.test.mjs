import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { signingProblems } from "./signing-preflight.mjs";
const require = createRequire(import.meta.url);
const { applyReleaseDefaults, defaults } = require("../electron/release-defaults.cjs");

test("signed Mac release requires certificate and complete notarization credentials", () => {
  assert.equal(signingProblems("darwin", {}).length, 2);
  assert.ok(signingProblems("darwin", { CSC_LINK: "certificate", APPLE_ID: "id" }).length > 0);
  assert.deepEqual(signingProblems("darwin", { CSC_LINK: "certificate", APPLE_ID: "id", APPLE_APP_SPECIFIC_PASSWORD: "pw", APPLE_TEAM_ID: "team" }), []);
  assert.ok(signingProblems("darwin", { CSC_NAME: "-", APPLE_KEYCHAIN_PROFILE: "profile" }).length > 0);
});

test("signed Windows release cannot silently fall back to unsigned", () => {
  assert.ok(signingProblems("win32", {}).length > 0);
  assert.deepEqual(signingProblems("win32", { WIN_CSC_LINK: "certificate" }), []);
  assert.ok(signingProblems("linux", {}).length > 0);
});

test("release defaults contain only public configuration and preserve explicit overrides", () => {
  assert.deepEqual(Object.keys(defaults).sort(), ["MUZHI_URL", "OPENAI_BASE_URL", "OPENAI_MODEL", "SESSION_COOKIE_NAME"]);
  const env = { OPENAI_BASE_URL: "http://127.0.0.1:9999", PERSONAL_KEY: "test" };
  applyReleaseDefaults(env);
  assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:9999");
  assert.equal(env.MUZHI_URL, "https://muzhi.zmzai.cloud");
  assert.equal(env.PERSONAL_KEY, "test");
});
