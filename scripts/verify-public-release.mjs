import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { artifactNames, digest, verifyRelease } from "./release-validation.mjs";
import contract from "../electron/update-contract.cjs";

const root = "https://zmzai.oss-cn-beijing.aliyuncs.com/releases/harness/";
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const dist = "dist";
await verifyRelease(dist, version, ["darwin", "win32"]);
async function get(path) {
  const response = await fetch(new URL(path, root), { redirect: "error", signal: AbortSignal.timeout(600000), cache: "no-store" });
  assert.equal(response.status, 200, path);
  return response;
}
const desktop = await (await get("latest-desktop.json")).json();
assert.equal(desktop.version, version);
for (const [platform, arch, filename] of [["darwin", "arm64", "latest-mac.yml"], ["win32", "x64", "latest.yml"]]) {
  const stable = parse(await (await get(filename)).text());
  const local = parse(readFileSync(join(dist, filename), "utf8"));
  assert.equal(stable.version, version);
  assert.equal(stable.path, `v${version}/${local.path}`);
  const selected = contract.selectRelease(desktop, "0.0.0", platform, arch);
  assert.equal(selected.path, stable.path);
  assert.equal(selected.sha512, local.sha512);
  for (const name of artifactNames(version, platform)) {
    const response = await get(`v${version}/${name}`);
    const hash = createHash("sha512");
    let size = 0;
    for await (const chunk of response.body) { size += chunk.length; hash.update(chunk); }
    const remoteHash = hash.digest("base64");
    assert.equal(remoteHash, await digest(join(dist, name)), name);
    if (name === local.path) {
      assert.equal(size, selected.size);
      assert.equal(remoteHash, selected.sha512);
    }
    console.log(`Verified public artifact: ${name} (${size} bytes)`);
  }
}
assert.equal(await (await get(`v${version}/SHA256SUMS.txt`)).text(), readFileSync(join(dist, "SHA256SUMS.txt"), "utf8"));
console.log(`Public v${version} manifests, checksums and both platform downloads verified.`);
