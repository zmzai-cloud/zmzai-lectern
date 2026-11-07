import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const fx = vi.hoisted(() => ({ dir: "", takeover: true as boolean, acts: [] as unknown[] }));
vi.mock("./runtime-constants", () => ({ get dataDir() { return fx.dir; } }));
vi.mock("./session-owner", () => ({ resolveSessionOwner: (sessionId: string) => ({ sessionId, project: { id: "p", path: "/w/p" }, effectiveWorkspaceRoot: "/w/p" }) }));
vi.mock("./runtime", () => ({ sessionRuntime: (sessionId: string) => ({ store: { task: { getActiveTask: async () => ({ id: `task_of_${sessionId}` }) } } }) }));
// 平台 adapter 假件（原生实测见 computer-use-native.test.ts）；broker/服务/工具为真实实现
vi.mock("./computer-use-macos", () => ({
  setAdapterTarget: () => undefined,
  createMacOsCuaAdapter: () => ({
    capability: () => ({ platform: "darwin", available: true, permissions: { accessibility: true, screenRecording: true } }),
    probeCapability: async () => ({ platform: "darwin", available: true, permissions: { accessibility: true, screenRecording: true }, userTakeover: fx.takeover }),
    userInputIdleMs: async () => 60_000,
    observe: async () => ({ ok: true, observation: { observationId: "", at: new Date().toISOString(), windowIdentity: { app: "Calculator", windowTitle: "Calculator" } } }),
    act: async (input: unknown) => { fx.acts.push(input); return { ok: true, detail: "clicked" }; },
  }),
}));
import { createComputerUseTool } from "./computer-use-tool.js";

/** PC17（spec §5.2）：真实 runtime 工具经 ToolDef 调用 broker；身份取自
 *  ToolContext.sessionId（模型参数无会话/租约归属字段）；跨会话借租约被拒；
 *  takeover/resume 不对模型开放；无法识别用户输入时禁止无人值守 acquire。 */

fx.dir = path.join(mkdtempSync(path.join(tmpdir(), "cua-tool-")), "data");
afterAll(async () => { await rm(path.dirname(fx.dir), { recursive: true, force: true }); });

const tool = createComputerUseTool();
const ctx = (sessionId: string) => ({ sessionId, abort: new AbortController().signal }) as never;
const run = async (sessionId: string, args: Record<string, unknown>) => tool.execute(tool.parameters.parse(args), ctx(sessionId));

describe("computer_use 模型工具", () => {
  it("权限映射：acquire 与改变界面的动作需授权；观察/读值/状态/紧急停止不需要", () => {
    expect(tool.permission({ action: "acquire", targetApp: "Calculator" } as never)).toMatchObject({ permission: "computer_use", patterns: ["acquire Calculator"] });
    expect(tool.permission({ action: "act", kind: "click", target: "1" } as never)).toMatchObject({ permission: "computer_use", patterns: ["click 1"] });
    expect(tool.permission({ action: "act", kind: "read_text" } as never)).toBeNull();
    expect(tool.permission({ action: "observe" } as never)).toBeNull();
    expect(tool.permission({ action: "stop" } as never)).toBeNull();
    // 用户操作不在模型可选动作内
    expect(() => tool.parameters.parse({ action: "resume" })).toThrow();
    expect(() => tool.parameters.parse({ action: "takeover" })).toThrow();
  });

  it("身份来自 ToolContext：A 取得租约并完成观察→动作；B 无法借用 A 的租约", async () => {
    const acquired = await run("ses_a", { action: "acquire", targetApp: "Calculator" });
    expect(acquired.metadata).toMatchObject({ ok: true });
    expect(acquired.output).toContain("task_of_ses_a"); // 根 Task 服务端推导

    const observed = await run("ses_a", { action: "observe" });
    const observationId = /"observationId":"(obs_[^"]+)"/.exec(observed.output)?.[1];
    expect(observationId).toBeTruthy();

    const foreign = await run("ses_b", { action: "act", observationId, kind: "click", target: "1" });
    expect(foreign.metadata).toMatchObject({ ok: false, status: 403 });
    expect(fx.acts).toHaveLength(0);

    const own = await run("ses_a", { action: "act", observationId, kind: "click", target: "1" });
    expect(own.metadata).toMatchObject({ ok: true });
    expect(fx.acts).toHaveLength(1);

    const stopped = await run("ses_a", { action: "stop" });
    expect(stopped.metadata).toMatchObject({ ok: true });
    expect((await run("ses_a", { action: "observe" })).metadata).toMatchObject({ ok: false });
  });

  it("无法识别真实用户输入 → 拒绝无人值守 acquire（如实说明，不降级放行）", async () => {
    fx.takeover = false;
    try {
      const r = await run("ses_c", { action: "acquire", targetApp: "Calculator" });
      expect(r.metadata).toMatchObject({ ok: false, status: 409 });
      expect(r.output).toContain("takeover-unavailable");
    } finally {
      fx.takeover = true;
    }
  });
});
