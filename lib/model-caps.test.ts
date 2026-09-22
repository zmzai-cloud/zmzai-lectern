import { beforeEach, describe, expect, it } from "vitest";

import { capsFor, primeModelCaps, primedModelCount } from "./model-caps.js";

/** 缓存挂在 globalThis 上（进程级共享），测试间必须重置。 */
function reset() {
  (globalThis as { __lecternModelCaps?: Map<string, unknown> }).__lecternModelCaps = new Map();
}

beforeEach(reset);

describe("model-caps", () => {
  it("returns undefined before any catalog is primed", () => {
    // 关键契约：目录未加载时不得臆造数值，由调用方回落默认常量
    expect(capsFor("gpt-4o")).toBeUndefined();
  });

  it("resolves real caps after priming", () => {
    primeModelCaps([{ model: "long-ctx", maxInputTokens: 1_000_000, maxOutputTokens: 65_536 }]);
    expect(capsFor("long-ctx")).toEqual({ contextWindow: 1_000_000, maxTokens: 65_536 });
  });

  it("later primes overwrite earlier ones", () => {
    primeModelCaps([{ model: "m", maxInputTokens: 128_000 }]);
    primeModelCaps([{ model: "m", maxInputTokens: 200_000 }]);
    expect(capsFor("m")?.contextWindow).toBe(200_000);
  });

  it("ignores non-positive values so a bad catalog cannot zero the window", () => {
    // 窗口算成 0 会让压缩每轮都触发，比用默认值严重得多
    primeModelCaps([{ model: "zero", maxInputTokens: 0, maxOutputTokens: 0 }, { model: "neg", maxInputTokens: -1 }, { model: "nan", maxInputTokens: Number.NaN }]);
    expect(capsFor("zero")).toEqual({});
    expect(capsFor("neg")).toEqual({});
    expect(capsFor("nan")).toEqual({});
  });

  it("skips entries without a usable model id", () => {
    primeModelCaps([{ model: "  ", maxInputTokens: 100 }, { model: "", maxInputTokens: 100 }, { maxInputTokens: 100 } as never]);
    expect(primedModelCount()).toBe(0);
    expect(capsFor("  ")).toBeUndefined();
  });

  it("tolerates null / empty input", () => {
    expect(() => primeModelCaps(null)).not.toThrow();
    expect(() => primeModelCaps([])).not.toThrow();
    expect(primedModelCount()).toBe(0);
  });

  it("keeps partial coverage per field", () => {
    primeModelCaps([{ model: "m", maxInputTokens: 200_000 }]);
    expect(capsFor("m")).toEqual({ contextWindow: 200_000 });
  });

  it("stores allowed reasoning efforts after priming", () => {
    primeModelCaps([{ model: "m", maxInputTokens: 128_000, allowedReasoningEfforts: ["low", "medium", "high"] }]);
    expect(capsFor("m")?.allowedReasoningEfforts).toEqual(["low", "medium", "high"]);
  });

  it("filters unknown effort levels and dedupes", () => {
    primeModelCaps([{ model: "m", allowedReasoningEfforts: ["low", "low", "bogus", "high"] }]);
    expect(capsFor("m")?.allowedReasoningEfforts).toEqual(["low", "high"]);
  });

  it("omits the field entirely when the allowed list is empty or absent", () => {
    primeModelCaps([
      { model: "empty", allowedReasoningEfforts: [] },
      { model: "absent", maxInputTokens: 128_000 },
    ]);
    expect(capsFor("empty")?.allowedReasoningEfforts).toBeUndefined();
    expect(capsFor("absent")).toEqual({ contextWindow: 128_000 });
  });
});
