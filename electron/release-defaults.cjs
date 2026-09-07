// Public service addresses only. Never copy the developer's .env into a release.
const defaults = Object.freeze({
  OPENAI_BASE_URL: "https://relay.zmzai.cloud/api/v1",
  OPENAI_MODEL: "deepseek-chat",
  MUZHI_URL: "https://muzhi.zmzai.cloud",
  SESSION_COOKIE_NAME: "muzhi_session",
});

function applyReleaseDefaults(env) {
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in env)) env[key] = value;
  }
}

module.exports = { applyReleaseDefaults, defaults };
