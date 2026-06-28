import { describe, it, expect } from "vitest";
import {
  secretEqual,
  secretEqualBuffer,
  safeEqualSecret,
  safeEqualSecretBuffer,
} from "./secret-equal";

// ═══════════════════════════════════════════════════════════
// 测试套件：secret-equal（常量时间字符串比较）
// 防 timing attack，支持不等长字符串
// ═══════════════════════════════════════════════════════════

describe("secret-equal > secretEqual", () => {
  it("相等字符串返回 true", () => {
    expect(secretEqual("hello", "hello")).toBe(true);
    expect(secretEqual("secret-token-123", "secret-token-123")).toBe(true);
    expect(secretEqual("a", "a")).toBe(true);
  });

  it("不等字符串返回 false", () => {
    expect(secretEqual("hello", "world")).toBe(false);
    expect(secretEqual("hello", "Hello")).toBe(false);
    expect(secretEqual("secret-token-123", "secret-token-124")).toBe(false);
  });

  it("长度不同返回 false（不抛出异常）", () => {
    expect(secretEqual("short", "longer-string")).toBe(false);
    expect(secretEqual("longer-string", "short")).toBe(false);
    expect(secretEqual("a", "abcdefgh")).toBe(false);
    expect(secretEqual("abcdefgh", "a")).toBe(false);
  });

  it("空字符串处理正确", () => {
    expect(secretEqual("", "")).toBe(true);
    expect(secretEqual("", "a")).toBe(false);
    expect(secretEqual("a", "")).toBe(false);
  });

  it("仅最后一位不同的字符串返回 false", () => {
    expect(secretEqual("token-abc1", "token-abc2")).toBe(false);
    expect(secretEqual("token-abc1", "token-abc1")).toBe(true);
  });
});

describe("secret-equal > secretEqualBuffer", () => {
  it("相等 Buffer 返回 true", () => {
    const a = Buffer.from("hello-secret", "utf8");
    const b = Buffer.from("hello-secret", "utf8");
    expect(secretEqualBuffer(a, b)).toBe(true);
  });

  it("不等 Buffer 返回 false", () => {
    const a = Buffer.from("hello-secret", "utf8");
    const b = Buffer.from("hello-world", "utf8");
    expect(secretEqualBuffer(a, b)).toBe(false);
  });

  it("不等长 Buffer 返回 false", () => {
    const a = Buffer.from("short", "utf8");
    const b = Buffer.from("longer-buffer", "utf8");
    expect(secretEqualBuffer(a, b)).toBe(false);
  });

  it("空 Buffer 处理正确", () => {
    const a = Buffer.alloc(0);
    const b = Buffer.alloc(0);
    expect(secretEqualBuffer(a, b)).toBe(true);
  });
});

describe("secret-equal > safeEqualSecret", () => {
  it("相等字符串返回 true", () => {
    expect(safeEqualSecret("token", "token")).toBe(true);
  });

  it("不等字符串返回 false", () => {
    expect(safeEqualSecret("token-a", "token-b")).toBe(false);
  });

  it("任一为 null/undefined 返回 false（不抛出）", () => {
    expect(safeEqualSecret(null, "token")).toBe(false);
    expect(safeEqualSecret("token", null)).toBe(false);
    expect(safeEqualSecret(undefined, "token")).toBe(false);
    expect(safeEqualSecret("token", undefined)).toBe(false);
    expect(safeEqualSecret(null, null)).toBe(false);
    expect(safeEqualSecret(undefined, undefined)).toBe(false);
  });

  it("两空字符串返回 true", () => {
    expect(safeEqualSecret("", "")).toBe(true);
  });
});

describe("secret-equal > safeEqualSecretBuffer", () => {
  it("相等 Buffer 返回 true", () => {
    const a = Buffer.from("secret", "utf8");
    const b = Buffer.from("secret", "utf8");
    expect(safeEqualSecretBuffer(a, b)).toBe(true);
  });

  it("非 Buffer 输入返回 false（不抛出）", () => {
    expect(safeEqualSecretBuffer(null, Buffer.from("a"))).toBe(false);
    expect(safeEqualSecretBuffer(Buffer.from("a"), undefined)).toBe(false);
    expect(safeEqualSecretBuffer(null, null)).toBe(false);
  });
});
