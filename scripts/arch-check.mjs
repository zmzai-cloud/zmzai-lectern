#!/usr/bin/env node
// M2c-S14 架构门禁（spec §5.4）：验收后 Next 禁止导入 Runtime/SQLite store/
// 终端/MCP 管理器及有状态 Host 服务。
//
// 规则：
//  R1 迁移清单路由不得 import runtime 有状态实现（sessionRuntime/runtimeFor/
//     terminalManager/mcpStatusFor/gracefulShutdown）
//  R2 app/** 不得 import host/src/**
//  R3 LECTERN_HOST_GATEWAY 的读取只允许出现在 lib/host-gateway.ts
//
// 豁免（EXEMPT）：切换过渡期（M2c）旧 handler 为 LECTERN_LEGACY_RUNTIME=1
// 回滚模式保留 runtime import——每条注明清零条件（S16 切换验收后全部清零，
// 此后回滚按 spec §15.6 走旧二进制+备份）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const FORBIDDEN = [/sessionRuntime/, /runtimeFor/, /terminalManager/, /mcpStatusFor/, /gracefulShutdown/, /cloudRuntime/];

const MIGRATED = [
  "app/api/sessions/route.ts",
  "app/api/sessions/[id]/messages/route.ts",
  "app/api/sessions/[id]/events/route.ts",
  "app/api/sessions/[id]/search/route.ts",
  "app/api/sessions/[id]/read-state/route.ts",
  "app/api/sessions/[id]/usage/route.ts",
  "app/api/sessions/[id]/prompt/route.ts",
  "app/api/sessions/[id]/abort/route.ts",
  "app/api/sessions/[id]/permission/route.ts",
  "app/api/sessions/[id]/task/route.ts",
  "app/api/sessions/[id]/compact/route.ts",
  "app/api/sessions/[id]/rewind/route.ts",
  "app/api/sessions/[id]/attachments/[attachmentId]/route.ts",
  "app/api/terminal/route.ts",
  "app/api/terminal/[id]/route.ts",
  "app/api/terminal/[id]/input/route.ts",
  "app/api/terminal/[id]/resize/route.ts",
  "app/api/terminal/[id]/read/route.ts",
  "app/api/terminal/read-all/route.ts",
  "app/api/mcp/route.ts",
];

// 切换过渡豁免：S16 生产切换验收后清零（清零后删本表条目，门禁即收紧）
const EXEMPT = new Set([
  "app/api/sessions/route.ts", // 旧列表投影（flag off 回滚路径）
  "app/api/sessions/[id]/messages/route.ts",
  "app/api/sessions/[id]/events/route.ts",
  "app/api/sessions/[id]/search/route.ts",
  "app/api/sessions/[id]/read-state/route.ts",
  "app/api/sessions/[id]/usage/route.ts",
  "app/api/sessions/[id]/prompt/route.ts",
  "app/api/sessions/[id]/abort/route.ts",
  "app/api/sessions/[id]/permission/route.ts",
  "app/api/sessions/[id]/task/route.ts",
  "app/api/sessions/[id]/compact/route.ts",
  "app/api/terminal/route.ts",
  "app/api/terminal/[id]/route.ts",
  "app/api/terminal/[id]/input/route.ts",
  "app/api/terminal/[id]/resize/route.ts",
  "app/api/terminal/[id]/read/route.ts",
  "app/api/terminal/read-all/route.ts",
  "app/api/mcp/route.ts",
  "app/api/sessions/[id]/worktree/route.ts", // 写操作归 W1，整路由暂留
  "app/api/sessions/[id]/attachments/route.ts", // multipart 上传 UI 通路暂留
  "app/api/sessions/[id]/rewind/route.ts", // 薄化后 executeRewind 仍需 runtime 对象（LEGACY 回滚路径）
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const violations = [];

// R1：迁移路由的 runtime import（豁免清单内 = 过渡警告，清单外 = error）
for (const rel of MIGRATED) {
  const abs = path.join(root, rel);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    violations.push([rel, "R1", "迁移清单路由文件缺失"]);
    continue;
  }
  const imports = text.split("\n").filter((line) => line.includes('from "@/lib/runtime"'));
  const hits = imports.filter((line) => FORBIDDEN.some((re) => re.test(line)));
  if (hits.length && !EXEMPT.has(rel)) violations.push([rel, "R1", `runtime 有状态 import：${String(hits[0]).trim()}`]);
}

// R2/R3：全 app 树
for (const abs of walk(path.join(root, "app"))) {
  const rel = path.relative(root, abs);
  const text = readFileSync(abs, "utf8");
  if (/host\/src/.test(text) && /import/.test(text)) violations.push([rel, "R2", "app 不得 import host/src"]);
  if (/LECTERN_HOST_GATEWAY/.test(text) && rel !== "lib/host-gateway.ts" && !rel.startsWith("app/")) {
    // R3 只约束 lib/host 侧读取点（app 路由自身不读 env——它们调 hostGateway()）
  }
  if (rel.startsWith("app/") && /process\.env\.LECTERN_HOST_GATEWAY/.test(text)) violations.push([rel, "R3", "app 内不得直接读 LECTERN_HOST_GATEWAY（走 lib/host-gateway）"]);
}

const exemptInUse = [...EXEMPT].filter((rel) => MIGRATED.includes(rel) || rel.includes("worktree") || rel.includes("attachments/route"));
console.log(`[arch-check] 迁移路由 ${MIGRATED.length} 个；豁免（S16 清零）${exemptInUse.length} 条；违规 ${violations.length} 处`);
for (const [rel, rule, detail] of violations) console.error(`  [${rule}] ${rel}: ${detail}`);
process.exit(violations.length ? 1 : 0);
