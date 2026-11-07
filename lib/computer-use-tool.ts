import { z } from "zod";
import type { ToolDef } from "@zmzai/agent-framework";

/** computer_use 模型工具（PC17，spec §5.2）：经 ToolExecutor（权限/预算/trace）
 *  调用 Host 持有的桌面控制 broker——与 HTTP 控制面共用 computerUseCommand。
 *
 *  身份：会话取 ToolContext.sessionId（服务端身份），根 Task 服务端推导；模型
 *  参数里没有会话/租约归属字段，不能借用其他会话的租约。takeover/resume 是用户
 *  操作，不暴露给模型；无法识别真实用户输入时 acquire 被拒（禁止无人值守）。 */

const ACTIONS = ["capability", "acquire", "observe", "act", "status", "release", "stop"] as const;
const KINDS = ["click", "type", "key", "scroll", "read_text"] as const;

const parameters = z.object({
  action: z.enum(ACTIONS).describe("capability=权限探测；acquire=取得桌面控制租约；observe=观察目标窗口；act=执行单个动作；status=租约状态；release=释放；stop=紧急停止"),
  targetApp: z.string().min(1).max(120).optional().describe("acquire 时必填：目标应用名（如 Calculator）"),
  observationId: z.string().max(80).optional().describe("act 时必填：最近一次 observe 返回的 observationId（5 秒内有效）"),
  kind: z.enum(KINDS).optional().describe("act 时必填：动作类型"),
  target: z.string().max(200).optional().describe("动作目标：按钮名，或 menu:<菜单栏项>:<菜单项>"),
  value: z.string().max(2000).optional().describe("type 的文本或 key 的键码；不要输入密码等凭据（凭据由用户亲自输入）"),
});

type Args = z.output<typeof parameters>;

function summarize(args: Args, status: number, body: Record<string, unknown>): string {
  if (status >= 400 || body.ok === false) {
    const reason = String(body.reason ?? body.error ?? "失败");
    const hint = reason === "stale-observation" ? "观察已过期或窗口已变化，请重新 observe 后再动作。"
      : reason === "user-takeover" ? "检测到用户正在使用键鼠，租约已暂停；等待用户在界面中恢复，不要重试。"
      : reason === "blind-retry-rejected" ? "上一次同样的动作结果未知，禁止盲目重发；请重新 observe 核对实际状态。"
      : reason.startsWith("stale-window") ? "前台窗口已与观察时不同，动作未执行；请重新 observe。"
      : reason === "takeover-unavailable" ? "无法识别真实用户输入，系统禁止无人值守桌面控制；请改为让用户手动操作。"
      : "";
    return `${args.action} 未完成：${reason}${body.detail ? `（${String(body.detail)}）` : ""}${hint ? `\n${hint}` : ""}`;
  }
  return JSON.stringify(body).slice(0, 2_000);
}

export function createComputerUseTool(): ToolDef {
  return {
    id: "computer_use",
    label: "桌面控制",
    description:
      "控制本机 macOS 桌面应用（仅在用户明确要求操作某个桌面应用时使用；网页请用浏览器验证工具）。" +
      "流程：acquire(targetApp) → observe → act(observationId, kind, target) → 再 observe 核对效果 → release。" +
      "每个 act 只做一个动作，必须用 5 秒内的新观察；动作结果未知时不要重发，先重新 observe。" +
      "用户动键鼠会自动暂停控制，只能等用户恢复。不要输入密码等凭据。",
    parameters,
    // 取得控制与每个会改变界面的动作都需用户授权；观察/状态/释放/紧急停止不扩大权限
    permission: (args) => {
      if (args.action === "acquire") {
        const app = args.targetApp ?? "";
        return { permission: "computer_use", patterns: [`acquire ${app}`], always: [`acquire ${app}`], metadata: { action: "acquire", targetApp: app } };
      }
      if (args.action === "act" && args.kind !== "read_text") {
        const target = args.target ?? "";
        return { permission: "computer_use", patterns: [`${args.kind} ${target}`.trim()], always: [`${args.kind} *`], metadata: { action: "act", kind: args.kind, target } };
      }
      return null;
    },
    executionMode: "sequential",
    contract: { effect: ["system"], retrySafety: "never", concurrency: { mode: "serialized", key: "computer-use" } },
    async execute(args, ctx) {
      const { computerUseCommand } = await import("./computer-use-service.js");
      const body: Record<string, unknown> = { action: args.action };
      for (const key of ["targetApp", "observationId", "kind", "target", "value"] as const) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      const result = await computerUseCommand(ctx.sessionId, body, { unattended: true });
      const ok = result.status < 400 && result.body.ok !== false;
      // 键入值不回显到输出/元数据（日志侧只有 valueMasked）
      return {
        title: `桌面控制 · ${args.action}${ok ? "" : "（未完成）"}`,
        output: summarize(args, result.status, result.body),
        metadata: { action: args.action, status: result.status, ok, ...(args.kind ? { kind: args.kind } : {}) },
      };
    },
  };
}
