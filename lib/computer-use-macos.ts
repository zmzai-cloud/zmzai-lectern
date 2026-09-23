/** C1-S2：macOS 平台 adapter——osascript（System Events AX）+ screencapture，
 *  零新依赖（C1 设计 §1.1）。
 *
 *  权限真实（C01）：Accessibility 与 Screen Recording 是两个独立 TCC 授权，
 *  探测分开做、缺失给具体设置路径；探测失败 = capability unavailable，
 *  不绕过不假报。Windows → 平台直接 unavailable（spec §12.1）。
 *
 *  定位语义：全部走 AX 结构化定位（by name/description/role），不做视觉坐标
 *  点击（截图仅观察证据，可关）；键入值不落库（broker 层脱敏）。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const p_execFile = promisify(execFile);

export type CuaPermissionState = {
  platform: string;
  available: boolean;
  permissions: { accessibility: boolean; screenRecording: boolean };
  guidance?: string;
};

async function osa(script: string, timeoutMs = 10_000): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout, stderr } = await p_execFile("osascript", ["-e", script], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, out: stdout.toString(), err: stderr.toString() };
  } catch (error) {
    const e = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return { ok: false, out: e.stdout?.toString() ?? "", err: (e.stderr?.toString() || e.message || "osascript 失败") };
  }
}

const apple = (parts: string[]) => parts.join("\n");

/** AX 是否可用：System Events 能枚举进程 = Accessibility 已授权（C01 探测）。 */
async function probeAccessibility(): Promise<boolean> {
  const r = await osa('tell application "System Events" to count processes', 8000);
  if (r.ok && /^\d+$/.test(r.out.trim())) return true;
  // 未授权时 osascript 报 -1719/-25211/Not authorized 等；按文本识别不猜精确码
  return false;
}

/** 截图权限：screencapture 能落盘 = Screen Recording 已授权。 */
async function probeScreenRecording(): Promise<boolean> {
  try {
    const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "cua-probe-"));
    const file = path.join(dir, "probe.png");
    await p_execFile("screencapture", ["-x", file], { timeout: 8000 });
    const ok = existsSync(file);
    rmSync(dir, { recursive: true, force: true });
    return ok;
  } catch {
    return false;
  }
}

/** 目标 app 的 System Events 进程名（.app 后缀与 bundle 名归一，尽力匹配）。 */
async function resolveProcessName(targetApp: string): Promise<string | null> {
  const r = await osa(apple([
    'tell application "System Events"',
    "set names to name of every process",
    "end tell",
  ]));
  if (!r.ok) return null;
  const names = r.out.split(",").map((s) => s.trim());
  const lower = targetApp.toLowerCase().replace(/\.app$/, "");
  return names.find((n) => n.toLowerCase().replace(/\.app$/, "") === lower) ?? null;
}

/** 当前 lease 目标 app（broker 单 lease 语义；acquire 后由调用方 set）。 */
let currentTargetApp = "";

export function setAdapterTarget(app: string): void {
  currentTargetApp = app;
}

export function createMacOsCuaAdapter(opts: { screenshotEvidence?: boolean } = {}) {
  const capability = (): CuaPermissionState => {
    if (process.platform !== "darwin") {
      return {
        platform: process.platform,
        available: false,
        permissions: { accessibility: false, screenRecording: false },
        guidance: "computer use 当前仅支持 macOS（Windows capability unavailable，后续单独验收后开放）",
      };
    }
    return {
      platform: "darwin",
      available: true, // 平台可达；细粒度授权由 probeCapability 异步给出（探测有副作用开销）
      permissions: { accessibility: true, screenRecording: true },
    };
  };

  /** 实际权限探测（C01：缺失给具体设置引导，不假报）。 */
  const probeCapability = async (): Promise<CuaPermissionState> => {
    if (process.platform !== "darwin") return capability();
    const [ax, sr] = await Promise.all([probeAccessibility(), probeScreenRecording()]);
    const missing: string[] = [];
    if (!ax) missing.push("辅助功能（系统设置 → 隐私与安全性 → 辅助功能，勾选运行 Lectern 的应用/终端）");
    if (!sr) missing.push("屏幕录制（系统设置 → 隐私与安全性 → 屏幕录制）");
    return {
      platform: "darwin",
      available: ax, // AX 是动作的硬前提；截图缺失只影响截图证据
      permissions: { accessibility: ax, screenRecording: sr },
      guidance: missing.length > 0 ? `缺少授权：${missing.join("；")}` : undefined,
    };
  };

  return {
    capability,
    probeCapability,

    /** 观察：目标 app 前台窗口身份 + 少量 AX 摘要（不整树，R-1）。 */
    observe: async (input: { targetApp: string }): Promise<{ ok: boolean; observation?: unknown; reason?: string; fatal?: "app-exit" | "permission-revoked" | "screen-locked" }> => {
      if (process.platform !== "darwin") return { ok: false, reason: capability().guidance ?? "unsupported-platform" };
      const axOk = await probeAccessibility();
      if (!axOk) return { ok: false, reason: "accessibility 未授权（系统设置 → 隐私与安全性 → 辅助功能）", fatal: "permission-revoked" };

      const procName = await resolveProcessName(input.targetApp);
      if (!procName) return { ok: false, reason: `目标应用未运行：${input.targetApp}`, fatal: "app-exit" };

      const r = await osa(apple([
        'tell application "System Events"',
        `tell process "${procName}"`,
        "set frontmost to true",
        "delay 0.2",
        "set winName to name of front window",
        "set winCount to count of windows",
        "end tell",
        "return winName & \",\" & winCount",
        "end tell",
      ]));
      if (!r.ok) {
        const err = r.err.toLowerCase();
        if (err.includes("can't get") || err.includes("window")) {
          return { ok: false, reason: `目标应用无前台窗口（可能已退出/最小化）：${input.targetApp}`, fatal: "app-exit" };
        }
        if (err.includes("not authorized") || err.includes("-25211")) {
          return { ok: false, reason: "accessibility 授权被撤销", fatal: "permission-revoked" };
        }
        return { ok: false, reason: `观察失败：${r.err.split("\n")[0] ?? ""}`.slice(0, 200) };
      }
      const [winTitle, winCount] = r.out.trim().split(",");
      return {
        ok: true,
        observation: {
          observationId: "",
          at: new Date().toISOString(),
          windowIdentity: { app: input.targetApp, windowTitle: (winTitle ?? "").trim() },
          axSummary: `windows=${(winCount ?? "0").trim()}`, // 动作效果观察锚点（如菜单点击后窗口数变化）
        },
      };
    },

    /** 动作：AX 结构化定位点击/键入/按键/滚动/读文本。
     *  value（真实键入）只经内存参数；动作日志由 broker 层脱敏（valueMasked）。 */
    act: async (input: { action: { kind: string; target?: string; observationId: string }; value?: string }): Promise<{ ok: boolean; detail?: string; text?: string; reason?: string; fatal?: "app-exit" | "permission-revoked" | "screen-locked" }> => {
      const { kind, target } = input.action;
      const value = input.value; // 内存穿透，绝不落库
      const leaseTargetApp = currentTargetApp;
      const procName = await resolveProcessName(leaseTargetApp);
      if (!procName) return { ok: false, reason: "目标应用未运行", fatal: "app-exit" };
      const base = (inner: string[]) => osa(apple([
        'tell application "System Events"',
        `tell process "${procName}"`,
        "set frontmost to true",
        ...inner,
        "end tell",
        "end tell",
      ]));

      switch (kind) {
        case "click": {
          // target 两种形态：menu:<菜单栏项>:<菜单项>（菜单点击——新版 macOS 计算
          // 器等 App 的按钮 AX 无名，菜单是稳定结构化入口）；或窗口内按钮 by name
          if (target?.startsWith("menu:")) {
            const [, barItem, menuItem] = target.split(":");
            const r = await osa(apple([
              'tell application "System Events"',
              `tell process "${procName}"`,
              "set frontmost to true",
              `click (first menu item of menu of menu bar item "${escapeApple(barItem ?? "")}" of menu bar 1 whose name is "${escapeApple(menuItem ?? "")}")`,
              "end tell",
              "end tell",
            ]));
            return r.ok ? { ok: true, detail: `clicked menu ${barItem}→${menuItem}` } : classifyAppleError(r.err);
          }
          const r = await base([
            `click (first button of front window whose name is "${escapeApple(target ?? "")}")`,
          ]);
          return r.ok ? { ok: true, detail: `clicked ${target}` } : classifyAppleError(r.err);
        }
        case "type": {
          if (value === undefined) return { ok: false, reason: "type 动作缺 value（内存参数）" };
          const r = await base([
            `set focused to true`,
            `keystroke ${JSON.stringify(value)}`,
          ]);
          return r.ok ? { ok: true, detail: `typed ${value!.length} chars` } : classifyAppleError(r.err);
        }
        case "key": {
          if (value === undefined) return { ok: false, reason: "key 动作缺 key 名（内存参数）" };
          const r = await base([`key code ${Number(value) || 0}`]);
          return r.ok ? { ok: true, detail: `keycode ${value}` } : classifyAppleError(r.err);
        }
        case "scroll": {
          const r = await base([`scroll area 1 of front window by 3`]);
          return r.ok ? { ok: true, detail: "scrolled" } : classifyAppleError(r.err);
        }
        case "read_text": {
          // target 缺省 = 前台窗口第一个 static text（如 Calculator 显示区无名）
          const r = await base(target
            ? [`set txt to value of (first static text of front window whose name is "${escapeApple(target)}")`, "return txt"]
            : ["set txt to value of static text 1 of front window", "return txt"]);
          return r.ok ? { ok: true, text: r.out.trim(), detail: `read ${target ?? "(first static text)"}` } : classifyAppleError(r.err);
        }
        default:
          return { ok: false, reason: `未知动作类型：${kind}` };
      }
    },

    /** 截图证据（可选能力；Screen Recording 未授权 → 如实失败不阻断动作）。 */
    screenshot: async (): Promise<{ ok: boolean; artifactRef?: string; reason?: string }> => {
      if (process.platform !== "darwin" || opts.screenshotEvidence === false) {
        return { ok: false, reason: "截图证据未启用" };
      }
      try {
        const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const path = await import("node:path");
        void mkdtempSync; void writeFileSync;
        const dir = "/tmp/lectern-cua"; // 临时产物：由调用方（route）搬到 dataDir 证据目录
        mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `cua-${Date.now().toString(36)}.png`);
        await p_execFile("screencapture", ["-x", file], { timeout: 8000 });
        return { ok: true, artifactRef: file };
      } catch (error) {
        return { ok: false, reason: `screencapture 失败（检查屏幕录制授权）：${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}

/** AppleScript 字符串转义（引号/反斜杠）。 */
function escapeApple(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

/** osascript 错误分类（fatal 语义决定 broker 是否撤租约，C04）。 */
function classifyAppleError(err: string): { ok: false; reason: string; fatal?: "app-exit" | "permission-revoked" | "screen-locked" } {
  const e = err.toLowerCase();
  if (e.includes("not authorized") || e.includes("-25211")) {
    return { ok: false, reason: "accessibility 授权被撤销", fatal: "permission-revoked" };
  }
  if (e.includes("can't get") || e.includes("missing value")) {
    return { ok: false, reason: `元素不存在或应用已退出：${err.split("\n")[0] ?? ""}`.slice(0, 200), fatal: "app-exit" };
  }
  return { ok: false, reason: `动作失败：${err.split("\n")[0] ?? ""}`.slice(0, 200) };
}
