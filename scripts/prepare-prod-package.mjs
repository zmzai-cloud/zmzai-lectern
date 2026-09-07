// 打包前准备：生成 .package-build/package.json。
// file:/link: 私有包（@zmzai/agent-framework、@zmzai/theme）替换为 npm pack 的
// tarball——npm 装 file: 目录会创建 symlink（打包后断链），link: 协议 npm 更是
// 直接 EUNSUPPORTEDPROTOCOL 拒装；tarball 才是实体拷贝。
// 之后 npm install --omit=dev 得到完全实体的生产 node_modules，
// 用于替换 next standalone 输出里不完整的 node_modules（pnpm 下 trace
// 只产出指向 .pnpm 的断链 symlink）。
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
mkdirSync(".package-build", { recursive: true });

const deps = {};
for (const [name, spec] of Object.entries(pkg.dependencies)) {
  const isLocal = spec.startsWith("file:") || spec.startsWith("link:");
  if (!isLocal) {
    deps[name] = spec;
    continue;
  }
  const dir = spec.slice(spec.indexOf(":") + 1);
  if (dir.endsWith(".tgz")) {
    copyFileSync(dir, `.package-build/${basename(dir)}`);
    deps[name] = `./${basename(dir)}`;
    continue;
  }
  execFileSync("npm", ["pack", "--silent", "--pack-destination", ".package-build", dir], { stdio: "inherit" });
  const { version } = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
  const tarball = `${name.replace(/^@/, "").replace(/\//, "-")}-${version}.tgz`;
  deps[name] = `./${tarball}`;
}

writeFileSync(
  ".package-build/package.json",
  `${JSON.stringify({ name: pkg.name, version: pkg.version, private: true, dependencies: deps }, null, 2)}\n`,
);
console.log("[prepare-prod-package] package.json 生成完毕");
