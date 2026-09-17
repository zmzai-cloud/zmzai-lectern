/** @type {import('next').NextConfig} */
import { fileURLToPath } from "node:url";

// 注意：用 .mjs 而非 .ts——打包后的生产运行时（next start / standalone server）
// 加载 .ts 配置需要 typescript，缺失时会触发 next 自动 pnpm install（在安装目录
// 里乱装包）。纯 JS 配置无此依赖。
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // 固定 workspace root：上级 zmzai/ 目录存在多余 lockfile（package-lock.json）时
  // Next 会误判 root，standalone 输出嵌套成 .next/standalone/zmzai-harness/server.js，
  // electron 壳按 .next/standalone/server.js 找不到入口直接退出（app 闪退）。
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
  // 桌面端打包：额外产出 .next/standalone（server.js + trace 出的运行时依赖，
  // 物理复制、无 symlink），Electron 壳直接 node server.js 起服务。
  output: "standalone",
  // 【安全】禁止把本机数据打进产物。
  // Next 的 standalone 文件追踪会把 `outputFileTracingRoot`（= 仓库根）下的
  // `data/**` 一并复制进 `.next/standalone/data/`。仓库根的 data/ 是历史遗留的
  // 老数据目录（已 gitignore），里面是**开发者的真实会话库与 .secret**，
  // 一旦混入就会随安装包公开发布——v0.2.0 至 v0.4.3 全部中招。
  // 显式排除，并在 scripts/check-standalone-clean.mjs 做构建后断言兜底。
  // `.workspace/**` 同属运行时残留：在仓库根起过服务就会生成（交付件/沙箱 demo /
  // .git 工作副本），已被 Next 追踪复制进过产物，随安装包发出去。与 data/ 同级对待。
  outputFileTracingExcludes: {
    "**": [
      "data/**",
      "**/data/**",
      "**/.secret",
      "**/*.db",
      "**/*.db-shm",
      "**/*.db-wal",
      "**/.workspace/**",
    ],
  },
  // 私有 TS 包，需显式转译
  transpilePackages: ["@zmzai/theme"],
  // serverExternal：不能被 bundle——framework 内部定位 wasm 资源依赖真实
  // 模块路径；web-tree-sitter 的 emscripten 胶水内部也调 node:module 的
  // createRequire，被 bundle 后 shim 成空壳必炸（R1 repo_map）。
  //
  // 文档解析库（阶段 C）同属这一类：
  //  - pdfjs-dist 靠真实路径定位 worker / 标准字体 / wasm，被打包即失效；
  //  - exceljs / mammoth 内含动态 require 与大量非 JS 资产，bundle 后体积与
  //    解析行为都不可预期；
  //  - fflate 是纯 JS，但保持 external 可以让它和上面几个一样走正常的
  //    node_modules 解析，少一条「只有它被内联」的差异。
  // standalone 产物由 Next 的文件追踪自动带上这些依赖，无需额外配置。
  serverExternalPackages: ["@zmzai/agent-framework", "web-tree-sitter", "pdfjs-dist", "mammoth", "exceljs", "fflate"],
  // NodeNext 后缀映射：theme 源码直发（.ts/.tsx 以 .js 说明符互引）
  webpack: (config, { isServer }) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    if (isServer) {
      // Next 服务端的 externals 数组只含 module.builtinModules（如 "fs"/"path"，
      // 无 "node:" 前缀），不含 node:fs/node:sqlite 这类 "node:" scheme 内建
      // 模块。代码一旦顶层 `import "node:sqlite"`（registry 版 @zmzai/agent-framework
      // 0.4.1 的 sqlite-store/sqlite-event-log 就是这么写的），webpack 会把
      // "node:..." 当成待打包资源 → UnhandledSchemeError（Reading from "node:fs"
      // is not handled by plugins）→ 所有 import runtime 链的路由（/api/models 等）
      // 编译期 500。这里用正则把所有 "node:" scheme 内建模块一并 external 掉，
      // 与 Next 内建 externals 行为对齐（serverExternalPackages 对 pnpm symlink
      // 包不生效，故走 externals 而非依赖它）。
      config.externals.push(/^node:/);
      // framework 与 web-tree-sitter（emscripten 胶水内调 createRequire）一旦被
      // bundle，wasm 资源定位必炸（R1 repo_map），一并 external。
      // 文档解析库同理（见上面 serverExternalPackages 的说明）。
      config.externals.push("@zmzai/agent-framework", "web-tree-sitter", "pdfjs-dist", "mammoth", "exceljs", "fflate");
    }
    return config;
  },
};

export default nextConfig;
