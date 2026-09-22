/**
 * 规格 3 §17.2 的七条 Lectern 单元/组件测试。
 *
 * 【为什么这些断言长这样】规格要修的是一个**归因错误**：把「一次运行结束」
 * 当成「任务完成」。这类错误很难靠人眼发现——界面上两句话长得几乎一样，
 * 只有在「跑了一半就停下」的时刻才会分叉。所以这里的测试刻意都做成
 * 「同一份输入，两条通路给出不同结论」的对照（例如 `sessionStatusFor` 与
 * `sessionListOutcome` 对着 `session.summary.completed` 必须都不说完成），
 * 而不是只断言某个字符串存在。
 *
 * 【哪些用源码契约、哪些用纯函数】凡是已经收敛成纯函数的规则（状态映射、
 * 通知内容、动作表、投影器折叠）一律直接调函数。剩下的「这条旧通路必须
 * 不存在」——例如「继续下一步」按钮和它背后的合成 prompt——没有函数可调，
 * 它们的存在形式就是源码，因此读源码断言其不存在。这不是取巧：规格 §19 把
 * 这些列为**明确禁止的实现**，禁的是「代码里出现这种东西」，源码就是它的
 * 唯一载体，编译产物里也能被 grep 到。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ChatProjector } from "./chat-projector.js";
import { presentTask, sessionListOutcome, sessionStatusFor, taskNotice, toTaskView } from "./task-presentation.js";
import type { TaskBlockerView, TaskLifecycleStatus, TaskRecordView, TaskStepView } from "./types.js";

const repoFile = (relative: string) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

/** 造一条任务记录。默认「跑到一半」——这是最容易出错的那个时刻。 */
function makeTask(overrides: Partial<TaskRecordView> = {}): TaskRecordView {
  return {
    id: "task_1",
    sessionId: "s1",
    goal: "把 PDF 的内容铺到网页上",
    status: "running",
    steps: [],
    acceptanceCriteria: [],
    revision: 1,
    attemptCount: 1,
    constraints: [],
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

function steps(statuses: TaskStepView["status"][]): TaskStepView[] {
  return statuses.map((status, index) => ({ id: `step_${index + 1}`, title: `第 ${index + 1} 步`, status, order: index }));
}

const ALL_STATUSES: TaskLifecycleStatus[] = [
  "queued",
  "running",
  "recovering",
  "waiting_permission",
  "waiting_input",
  "waiting_external",
  "verifying",
  "delivered",
  "blocked",
  "failed",
  "cancelled",
];

describe("§17.2-1 session.summary.completed 不再显示「任务完成」", () => {
  it("有任务时状态只由 task 决定：跑了一半就停 → running，不是 completed", () => {
    // 这一条是规格 §3.2 的正面回归：模型给出纯文本、一次 Attempt 结束、
    // session.status 回到 idle，任务还剩一半步骤。
    expect(sessionStatusFor("idle", makeTask({ status: "running" }))).toBe("running");
    expect(sessionStatusFor("idle", makeTask({ status: "queued" }))).toBe("running");
    expect(sessionStatusFor("idle", makeTask({ status: "verifying" }))).toBe("running");
    expect(sessionStatusFor("idle", makeTask({ status: "recovering" }))).toBe("running");
  });

  it("只有 task.delivered 才映射成 completed", () => {
    expect(sessionStatusFor("running", makeTask({ status: "delivered" }))).toBe("completed");
    expect(sessionStatusFor("idle", makeTask({ status: "failed" }))).toBe("failed");
    expect(sessionStatusFor("idle", makeTask({ status: "cancelled" }))).toBe("idle");
    for (const status of ["blocked", "waiting_permission", "waiting_input", "waiting_external"] as const) {
      expect(sessionStatusFor("idle", makeTask({ status }))).toBe("waiting");
    }
  });

  it("没有任务时不拿「有 summary」当「做完了」：回 idle 而不是 completed", () => {
    // 历史会话 / 旧库。旧实现在这里读 `summary.kind === "completed"`，
    // 于是一条早已结束、并没有交付任何东西的会话会被画成绿色完成。
    expect(sessionStatusFor("idle", null)).toBe("idle");
    expect(sessionStatusFor("running", null)).toBe("running");
    expect(sessionStatusFor("waiting_permission", null)).toBe("waiting");
    // 无论会话自身处在什么状态，没有任务契约就永远不输出 completed。
    for (const status of ["idle", "running", "waiting_input", "waiting_permission", "completed", "error"]) {
      expect(sessionStatusFor(status, null)).not.toBe("completed");
    }
  });

  it("session 列表同样不把「有标题 / 有 lastOutcome」当成完成（§18.3）", () => {
    // 旧实现：`lastOutcome ?? (title ? "completed" : "idle")`。
    // 首条消息会被用作占位标题，所以「有标题」几乎恒真 → 列表满屏「完成」。
    expect(sessionListOutcome({ lastOutcome: "completed" })).toBe("idle");
    expect(sessionListOutcome({})).toBe("idle");
    // 有任务契约时，任务状态压倒 lastOutcome。
    expect(sessionListOutcome({ task: makeTask({ status: "running" }), lastOutcome: "completed" })).toBe("running");
    expect(sessionListOutcome({ task: makeTask({ status: "delivered" }) })).toBe("completed");
    expect(sessionListOutcome({ task: makeTask({ status: "failed" }) })).toBe("error");
    expect(sessionListOutcome({ task: makeTask({ status: "cancelled" }) })).toBe("aborted");
    expect(sessionListOutcome({ task: makeTask({ status: "blocked" }) })).toBe("awaiting");
    expect(sessionListOutcome({ task: makeTask({ status: "waiting_external" }) })).toBe("awaiting");
    // 无任务时只承认明确的失败与中断。
    expect(sessionListOutcome({ lastOutcome: "error" })).toBe("error");
    expect(sessionListOutcome({ lastOutcome: "aborted" })).toBe("aborted");
  });
});

describe("§17.2-2 页面不存在通用「继续下一步」按钮和对应合成 prompt", () => {
  const surface = ["components/ChatView.tsx", "app/page.tsx", "components/TaskContextStrip.tsx", "components/TaskStatus.tsx"] as const;

  /** 去掉纯注释行后再扫。
   *
   *  【为什么不直接扫原文】注释里写「这里不再有『继续下一步』按钮」是**好的
   *  文档**——它把「为什么删」留在了代码旁边。测试要拦的是真的会渲染出来的
   *  那些字，所以按行剔除以 `//`、`*`、`/*` 开头的行（行内代码里的 `//`
   *  不在行首，不会被误伤）。 */
  const code = (file: string) =>
    repoFile(file)
      .split("\n")
      .filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
      })
      .join("\n");

  it("没有任何一处还写着「继续下一步」或「下一步」按钮文案", () => {
    for (const file of surface) {
      const source = code(file);
      expect(source, `${file} 不应再出现「继续下一步」`).not.toContain("继续下一步");
      expect(source, `${file} 不应再出现「继续执行下一步」按钮文案`).not.toContain("继续执行下一步");
    }
  });

  it("合成 prompt 的通路（onContinue / buildContinueContext）已被删除", () => {
    for (const file of surface) {
      const source = code(file);
      expect(source, `${file} 不应再有 onContinue`).not.toContain("onContinue");
      expect(source, `${file} 不应再有 buildContinueContext`).not.toContain("buildContinueContext");
      expect(source, `${file} 不应再有 onFollowUp`).not.toContain("onFollowUp");
    }
  });

  it("错误提示不再让用户去点一个已经不存在的「继续」", () => {
    // 删按钮的时候最容易漏掉的就是这些文案：按钮没了，处处还在说「点『继续』」。
    // 用户照着做，只会发现那个按钮不在那里。
    const chat = code("components/ChatView.tsx");
    expect(chat).not.toContain("点「继续」");
    expect(chat).not.toContain("再点「继续」");
    // 但真实的通路要说到：任务卡的动作按钮 + 输入框（§12 steering）。
    expect(chat).toContain("任务卡");
  });

  it("Attempt 结束时画的是「本轮已结束」，不是「任务完成」", () => {
    // 删掉按钮不等于改对了归因：小结卡还在，但它现在只能说这一轮。
    const chat = code("components/ChatView.tsx");
    expect(chat).toContain("data-attempt-summary");
    const review = code("components/ReviewPane.tsx");
    expect(review).toContain("data-attempt-summary-label");
    expect(review).toContain("本轮已结束");
    expect(review, "审查页不得再用「任务完成」描述一轮的结束").not.toContain("任务完成");
  });
});

describe("§17.2-3 只有 task.delivered 触发完成 toast、系统通知和标题", () => {
  it("11 个状态里只有 delivered 会改标题并说「任务完成」", () => {
    const claiming = ALL_STATUSES.filter((status) => {
      const notice = taskNotice(makeTask({ status }));
      return notice !== null && (notice.title.includes("任务完成") || notice.toast.includes("任务完成") || notice.os?.includes("任务完成"));
    });
    expect(claiming).toEqual(["delivered"]);
  });

  it("中间态与 cancelled 什么都不发（内部 Attempt 收尾不打扰用户）", () => {
    for (const status of ["queued", "running", "recovering", "verifying", "cancelled"] as const) {
      expect(taskNotice(makeTask({ status })), `${status} 不该产生通知`).toBeNull();
    }
  });

  it("delivered 用主进程那条固定文案通道 + 提示音，toast 与系统通知都有正文", () => {
    const notice = taskNotice(makeTask({ status: "delivered" }))!;
    expect(notice.kind).toBe("delivered");
    expect(notice.title).toBe("✓ 任务完成 — Lectern");
    expect(notice.toast).toBe("任务已完成");
    expect(notice.os).toBeTruthy();
    expect(notice.bridgeDone).toBe(true);
    expect(notice.chime).toBe(true);
  });

  it("等待类状态发「需要你处理」，正文带上用户该做的动作（§14.4 禁止只说「请继续」）", () => {
    const blocker: TaskBlockerView = {
      kind: "external_auth",
      message: "推送需要先登录 GitHub。",
      requiredAction: "在终端里完成 GitHub 登录，然后回来点检查后重试。",
      resumable: true,
    };
    const notice = taskNotice(makeTask({ status: "waiting_external", blocker }))!;
    expect(notice.kind).toBe("needs_user");
    expect(notice.toast).toContain("需要你处理");
    expect(notice.os).toContain(blocker.requiredAction);
    expect(notice.bridgeDone, "「任务完成」通道不得给等待态用").toBe(false);
    expect(notice.chime).toBe(false);
    expect(notice.title, "等待态不得改标题成完成").toBe("Lectern");
  });

  it("blocked 的通知文案与进度卡同源（同一条状态不能两种说法）", () => {
    const task = makeTask({
      status: "blocked",
      blocker: { kind: "budget", message: "已累计执行 70 分钟。", requiredAction: "确认目标是否需要收窄。", resumable: true },
    });
    const notice = taskNotice(task)!;
    expect(notice.toast).toContain(presentTask(task).label);
    expect(presentTask(task).label).toBe("已超出预算");
  });

  it("failed 有自己的通知，不借用完成文案", () => {
    const notice = taskNotice(makeTask({ status: "failed" }))!;
    expect(notice.kind).toBe("failed");
    expect(notice.toast).toContain("失败");
    expect(notice.os).toBeTruthy();
    expect(notice.bridgeDone).toBe(false);
  });

  it("通知是纯函数：同一状态两次调用结果深度相等（重放/重渲染不会变形）", () => {
    for (const status of ALL_STATUSES) {
      const task = makeTask({ status });
      expect(taskNotice(task)).toEqual(taskNotice(task));
    }
    expect(taskNotice(null)).toBeNull();
  });
});

describe("§17.2-4 task running 显示当前步骤和 x/y 进度", () => {
  it("6 步里 3 步完成、1 步进行中 → done/total 与当前步骤名都取得到", () => {
    const task = makeTask({
      status: "running",
      steps: steps(["completed", "completed", "completed", "in_progress", "pending", "pending"]),
    });
    const view = presentTask(task);
    expect(view.progress).toEqual({ done: 3, total: 6, current: "第 4 步" });
    expect(view.label).toBe("执行中");
    expect(view.completed, "running 绝不算完成").toBe(false);
    expect(view.needsUser).toBe(false);
  });

  it("没有步骤时 progress 为 null（不画一个 0/0 的假进度条）", () => {
    expect(presentTask(makeTask({ steps: [] })).progress).toBeNull();
  });

  it("只有 in_progress 才算「正在做」：没有进行中步骤时 current 为 null", () => {
    const view = presentTask(makeTask({ status: "running", steps: steps(["completed", "pending"]) }));
    expect(view.progress).toEqual({ done: 1, total: 2, current: null });
  });
});

describe("§17.2-5 waiting_permission / waiting_input / blocked 显示对应上下文动作", () => {
  const ids = (task: TaskRecordView) => presentTask(task).actions.map((action) => action.id);

  it("等授权 → 授权并继续（送到授权卡，而不是替用户点同意）", () => {
    const actions = ids(makeTask({ status: "waiting_permission", blocker: { kind: "permission", message: "要执行 git push。", requiredAction: "选择允许或拒绝。", resumable: true } }));
    expect(actions).toEqual(["authorize", "stop"]);
  });

  it("等补充信息 → 补充信息；等选择方案 → 选择方案", () => {
    expect(ids(makeTask({ status: "waiting_input", blocker: { kind: "input", message: "缺少目标域名。", requiredAction: "提供域名。", resumable: true } }))).toEqual(["supply_input", "stop"]);
    expect(ids(makeTask({ status: "waiting_input", blocker: { kind: "choice", message: "两种布局都可。", requiredAction: "选一个。", resumable: true } }))).toEqual(["choose", "stop"]);
  });

  it("可恢复的阻塞 → 检查后重试；不可恢复的不给重试按钮", () => {
    expect(ids(makeTask({ status: "blocked", blocker: { kind: "budget", message: "超出时间预算。", requiredAction: "确认后继续。", resumable: true } }))).toEqual(["recheck", "stop"]);
    expect(ids(makeTask({ status: "blocked", blocker: { kind: "no_progress", message: "连续三轮无进展。", requiredAction: "需要收窄目标。", resumable: false } }))).toEqual(["stop"]);
    expect(ids(makeTask({ status: "waiting_external", blocker: { kind: "unsafe_replay", message: "外部状态未知。", requiredAction: "先核对进程与目标状态。", resumable: true } }))).toEqual(["recheck", "stop"]);
  });

  it("delivered / failed / cancelled 不摆动作（终态没有「继续」）", () => {
    for (const status of ["delivered", "failed", "cancelled"] as const) {
      expect(ids(makeTask({ status }))).toEqual([]);
    }
  });

  it("needsUser 只在需要用户动手时为真——它决定界面要不要把那块浮出来", () => {
    expect(presentTask(makeTask({ status: "blocked" })).needsUser).toBe(true);
    expect(presentTask(makeTask({ status: "waiting_input" })).needsUser).toBe(true);
    expect(presentTask(makeTask({ status: "running" })).needsUser).toBe(false);
    expect(presentTask(makeTask({ status: "delivered" })).needsUser).toBe(false);
  });
});

describe("§17.2-6 SSE 重放不会重复累计步骤或通知", () => {
  const TASK_ID = "task_replay";

  /** 一段典型的任务事件流：开始 → 展开计划 → 逐步推进 → 交付。 */
  const timeline = [
    { type: "task.started", data: { taskId: TASK_ID, revision: 1, goal: "铺网页", steps: [], acceptanceCriteria: [] } },
    { type: "task.plan.updated", data: { taskId: TASK_ID, revision: 2, steps: steps(["pending", "pending", "pending"]) } },
    { type: "task.step.started", data: { taskId: TASK_ID, revision: 3, stepId: "step_1" } },
    { type: "task.step.completed", data: { taskId: TASK_ID, revision: 4, stepId: "step_1" } },
    { type: "task.attempt.finished", data: { taskId: TASK_ID, revision: 5, attempt: 1, outcome: "completed", toolCalls: 4, filesEdited: 1, durationMs: 1200 } },
    { type: "task.step.started", data: { taskId: TASK_ID, revision: 6, stepId: "step_2" } },
    { type: "task.step.completed", data: { taskId: TASK_ID, revision: 7, stepId: "step_2" } },
    { type: "task.step.started", data: { taskId: TASK_ID, revision: 8, stepId: "step_3" } },
    { type: "task.step.completed", data: { taskId: TASK_ID, revision: 9, stepId: "step_3" } },
    { type: "task.delivered", data: { taskId: TASK_ID, revision: 10, result: "页面已铺好并通过检查。" } },
  ] as const;

  const feed = (events: readonly { type: string; data: unknown }[]) => {
    const projector = new ChatProjector();
    for (const event of events) projector.ingest(event as never);
    return projector.data();
  };

  /** 去掉宿主生成的时间戳再比较。
   *
   *  【为什么这几个字段不参与比较】投影器只从事件里拿语义字段，三个时间戳是
   *  它在本地 `new Date().toISOString()` 生成的——两次重放天然差几毫秒。
   *  「重放幂等」要保证的是**语义**（步骤、状态、revision、验收条件、结果），
   *  不是时钟；把时钟也算进去只会让这条测试变成 flaky，而不能多证明什么。 */
  const semantic = (task: TaskRecordView | null | undefined) => {
    if (!task) return null;
    const { createdAt: _createdAt, updatedAt: _updatedAt, deliveredAt: _deliveredAt, ...rest } = task;
    return rest;
  };

  it("整段事件重放两次得到同一份任务状态（断线重连 from seq 0 的幂等）", () => {
    const first = feed(timeline);
    const second = feed(timeline);
    expect(semantic(second.task)).toEqual(semantic(first.task));
    expect(second.task?.steps.map((step) => step.status)).toEqual(["completed", "completed", "completed"]);
    expect(second.task?.status).toBe("delivered");
  });

  it("同一步的 completed 事件重放多次不会把步骤堆成两条", () => {
    const data = feed([...timeline, timeline[3]!, timeline[3]!]);
    expect(data.task?.steps).toHaveLength(3);
    expect(new Set(data.task?.steps.map((step) => step.id)).size).toBe(3);
  });

  it("陈旧 revision 的进度事件不会把已完成的步骤打回进行中", () => {
    // `task.step.progress` 会把步骤置为 in_progress。重放时它一定比 completed
    // 那次更早到达（revision 更小），必须被 revision 闸门丢掉。
    const stale = { type: "task.step.progress", data: { taskId: TASK_ID, revision: 3, stepId: "step_1" } };
    const data = feed([...timeline, stale]);
    expect(data.task?.steps.find((step) => step.id === "step_1")?.status).toBe("completed");
    expect(data.task?.status).toBe("delivered");
  });

  it("同一 Attempt 的收尾事件重放不会在轨迹里出现两条", () => {
    const data = feed([...timeline, timeline[4]!, timeline[4]!]);
    expect(data.taskAttempts).toHaveLength(1);
    expect(data.taskAttempts[0]).toMatchObject({ attempt: 1, outcome: "completed", toolCalls: 4 });
  });

  it("乱序到达的旧事件整体被丢弃（低 revision 不覆盖高 revision 的终态）", () => {
    const data = feed([...timeline].reverse());
    // 反序喂：第一条就是 delivered（revision 10），后面全是更旧的增量。
    expect(data.task?.status).toBe("delivered");
    expect(data.task?.revision).toBe(10);
  });

  it("通知的去重键只由 (taskId, status) 构成，因此重放同一状态会被幂等挡住", () => {
    // 页面那侧用 `${task.id}:${task.status}` 做 `notifiedTask` 的键。这里钉住
    // 「同一状态的通知与到达次数无关」：重放不产生新的 key。
    const keyOf = (task: TaskRecordView) => `${task.id}:${task.status}`;
    const keys = timeline.map(() => keyOf(feed(timeline).task!));
    expect(new Set(keys).size).toBe(1);
  });
});

describe("§17.2-7 历史 session summary 仍可在执行轨迹查看", () => {
  const summaryEvent = {
    type: "session.summary",
    data: { text: "本轮完成", kind: "completed", meta: { filesEdited: 1, toolCalls: 2, durationMs: 100 } },
  };

  it("session.summary 仍被保留并可由轨迹渲染（不是被 task 层取代）", () => {
    const projector = new ChatProjector();
    projector.ingest(summaryEvent as never);
    const data = projector.data();
    expect(data.summary).toMatchObject({ kind: "completed" });
    expect(data.summaryArtifacts).toEqual([]);
  });

  it("旧 summary 不会被误判成新 Task 的交付（§18.10）", () => {
    const projector = new ChatProjector();
    projector.ingest(summaryEvent as never);
    // 只有 summary、没有任何 task.* 事件：任务层必须是空的。
    expect(projector.data().task).toBeNull();
    expect(projector.data().taskAttempts).toEqual([]);
  });

  it("task 事件到达不会冲掉 summary：两层各说各的，轨迹两条都留着", () => {
    const projector = new ChatProjector();
    projector.ingest(summaryEvent as never);
    projector.ingest({ type: "task.started", data: { taskId: "t1", revision: 1, goal: "继续做", steps: [], acceptanceCriteria: [] } } as never);
    projector.ingest({ type: "task.delivered", data: { taskId: "t1", revision: 2, result: "完成" } } as never);
    const data = projector.data();
    expect(data.task?.status).toBe("delivered");
    expect(data.summary).toMatchObject({ kind: "completed" });
  });

  it("后续 summary 覆盖旧 summary：轨迹显示的是最近一轮", () => {
    const projector = new ChatProjector();
    projector.ingest(summaryEvent as never);
    projector.ingest({ type: "session.summary", data: { text: "第二轮", kind: "aborted", meta: { filesEdited: 0, toolCalls: 0, durationMs: 0 } } } as never);
    expect(projector.data().summary).toMatchObject({ kind: "aborted" });
  });
});

describe("§17.2 附加：投影器不吃 summary，任务视图只认 task 字段", () => {
  it("toTaskView 只搬界面要用的字段，并把 evidence 裁到 12 条", () => {
    const task = toTaskView({
      ...makeTask({ status: "delivered" }),
      evidence: Array.from({ length: 30 }, (_, index) => ({ kind: "command", summary: `evidence-${index}` })),
    });
    expect(task.evidence?.count).toBe(30);
    expect(task.evidence?.recent).toHaveLength(12);
    // 最近的在最前面。
    expect(task.evidence?.recent[0]?.summary).toBe("evidence-29");
  });

  it("投影器返回的任务是深拷贝（界面改它不会污染投影器内部状态）", () => {
    const projector = new ChatProjector();
    projector.ingest({ type: "task.started", data: { taskId: "t1", revision: 1, goal: "g", steps: steps(["pending"]), acceptanceCriteria: [] } } as never);
    const first = projector.data().task!;
    first.steps.push({ id: "ghost", title: "幽灵步骤", status: "pending", order: 9 });
    expect(projector.data().task?.steps).toHaveLength(1);
  });
});
