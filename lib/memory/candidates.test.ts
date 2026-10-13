import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vite's builtin enumeration omits node:sqlite on some Node versions.
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

// 文件级共享 dataDir（句柄缓存指向的目录不能中途消失）
const state = vi.hoisted(() => ({ data: "" }));
vi.mock("../projects", () => ({
  dataDirFor: (p: { id: string }) => join(state.data, p.id),
}));

import {
  actCandidate,
  buildExtractionPrompt,
  generateMemoryCandidates,
  listCandidates,
  parseCandidateOutput,
} from "./candidates.js";
import { resetMemoryDbHandlesForTest } from "./binding.js";

beforeEach(() => {
  state.data = mkdtempSync(join(tmpdir(), "k1-candidates-"));
  resetMemoryDbHandlesForTest();
});

afterEach(() => {
  rmSync(state.data, { recursive: true, force: true });
});

describe("parseCandidateOutput 容错解析", () => {
  it("正常 JSON 数组 → 校验通过的候选（kind/scope 归一、批内去重、上限 5）", () => {
    const raw = JSON.stringify([
      { statement: "构建用 pnpm test 跑全量测试", kind: "command", evidence: { files: ["package.json"] }, scope: "project" },
      { statement: "构建用 pnpm test 跑全量测试", kind: "command" }, // 重复
      { statement: "短", kind: "command" }, // <4 字符
      { statement: "过".repeat(501), kind: "command" }, // 超长
      { statement: "kind 非法", kind: "junk" },
      { statement: "scope 归一为 project", kind: "decision", scope: "whatever" },
      { statement: "分支结论", kind: "pitfall", scope: "branch" },
      "not-an-object",
      null,
    ]);
    const out = parseCandidateOutput(raw);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ kind: "command", scope: "project", evidence: { files: ["package.json"] } });
    expect(out[1].scope).toBe("project");
    expect(out[2]).toMatchObject({ kind: "pitfall", scope: "branch" });
  });

  it("code fence / 前后噪声 / 非数组 / null 全兼容", () => {
    expect(parseCandidateOutput('```json\n[{"statement":"构建用 vitest","kind":"command"}]\n```')).toHaveLength(1);
    expect(parseCandidateOutput("前置说明 [ {\"statement\":\"端口 3015\",\"kind\":\"convention\"} ] 后置说明")).toHaveLength(1);
    expect(parseCandidateOutput('{"statement":"不是数组"}')).toHaveLength(0);
    expect(parseCandidateOutput(null)).toHaveLength(0);
    expect(parseCandidateOutput("完全不是 JSON")).toHaveLength(0);
  });
});

describe("buildExtractionPrompt", () => {
  it("带角色标签与规则；transcript 尾部截断到预算内", () => {
    const long = Array.from({ length: 50 }, (_, i) => ({ role: "user" as const, text: `消息${i} `.repeat(50) }));
    const prompt = buildExtractionPrompt(long);
    expect(prompt).toContain("【用户】");
    expect(prompt).toContain("项目记忆提炼器");
    expect(prompt).toContain("消息49");
    expect(prompt.length).toBeLessThan(7000);
  });
});

describe("generateMemoryCandidates 门控与落库", () => {
  it("syncPolicy=off / 空白 transcript → 跳过且不调模型", async () => {
    const callModel = vi.fn();
    expect(await generateMemoryCandidates({ projectId: "p1", sessionId: "s", transcript: [{ role: "user", text: "x" }], syncPolicy: "off" }, { callModel })).toMatchObject({ skipped: true });
    expect(await generateMemoryCandidates({ projectId: "p1", sessionId: "s", transcript: [{ role: "user", text: "  " }], syncPolicy: "manual" }, { callModel })).toMatchObject({ skipped: true });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("manual → pending 待审；模型失败/空输出 → 不落库", async () => {
    const ok = await generateMemoryCandidates(
      { projectId: "p1", sessionId: "s", transcript: [{ role: "assistant", text: "交付完成" }] , syncPolicy: "manual" },
      { callModel: async () => '[{"statement":"构建用 pnpm test","kind":"command"}]' },
    );
    expect(ok).toEqual({ skipped: false, inserted: 1, approvedDirectly: 0 });
    expect(listCandidates("p1", "pending")).toHaveLength(1);

    const fail = await generateMemoryCandidates(
      { projectId: "p1", sessionId: "s2", transcript: [{ role: "assistant", text: "交付" }], syncPolicy: "manual" },
      { callModel: async () => null },
    );
    expect(fail.inserted).toBe(0);
  });

  it("auto → approved 直通（T19b outbox 消费）", async () => {
    await generateMemoryCandidates(
      { projectId: "p1", sessionId: "s", transcript: [{ role: "assistant", text: "交付" }], syncPolicy: "auto" },
      { callModel: async () => '[{"statement":"架构决策 ADR-7","kind":"decision"}]' },
    );
    const approved = listCandidates("p1", "approved");
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({ kind: "decision", status: "approved" });
  });

  it("与库内 pending/approved 语句去重（同语句不重复插入）", async () => {
    const callModel = async () => '[{"statement":"构建用 pnpm test","kind":"command"}]';
    await generateMemoryCandidates({ projectId: "p1", sessionId: "s", transcript: [{ role: "assistant", text: "x" }], syncPolicy: "manual" }, { callModel });
    await generateMemoryCandidates({ projectId: "p1", sessionId: "s", transcript: [{ role: "assistant", text: "x" }], syncPolicy: "manual" }, { callModel });
    expect(listCandidates("p1")).toHaveLength(1);
  });
});

describe("actCandidate 审阅动作", () => {
  it("approve/discard/改写语句；不存在或不合法 → null", async () => {
    await generateMemoryCandidates(
      { projectId: "p1", sessionId: "s", transcript: [{ role: "assistant", text: "x" }], syncPolicy: "manual" },
      { callModel: async () => '[{"statement":"原始语句足够长","kind":"convention"}]' },
    );
    const [row] = listCandidates("p1", "pending");
    const edited = actCandidate("p1", row.id, "approve", "改写后的语句");
    expect(edited).toMatchObject({ status: "approved", statement: "改写后的语句" });

    const [row2] = listCandidates("p1", "approved");
    expect(actCandidate("p1", row2.id, "discard")?.status).toBe("discarded");

    expect(actCandidate("p1", 9999, "approve")).toBeNull();
    expect(actCandidate("p1", row2.id, "discard", "x")).toBeNull(); // 改写长度 <4
  });
});
