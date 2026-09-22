/**
 * 插件管理（P1 最小闭环）：插件 = 含 plugin.json（Agent Plugins 1.0）的目录，
 * 可选携带 mcp.json（MCP server 声明）与 skills/。安装 = 把目录拷贝到
 * <workspaceRoot>/.zmzai/plugins/<name>/（项目级，随项目走）。
 * 市场安装后续接 relay 目录服务，本地路径安装先行。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { parsePluginManifest } from "@zmzai/agent-framework";
import { basename, resolve } from "node:path";

import { dataDir } from "./runtime-constants.js";

export type PluginInfo = {
  name: string;
  version?: string;
  description?: string;
  /** 安装位置：project = <workspace>/.zmzai/plugins，global = dataDir/plugins。 */
  scope: "project" | "global";
  /** 插件根目录（绝对路径）。 */
  root: string;
  hasMcp: boolean;
};

function readPluginsFrom(pluginsRoot: string, scope: PluginInfo["scope"]): PluginInfo[] {
  if (!existsSync(pluginsRoot)) return [];
  const out: PluginInfo[] = [];
  for (const dir of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const root = resolve(pluginsRoot, dir.name);
    const manifestFile = resolve(root, "plugin.json");
    if (!existsSync(manifestFile)) continue;
    try {
      const manifest = parsePluginManifest(JSON.parse(readFileSync(manifestFile, "utf8")));
      if (!manifest) continue;
      out.push({
        name: manifest.name,
        ...(manifest.version ? { version: manifest.version } : {}),
        ...(manifest.description ? { description: manifest.description } : {}),
        scope,
        root,
        hasMcp: existsSync(resolve(root, "mcp.json")),
      });
    } catch {
      // 清单损坏的目录跳过（mcp-config 侧会报 errors）
    }
  }
  return out;
}

/** 已安装插件清单：全局 + 项目级（项目级在前，同名只出现一次）。 */
export function listPlugins(workspaceRoot: string): PluginInfo[] {
  const project = readPluginsFrom(resolve(workspaceRoot, ".zmzai", "plugins"), "project");
  const global = readPluginsFrom(resolve(dataDir, "plugins"), "global");
  const seen = new Set(project.map((p) => p.name));
  return [...project, ...global.filter((p) => !seen.has(p.name))];
}

export type InstallResult =
  | { ok: true; plugin: PluginInfo }
  | { ok: false; error: string };

/** 从本地目录安装插件到项目级 plugins/：校验 plugin.json 后整目录拷贝。 */
export function installPluginFromPath(sourceDir: string, workspaceRoot: string): InstallResult {
  const root = resolve(sourceDir.trim());
  const manifestFile = resolve(root, "plugin.json");
  if (!existsSync(manifestFile)) return { ok: false, error: `源目录缺少 plugin.json：${root}` };
  let name: string;
  try {
    const manifest = parsePluginManifest(JSON.parse(readFileSync(manifestFile, "utf8")));
    if (!manifest) return { ok: false, error: `${manifestFile}: plugin.json 不合法（Agent Plugins 1.0）` };
    name = manifest.name;
  } catch (e) {
    return { ok: false, error: `${manifestFile}: ${(e as Error).message}` };
  }
  if (resolve(root) === resolve(workspaceRoot) || resolve(root).startsWith(resolve(workspaceRoot) + "/")) {
    return { ok: false, error: "不能把工作区内的目录安装到自身" };
  }
  const target = resolve(workspaceRoot, ".zmzai", "plugins", name);
  try {
    mkdirSync(resolve(workspaceRoot, ".zmzai", "plugins"), { recursive: true });
    rmSync(target, { recursive: true, force: true }); // 同名覆盖安装
    cpSync(root, target, { recursive: true });
  } catch (e) {
    return { ok: false, error: `拷贝失败：${(e as Error).message}` };
  }
  const installed = readPluginsFrom(resolve(workspaceRoot, ".zmzai", "plugins"), "project").find((p) => p.name === name);
  return installed
    ? { ok: true, plugin: installed }
    : { ok: false, error: `安装后清单校验失败（${basename(target)}）` };
}

/** 卸载项目级插件（全局级插件不在此卸载，需手动删除 dataDir/plugins/<name>）。 */
export function uninstallPlugin(name: string, workspaceRoot: string): boolean {
  const target = resolve(workspaceRoot, ".zmzai", "plugins", name);
  if (!existsSync(target)) return false;
  rmSync(target, { recursive: true, force: true });
  return true;
}
