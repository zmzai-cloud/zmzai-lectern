/**
 * MCP server 配置解析（N1 + P1 插件）：来源合并——
 * - 项目级：<workspaceRoot>/.zmzai/mcp.json（随项目走，可入库共享）
 * - 全局级：dataDir/mcp.json（用户机器级，如本机文件系统/浏览器 MCP）
 * - 插件（P1）：dataDir/plugins/<name>/plugin.json 与
 *   <workspaceRoot>/.zmzai/plugins/<name>/plugin.json，各插件用 plugin.json
 *   （Agent Plugins 1.0）声明，其 mcpServers 以 <plugin>/<server> 命名空间注入
 * 格式与 agent plugin 一致：{ mcpServers: { <name>: stdio|streamable-http|sse spec } }。
 * 同名时项目级覆盖全局级；解析错误收集进 errors，不阻塞其它 server。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parsePluginManifest, parsePluginMcp, type PluginMcpServer } from "@zmzai/agent-framework";
import { resolve } from "node:path";

import { dataDir } from "./runtime-constants.js";

export type McpConfigResult = {
  entries: { name: string; spec: PluginMcpServer }[];
  errors: string[];
  sources: string[];
};

export function loadMcpConfig(workspaceRoot: string): McpConfigResult {
  const entries = new Map<string, PluginMcpServer>();
  const errors: string[] = [];
  const sources: string[] = [];

  for (const file of [resolve(dataDir, "mcp.json"), resolve(workspaceRoot, ".zmzai", "mcp.json")]) {
    if (!existsSync(file)) continue;
    try {
      const parsed = parsePluginMcp(resolve(file, ".."), JSON.parse(readFileSync(file, "utf8")));
      for (const [name, spec] of Object.entries(parsed.servers)) entries.set(name, spec);
      errors.push(...parsed.errors.map((e) => `${file}: ${e}`));
      sources.push(file);
    } catch (e) {
      errors.push(`${file}: ${(e as Error).message}`);
    }
  }

  // 插件目录（P1）：全局与项目级 plugins/*/plugin.json 的 mcpServers，
  // 以 <plugin>/<server> 命名空间注入，不与裸配置同名冲突
  for (const pluginsRoot of [resolve(dataDir, "plugins"), resolve(workspaceRoot, ".zmzai", "plugins")]) {
    if (!existsSync(pluginsRoot)) continue;
    for (const dir of readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const manifestFile = resolve(pluginsRoot, dir.name, "plugin.json");
      if (!existsSync(manifestFile)) continue;
      const root = resolve(pluginsRoot, dir.name);
      try {
        const manifest = parsePluginManifest(JSON.parse(readFileSync(manifestFile, "utf8")));
        if (!manifest) {
          errors.push(`${manifestFile}: plugin.json 不合法（Agent Plugins 1.0）`);
          continue;
        }
        const mcpFile = resolve(root, "mcp.json");
        if (!existsSync(mcpFile)) continue;
        const parsed = parsePluginMcp(root, JSON.parse(readFileSync(mcpFile, "utf8")));
        for (const [name, spec] of Object.entries(parsed.servers)) entries.set(`${manifest.name}/${name}`, spec);
        errors.push(...parsed.errors.map((e) => `${mcpFile}: ${e}`));
        sources.push(root);
      } catch (e) {
        errors.push(`${manifestFile}: ${(e as Error).message}`);
      }
    }
  }

  return { entries: [...entries].map(([name, spec]) => ({ name, spec })), errors, sources };
}
