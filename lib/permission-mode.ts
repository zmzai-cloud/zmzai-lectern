/**
 * 会话级权限模式（Codex 视觉基准 ④：Composer 常驻权限胶囊）。
 *
 * 三档模式 + 默认，全部落成 framework 的 session.permission 规则（引擎求值时
 * 会话规则优先级最高，最后一击）：
 *  - full     完全访问：`* /* allow` —— 所有工具直通（危险，amber 提示）
 *  - ask      每次确认：`* /* ask`   —— 所有工具逐一审批
 *  - readonly 只读：写类权限全 deny（edit/bash/terminal/git_write/connector/mcp/task）
 *  - default  默认：无模式规则，builtin 预设生效（edit 直通 / bash 等审批）
 *
 * 模式规则用 `lectern_mode` 哨兵规则标记（真实工具权限键永远不会是这个名字，
 * 因此哨兵本身在引擎里永不匹配，只作 UI 回显与切换清理的锚点）。切换模式时
 * stripModeRules 只剥离模式规则，「总是允许」沉淀的用户规则原样保留。
 */

import type { Ruleset } from "@zmzai/agent-framework";

export type PermissionMode = "default" | "full" | "ask" | "readonly";

export const PERMISSION_MODES: PermissionMode[] = ["default", "full", "ask", "readonly"];

const MODE_MARKER = "lectern_mode";

/** 只读模式下 deny 的写类权限键（与 framework PERMISSIONS 对齐）。 */
const WRITE_KEYS = ["edit", "bash", "terminal", "git_write", "connector", "mcp", "task"] as const;

type RuleLike = { permission: string; pattern: string; action?: string };

function marker(mode: PermissionMode) {
  return { permission: MODE_MARKER, pattern: mode, action: "allow" as const };
}

/** 某模式落地时会追加的规则（切换时按此精确剥离，避免误删用户沉淀）。 */
function modeRulesFor(mode: PermissionMode): RuleLike[] {
  switch (mode) {
    case "full":
      return [marker(mode), { permission: "*", pattern: "*", action: "allow" }];
    case "ask":
      return [marker(mode), { permission: "*", pattern: "*", action: "ask" }];
    case "readonly":
      return [marker(mode), ...WRITE_KEYS.map((k) => ({ permission: k, pattern: "*", action: "deny" }))];
    default:
      return [];
  }
}

/** 剥离全部模式规则（哨兵 + 各模式签名规则），保留用户「总是允许」沉淀。
 *  用户沉淀的 always 规则 permission/pattern 都是具体值（terminal 复合命令
 *  硬化后绝不产生 `*` 通配），不会命中这里的剥离签名。 */
export function stripModeRules(rules: unknown[] | undefined | null): unknown[] {
  if (!Array.isArray(rules)) return [];
  return rules.filter((r) => {
    const rule = r as RuleLike;
    if (!rule || typeof rule.permission !== "string") return true;
    if (rule.permission === MODE_MARKER) return false;
    // full/ask 签名：`* /* action`
    if (rule.permission === "*" && rule.pattern === "*") return false;
    // readonly 签名：写类键 `*` deny
    if (rule.action === "deny" && rule.pattern === "*" && (WRITE_KEYS as readonly string[]).includes(rule.permission)) return false;
    return true;
  });
}

/** 在既有会话规则上落某模式：剥离旧模式 → 追加新模式。返回值可直接写入
 *  store.updateSession 的 permission 字段（framework Ruleset）。 */
export function applyModeRules(rules: unknown[] | undefined | null, mode: PermissionMode): Ruleset {
  return [...stripModeRules(rules), ...modeRulesFor(mode)] as Ruleset;
}

/** 从会话规则回读当前模式（无哨兵 = default）。 */
export function detectPermissionMode(rules: unknown[] | undefined | null): PermissionMode {
  if (!Array.isArray(rules)) return "default";
  for (const r of rules) {
    const rule = r as RuleLike;
    if (rule && rule.permission === MODE_MARKER) {
      const mode = rule.pattern as PermissionMode;
      if (PERMISSION_MODES.includes(mode)) return mode;
    }
  }
  return "default";
}
