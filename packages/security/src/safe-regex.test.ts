import { describe, it, expect } from "vitest";
import {
  checkRegexSafety,
  safeRegExp,
  isUnsafeRegex,
} from "./safe-regex";

// ═══════════════════════════════════════════════════════════
// 测试套件：safe-regex（ReDoS 防护）
// 检测指数级回溯风险的正则表达式
// ═══════════════════════════════════════════════════════════

describe("safe-regex > 安全正则", () => {
  it("简单字符串匹配视为低风险", () => {
    const result = checkRegexSafety("hello");
    expect(result.safe).toBe(true);
    expect(result.risk).toBe("low");
    expect(result.issues).toHaveLength(0);
  });

  it("普通量词视为安全", () => {
    const result = checkRegexSafety("a+");
    expect(result.safe).toBe(true);
    expect(result.risk).toBe("low");
  });

  it("字符类内量词不误报", () => {
    // 字符类内的 + 不应被识别为嵌套量词
    const result = checkRegexSafety("[a-z]+");
    expect(result.safe).toBe(true);
  });

  it("转义序列后量词不误报", () => {
    const result = checkRegexSafety("\\d+");
    expect(result.safe).toBe(true);
  });

  it("接受 RegExp 实例输入", () => {
    const result = checkRegexSafety(/hello/);
    expect(result.safe).toBe(true);
    expect(result.risk).toBe("low");
  });
});

describe("safe-regex > 嵌套量词", () => {
  it("(a+)+ 视为高风险", () => {
    const result = checkRegexSafety("(a+)+");
    expect(result.safe).toBe(false);
    expect(["high", "critical"]).toContain(result.risk);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("(a*)* 视为高风险", () => {
    const result = checkRegexSafety("(a*)*");
    expect(result.safe).toBe(false);
    expect(["high", "critical"]).toContain(result.risk);
  });

  it("a++ 视为不安全", () => {
    const result = checkRegexSafety("a++");
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("(a+)*b 视为不安全", () => {
    const result = checkRegexSafety("(a+)*b");
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe("safe-regex > 通配符 + 量词", () => {
  it(".*.* 视为不安全", () => {
    const result = checkRegexSafety(".*.*");
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it(".+.+ 视为不安全", () => {
    const result = checkRegexSafety(".+.+");
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe("safe-regex > 重叠量词", () => {
  it("a+a+ 视为不安全", () => {
    const result = checkRegexSafety("a+a+");
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe("safe-regex > safeRegExp", () => {
  it("安全正则正常编译", () => {
    const re = safeRegExp("hello");
    expect(re).toBeInstanceOf(RegExp);
    expect(re.test("hello world")).toBe(true);
  });

  it("安全正则带 flags 编译", () => {
    const re = safeRegExp("hello", "i");
    expect(re.flags).toBe("i");
    expect(re.test("HELLO")).toBe(true);
  });

  it("不安全正则抛出错误", () => {
    expect(() => safeRegExp("(a+)+")).toThrow(/Unsafe regex/);
  });

  it("通配符嵌套抛出错误", () => {
    expect(() => safeRegExp(".*.*")).toThrow(/Unsafe regex/);
  });
});

describe("safe-regex > isUnsafeRegex", () => {
  it("安全正则返回 false", () => {
    expect(isUnsafeRegex("hello")).toBe(false);
    expect(isUnsafeRegex("a+")).toBe(false);
  });

  it("不安全正则返回 true", () => {
    expect(isUnsafeRegex("(a+)+")).toBe(true);
    expect(isUnsafeRegex(".*.*")).toBe(true);
  });
});

describe("safe-regex > estimateBacktracking", () => {
  it("无量化字符串回溯为 1", () => {
    const result = checkRegexSafety("hello");
    expect(result.estimatedBacktracking).toBe(1);
  });

  it("嵌套量词回溯上界大于 1", () => {
    const result = checkRegexSafety("(a+)+");
    expect(result.estimatedBacktracking).toBeGreaterThan(1);
  });
});

describe("safe-regex > 空字符串", () => {
  it("空字符串视为安全", () => {
    const result = checkRegexSafety("");
    expect(result.safe).toBe(true);
    expect(result.risk).toBe("low");
    expect(result.estimatedBacktracking).toBe(1);
  });
});
