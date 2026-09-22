import { describe, expect, it } from "vitest";

import {
  deriveTaskPresentation,
  type PresentationContext,
} from "./task-presentation.js";

/** 构造一个「空/空闲」基线上下文，测试里按需覆盖字段。 */
function ctx(overrides: Partial<PresentationContext> = {}): PresentationContext {
  return {
    sessionId: "ses_1",
    sessionStatus: "idle",
    permissionRequest: null,
    editedPaths: [],
    previewablePaths: [],
    explicitWorkbenchTab: null,
    explicitDebugTab: null,
    hasGitChanges: false,
    ...overrides,
  };
}

describe("deriveTaskPresentation 状态机表", () => {
  it("行 1a：无会话 → idle", () => {
    const r = deriveTaskPresentation(ctx({ sessionId: null }));
    expect(r.state).toBe("idle");
  });

  it("行 1b：会话存在但无任务事件 → idle", () => {
    const r = deriveTaskPresentation(ctx({ sessionStatus: "idle" }));
    expect(r.state).toBe("idle");
  });

  it("行 2a：有权限请求 → needs_input", () => {
    const r = deriveTaskPresentation(
      ctx({ permissionRequest: { id: "p1", permission: "edit" } }),
    );
    expect(r.state).toBe("needs_input");
    expect(r.icon).toBe("question");
  });

  it("行 2b：会话等待态（无 PermissionRequest）→ needs_input", () => {
    // 框架 runner 在 unknownSideEffect 时发 waiting_input，此时并没有 pending
    // 卡片。若不消费 waiting，会掉到行 6/行 7 显示成「待审查」或「就绪」。
    const r = deriveTaskPresentation(ctx({ sessionStatus: "waiting" }));
    expect(r.state).toBe("needs_input");
  });

  it("行 2b：等待态优先于行 6 的编辑态（等用户 > 可审查）", () => {
    const r = deriveTaskPresentation(
      ctx({ sessionStatus: "waiting", editedPaths: ["src/a.ts"] }),
    );
    expect(r.state).toBe("needs_input");
  });

  it("行 3a：sessionStatus=running → running", () => {
    const r = deriveTaskPresentation(ctx({ sessionStatus: "running" }));
    expect(r.state).toBe("running");
    expect(r.icon).toBe("spinner");
  });

  it("行 4：失败且无产物无编辑 → failed", () => {
    const r = deriveTaskPresentation(
      ctx({ sessionStatus: "failed", editedPaths: [], previewablePaths: [] }),
    );
    expect(r.state).toBe("failed");
    expect(r.icon).toBe("error");
  });

  it("running 优先于 failed（行 3 vs 4）：agent 仍在跑时不翻成 failed", () => {
    const r = deriveTaskPresentation(
      ctx({ sessionStatus: "running" }),
    );
    expect(r.state).toBe("running");
  });

  it("行 5：有可预览产物 → delivered", () => {
    const r = deriveTaskPresentation(
      ctx({ previewablePaths: ["out/index.html"] }),
    );
    expect(r.state).toBe("delivered");
    expect(r.icon).toBe("artifact");
  });

  it("失败但产物在 → delivered（failed 与 delivered 非互斥），并带次级 failure badge", () => {
    const r = deriveTaskPresentation(
      ctx({ sessionStatus: "failed", previewablePaths: ["out/index.html"] }),
    );
    expect(r.state).toBe("delivered");
    expect(r.failureBadge).toEqual({ kind: "session_failed", label: "会话执行失败" });
  });

  it("delivered 优先于 review_ready（行 5 vs 6）：两者并存时产物胜出", () => {
    const r = deriveTaskPresentation(
      ctx({
        previewablePaths: ["out/index.html"],
        editedPaths: ["src/a.ts", "src/b.ts"],
        hasGitChanges: true,
      }),
    );
    expect(r.state).toBe("delivered");
  });

  it("行 6a：有编辑无产物 → review_ready", () => {
    const r = deriveTaskPresentation(ctx({ editedPaths: ["src/a.ts"] }));
    expect(r.state).toBe("review_ready");
    expect(r.icon).toBe("diff");
  });

  it("行 6b：有 git 变更无编辑 → review_ready", () => {
    const r = deriveTaskPresentation(ctx({ hasGitChanges: true }));
    expect(r.state).toBe("review_ready");
  });

  it("行 7：兜底 → idle（如 completed 但无产物无编辑无 git）", () => {
    const r = deriveTaskPresentation(ctx({ sessionStatus: "completed" }));
    expect(r.state).toBe("idle");
  });

  it("failed 主态不重复挂 failure badge", () => {
    const r = deriveTaskPresentation(
      ctx({ sessionStatus: "failed" }),
    );
    expect(r.state).toBe("failed");
    expect(r.failureBadge).toBeNull();
  });

  it("纯函数性：同一输入两次调用结果深度相等", () => {
    const input = ctx({
      sessionStatus: "failed",
      previewablePaths: ["out/a.html"],
    });
    expect(deriveTaskPresentation(input)).toEqual(deriveTaskPresentation(input));
  });
});
