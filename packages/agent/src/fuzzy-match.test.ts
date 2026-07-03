import { describe, it, expect } from "vitest";
import { fuzzyFindAndReplace, fuzzyFind } from "./fuzzy-match";

describe("fuzzyFind", () => {
  it("F1.2 回归：'aa' 在 'aaaa' 中不应产生重叠匹配", () => {
    const { matches, strategy } = fuzzyFind("aaaa", "aa");
    expect(strategy).toBe("exact");
    expect(matches).toHaveLength(2);
    expect(matches).toEqual([[0, 2], [2, 4]]);
  });

  it("空 oldString 应返回空匹配（新增守卫）", () => {
    const { matches, strategy } = fuzzyFind("content", "");
    expect(matches).toHaveLength(0);
    expect(strategy).toBeNull();
  });

  it("应找到唯一的精确匹配", () => {
    const { matches, strategy } = fuzzyFind("hello world", "world");
    expect(matches).toEqual([[6, 11]]);
    expect(strategy).toBe("exact");
  });

  it("字符串不存在时应返回空匹配", () => {
    const { matches, strategy } = fuzzyFind("hello world", "xyz");
    expect(matches).toHaveLength(0);
    expect(strategy).toBeNull();
  });

  it("较长重复模式也应非重叠匹配", () => {
    const { matches } = fuzzyFind("abababab", "ab");
    expect(matches).toHaveLength(4);
    expect(matches).toEqual([[0, 2], [2, 4], [4, 6], [6, 8]]);
  });

  it("单字符重复也应非重叠", () => {
    const { matches } = fuzzyFind("aaaaa", "a");
    expect(matches).toHaveLength(5);
  });
});

describe("fuzzyFindAndReplace", () => {
  it("应替换精确匹配", () => {
    const result = fuzzyFindAndReplace("hello world", "world", "there");
    expect(result.success).toBe(true);
    expect(result.newContent).toBe("hello there");
    expect(result.matchCount).toBe(1);
    expect(result.strategy).toBe("exact");
    expect(result.error).toBeNull();
  });

  it("空 oldString 守卫：应返回失败", () => {
    const result = fuzzyFindAndReplace("content", "", "new");
    expect(result.success).toBe(false);
    expect(result.matchCount).toBe(0);
    expect(result.newContent).toBe("content");
    expect(result.error).toContain("空");
  });

  it("oldString === newString 应返回失败", () => {
    const result = fuzzyFindAndReplace("hello", "hello", "hello");
    expect(result.success).toBe(false);
    expect(result.error).toContain("相同");
  });

  it("replaceAll=false 时多处匹配应返回失败", () => {
    const result = fuzzyFindAndReplace("foo bar foo", "foo", "baz", false);
    expect(result.success).toBe(false);
    expect(result.matchCount).toBe(0);
    expect(result.error).toContain("2");
  });

  it("replaceAll=true 时应替换所有匹配", () => {
    const result = fuzzyFindAndReplace("foo bar foo", "foo", "baz", true);
    expect(result.success).toBe(true);
    expect(result.newContent).toBe("baz bar baz");
    expect(result.matchCount).toBe(2);
  });

  it("未找到匹配应返回失败且保留原内容", () => {
    const result = fuzzyFindAndReplace("hello world", "xyz", "abc");
    expect(result.success).toBe(false);
    expect(result.newContent).toBe("hello world");
    expect(result.strategy).toBeNull();
  });

  it("line_trimmed 策略：行首尾空白差异应匹配", () => {
    const content = "  hello world  \n  foo bar";
    const oldStr = "hello world\nfoo bar";
    const newStr = "hi there\nbaz qux";
    const result = fuzzyFindAndReplace(content, oldStr, newStr, false);
    expect(result.success).toBe(true);
    expect(result.strategy).toBe("line_trimmed");
    expect(result.newContent).toContain("hi there");
  });

  it("escape_normalized 策略：\\n 字面量应匹配真换行", () => {
    const content = "line1\nline2";
    const oldStr = "line1\\nline2";
    const newStr = "replaced";
    const result = fuzzyFindAndReplace(content, oldStr, newStr, false);
    expect(result.success).toBe(true);
    expect(result.strategy).toBe("escape_normalized");
    expect(result.newContent).toBe("replaced");
  });

  it("whitespace_normalized 策略：多空白折叠应匹配", () => {
    const content = "foo    bar     baz";
    const oldStr = "foo bar baz";
    const newStr = "a b c";
    const result = fuzzyFindAndReplace(content, oldStr, newStr, false);
    expect(result.success).toBe(true);
    expect(result.strategy).toBe("whitespace_normalized");
  });
});
