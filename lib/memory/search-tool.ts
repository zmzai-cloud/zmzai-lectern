import { z } from "zod";
import type { ToolDef } from "@zmzai/agent-framework";

import type { Project } from "../projects.js";
import { searchProjectMemory, type MemorySearchHitResult } from "./service.js";

const SEARCH_DEFAULT_LIMIT = 8;
const SEARCH_MAX_LIMIT = 20;
const OUTPUT_MAX_CHARS = 3_000;
const FACT_MAX_CHARS = 400;

function format(query: string, result: MemorySearchHitResult): string {
  if (result.status === "deduped") {
    return `没有新的记忆：命中的 ${result.deduped} 条已在本次任务的背景记忆中注入，直接使用即可。`;
  }
  if (result.status === "empty") return `没有找到与「${query}」相关的项目记忆。`;

  const header = `[项目记忆检索: "${query}" — ${result.hits.length} 条]`;
  const lines: string[] = [header];
  let total = header.length;
  let used = 0;
  for (const hit of result.hits) {
    const text = hit.text.length > FACT_MAX_CHARS ? `${hit.text.slice(0, FACT_MAX_CHARS)}…` : hit.text;
    const score = hit.score !== undefined ? ` (${hit.score.toFixed(2)})` : "";
    const line = `- ${hit.memoryId ? `[${hit.memoryId}] ` : ""}${text}${score}`;
    if (total + 1 + line.length > OUTPUT_MAX_CHARS) break;
    lines.push(line);
    total += 1 + line.length;
    used += 1;
  }
  if (used < result.hits.length) lines.push(`…（另有 ${result.hits.length - used} 条未展开）`);
  lines.push("引用以上结论时标注 [memoryId]；与当前代码或用户最新说明冲突时以现状为准。");
  return lines.join("\n");
}

/**
 * memory_search（主动检索）：任务中途按需查项目长期记忆。
 * 与开头注入共用 binding 与账号门禁，独立预算、只读、无需审批。
 */
export function createMemorySearchTool(project: Pick<Project, "id" | "name">): ToolDef {
  return {
    id: "memory_search",
    label: "检索项目记忆",
    description:
      "检索当前项目此前沉淀的长期记忆（约定、决策、踩坑、常用命令）。以下情况应当先调用：" +
      "用户提到「上次/之前/以前/这个项目一直」或要求沿用既有做法；你要断言某个项目约定、架构决策或历史原因；" +
      "当前任务触及你尚不熟悉的模块。纯闲聊、单文件小改、问题已能从当前代码回答时不要调用。" +
      "返回条目带 memoryId，引用时标注；记忆可能过期，与当前代码或用户最新说明冲突时以现状为准。",
    parameters: z.object({
      query: z.string().min(1).max(400).describe("检索意图，用自然语言描述要找什么，不要只写关键词"),
      limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT).describe("最多返回条数"),
    }),
    permission: () => null,
    contract: { effect: [], retrySafety: "read_only", concurrency: { mode: "parallel_read" } },
    async execute(args, ctx) {
      const result = await searchProjectMemory(project, ctx.sessionId, args.query, args.limit);
      if (result.status === "unauthenticated") {
        return {
          title: "检索项目记忆",
          output: "项目记忆未接通或登录状态已失效，本次没有检索结果；请基于当前代码与用户说明继续。",
          metadata: { status: result.status },
        };
      }
      if (result.status === "unavailable") {
        return {
          title: "检索项目记忆",
          output: "项目记忆服务暂不可用，本次检索没有结果；请基于当前代码与用户说明继续。",
          metadata: { status: result.status },
        };
      }
      return {
        title: result.hits.length > 0 ? `检索到 ${result.hits.length} 条项目记忆` : "项目记忆无新增结果",
        output: format(args.query, result),
        metadata: { status: result.status, count: result.hits.length, deduped: result.deduped, bankId: result.bankId },
      };
    },
  };
}
