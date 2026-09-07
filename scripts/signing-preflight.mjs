import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function signingProblems(platform, env) {
  if (platform === "darwin") {
    const problems = [];
    if (!env.CSC_LINK && !env.CSC_NAME) problems.push("CSC_LINK or CSC_NAME (Developer ID Application certificate)");
    const appleId = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID;
    const apiKey = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER;
    const keychain = env.APPLE_KEYCHAIN_PROFILE;
    if (!appleId && !apiKey && !keychain) problems.push("Apple notarization credentials or APPLE_KEYCHAIN_PROFILE");
    if (env.CSC_NAME === "-") problems.push("Developer ID certificate required, not ad-hoc identity");
    if (env.CSC_IDENTITY_AUTO_DISCOVERY === "false" && !env.CSC_LINK) problems.push("CSC identity discovery is disabled");
    return problems;
  }
  if (platform === "win32") return env.WIN_CSC_LINK || env.CSC_LINK ? [] : ["WIN_CSC_LINK or CSC_LINK (Authenticode certificate)"];
  return ["Unsupported signing platform"];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = signingProblems(process.argv[2], process.env);
  if (problems.length) {
    console.error("Signed release blocked. Missing configuration:\n" + problems.join("\n"));
    process.exitCode = 1;
  } else console.log("Signing configuration present; certificate validity is checked during signing.");
}
