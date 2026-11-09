import { evaluateRules } from "@zmzai/agent-framework";
import { describe, expect, it } from "vitest";

import { applyModeRules, detectPermissionMode, stripModeRules } from "./permission-mode.js";

/** P0 2026-11-09：readonly 的拒绝清单必须覆盖新工具权限键——用框架真实求值器
 *  evaluateRules 断言（不是只看数组包含）：只读会话里 acquire 桌面控制、启动
 *  开发服务做浏览器验收都要被 deny。另钉住模式往返不丢用户「总是允许」沉淀。 */

describe("只读模式拒绝写类权限（含 P0 新工具）", () => {
  const readonly = applyModeRules(undefined, "readonly");
  const denied = [
    ["edit", "src/a.ts"],
    ["bash", "npm test"],
    ["terminal", "npm run dev"],
    ["git_write", "commit"],
    ["mcp", "server:tool"],
    ["task", "spawn"],
    ["computer_use", "acquire Calculator"],
    ["computer_use", "click 1"],
    ["browser_verify", "run"],
  ] as const;

  it.each(denied)("readonly → deny %s %s", (permission, pattern) => {
    expect(evaluateRules([readonly], permission, pattern)).toBe("deny");
  });

  it("readonly 不拦读操作与新模式规则本身", () => {
    expect(evaluateRules([readonly], "read", "src/a.ts")).not.toBe("deny");
    expect(evaluateRules([readonly], "grep", "*")).not.toBe("deny");
  });
});

describe("模式规则往返", () => {
  it("full → readonly → full：用户沉淀的 always 规则保留，模式规则精确剥离", () => {
    const user = [{ permission: "read", pattern: "docs/**", action: "always" }];
    let rules = applyModeRules(user, "full");
    rules = applyModeRules(rules, "readonly");
    rules = applyModeRules(rules, "full");
    expect(detectPermissionMode(rules)).toBe("full");
    // 用户沉淀仍在（readonly 的 deny 之上，full 的 allow 之下——依序叠加）
    expect(JSON.stringify(rules)).toContain("docs/**");
    expect(stripModeRules(rules)).toEqual(user);
  });

  it("detectPermissionMode：readonly 可回读（新键加入后哨兵机制不受影响）", () => {
    expect(detectPermissionMode(applyModeRules(undefined, "readonly"))).toBe("readonly");
  });
});
