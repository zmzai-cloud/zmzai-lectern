/** 基础常量（独立模块，避免 projects.ts ↔ runtime.ts 循环依赖）。
 *  env 前缀已从 HARNESS_* 更名为 LECTERN_*（品牌更名第二阶段）；
 *  保留旧前缀兜底读取，已部署的 .env / 启动脚本不失效。 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** 读取环境变量（含"是否设置"的语义）。
 *
 * 【为什么不用 `process.env.FOO` 直接读】Next 的文件追踪器（@vercel/nft）会在
 * **构建期**把 `process.env.FOO` 折叠成构建机上的真实值，再拿它去解析
 * `path.join(process.env.X, "…")` 这类表达式，于是构建机的绝对路径被写进
 * `.next/server/**\/*.nft.json`。Windows 上表现为往 `.next/standalone` 里拼
 * `C:\Users\<构建用户>\AppData\…` 这类越界条目（跨盘复制必 ENOENT，同盘复制则
 * 会把仓库外的文件真的打进安装包——正是历史上 data/ 泄漏的同一机制）。
 * 经变量名参数间接读取后，追踪器无法在分析期折叠出具体路径，运行时行为不变。 */
function readEnv(name: string): string | undefined {
  return process.env[name];
}

/**
 * 数据目录解析（会话稳定性 P0-①）：
 *
 * 旧实现 `process.cwd()/data` 会让会话库随启动方式漂移——`next dev`（repo 根）、
 * 项目子目录启动、standalone 启动各得一套互不相通的库，表现为"重启后历史会话丢失"。
 *
 * 新实现固定到平台用户目录（与 Electron 打包版 userData/data 完全一致，打包版
 * 仍以 LECTERN_DATA_DIR 显式注入同一位置）：dev 与打包版、任意启动方式读写同一库。
 *
 * 【语义】LECTERN_DATA_DIR / HARNESS_DATA_DIR 是**最终数据目录**，不是"根"。
 * 命中时直接采用，不再补拼 `data`。v0.4.2 及更早把它当"根"再拼一级，导致打包版
 * 落到 <userData>/data/data，而 dev 落在 <userData>/data，两边会话互相看不见。
 * 注入侧写的本来就是 <userData>/data（= 平台默认路径），改语义后字符串无需变动。
 */
function platformDataRoot(): string {
  switch (process.platform) {
    case "win32":
      // Electron userData on Windows = %APPDATA%/<productName>
      return join(readEnv("APPDATA") ?? join(homedir(), "AppData", "Roaming"), "Lectern");
    case "darwin":
      // Electron userData on macOS = ~/Library/Application Support/<productName>
      return join(homedir(), "Library", "Application Support", "Lectern");
    default:
      // Linux: XDG 规范（Electron userData = $XDG_CONFIG_HOME/<productName>，
      // 数据放 XDG_DATA 侧更合适，lectern 小写命名）
      return join(readEnv("XDG_DATA_HOME") ?? join(homedir(), ".local", "share"), "lectern");
  }
}

/** 显式覆盖值（迁移脚本、测试、Electron 注入用）；未设置时返回 undefined。 */
function dataDirOverride(): string | undefined {
  const raw = readEnv("LECTERN_DATA_DIR") ?? readEnv("HARNESS_DATA_DIR");
  return raw ? resolve(raw) : undefined;
}

export const dataDir = dataDirOverride() ?? resolve(platformDataRoot(), "data");

export const defaultWorkspaceRoot = resolve(
  readEnv("LECTERN_WORKSPACE") ??
    readEnv("HARNESS_WORKSPACE") ??
    readEnv("ZMZAI_WORKSPACE") ??
    resolve(process.cwd(), ".workspace"),
);
