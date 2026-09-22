import { describe, expect, it } from "vitest";

import {
  ATTEMPT_TEXT_CAP,
  COMMAND_OUTPUT_CAP,
  fingerprintOf,
  redact,
  sanitizeOutput,
  truncateToBytes,
} from "./sanitize.js";

describe("脱敏 redact", () => {
  it("脱敏 KEY=VALUE 形态", () => {
    const out = redact("API_KEY=sk-abc123");
    expect(out).toContain("API_KEY=");
    expect(out).not.toContain("sk-abc123");
  });

  it("脱敏 Bearer token", () => {
    const out = redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9.abc");
    expect(out).toContain("[redacted]");
  });

  it("脱敏云密钥前缀", () => {
    expect(redact("AKIAIOSFODNN7EXAMPLE")).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redact("sk-abcdefghijklmnopqrst")).not.toContain("sk-abcdefghijklmnopqrst");
    expect(redact("ghp_abcdefghijklmnopqrst")).not.toContain("ghp_abcdefghijklmnopqrst");
  });

  it("脱敏连接串口令", () => {
    const out = redact("mongodb://admin:secretpass@localhost:27017/db");
    expect(out).not.toContain("secretpass");
  });

  it("不误伤普通文本", () => {
    const plain = "running tests: 3 passed, 0 failed";
    expect(redact(plain)).toBe(plain);
  });
});

describe("容量限额 truncateToBytes", () => {
  it("不截断多字节 UTF-8 序列", () => {
    const text = "你好世界".repeat(100);
    const out = truncateToBytes(text, 10);
    // 截断后应是合法 UTF-8（不含替换字符）
    expect(out).not.toContain("\ufffd");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(10);
  });

  it("小于上限时不截断", () => {
    const text = "short";
    expect(truncateToBytes(text, 100)).toBe(text);
  });
});

describe("sanitizeOutput", () => {
  it("超限截断并标记 truncated + 保留原始字节数", () => {
    const raw = "a".repeat(COMMAND_OUTPUT_CAP + 5000);
    const r = sanitizeOutput(raw);
    expect(r.truncated).toBe(true);
    expect(r.outputBytes).toBe(COMMAND_OUTPUT_CAP + 5000);
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThanOrEqual(COMMAND_OUTPUT_CAP);
  });

  it("未超限时 truncated=false", () => {
    const r = sanitizeOutput("hello world");
    expect(r.truncated).toBe(false);
    expect(r.output).toBe("hello world");
  });

  it("单 attempt 文本上限常量已定义", () => {
    expect(ATTEMPT_TEXT_CAP).toBeGreaterThan(COMMAND_OUTPUT_CAP);
  });
});

describe("fingerprintOf", () => {
  it("相同文本指纹一致，不同文本不同", () => {
    expect(fingerprintOf("abc")).toBe(fingerprintOf("abc"));
    expect(fingerprintOf("abc")).not.toBe(fingerprintOf("abd"));
  });
});
