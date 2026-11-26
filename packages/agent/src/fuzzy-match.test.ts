import { describe, it, expect } from "vitest";
import { fuzzyFindAndReplace, fuzzyFind, isAlreadyApplied } from "./fuzzy-match";

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

  // ★ 2026-11-26 取证（15 次 `file_write` 失败）：只说「找到 N 处匹配」模型
  //   不知道该加哪段上下文，只能重读整个文件再猜。hermes `_format_match_locations`
  //   给出具体行号与片段，模型可直接把相邻行加进 old_string。
  it("多处匹配的报错应附具体行号与片段（hermes _format_match_locations）", () => {
    const content = "line1\nconst total = 0;\nline3\nconst total = 0;\nline5\n";
    const result = fuzzyFindAndReplace(content, "const total = 0;", "const total = 1;", false);
    expect(result.success).toBe(false);
    expect(result.error).toContain("匹配位置");
    expect(result.error).toContain("L2: const total = 0;");
    expect(result.error).toContain("L4: const total = 0;");
  });

  it("匹配位置超过 5 处时截断并提示剩余数量", () => {
    const content = Array.from({ length: 8 }, (_, i) => `x = 1; // ${i}`).join("\n");
    const result = fuzzyFindAndReplace(content, "x = 1;", "x = 2;", false);
    expect(result.success).toBe(false);
    expect(result.error).toContain("... and 3 more");
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

// ══ 2026-11-26：isAlreadyApplied（hermes tools/fuzzy_match.py 对齐）══
// 生产中最常见的 patch 失败是「上一次编辑其实已经成功，模型又发了一遍」。
// 报「找不到 old_string」会把模型推去重读/重发/整文件重写，白烧好几轮。
describe("isAlreadyApplied", () => {
  it("新文本已在、旧文本已消失 → true（重发的同一编辑）", () => {
    const content = "def compute_total(items):\n    return sum(items)\n";
    expect(
      isAlreadyApplied(content, "def compute_sum(items):", "def compute_total(items):"),
    ).toBe(true);
  });

  it("旧文本仍在文件里 → false（真未应用，必须正常走替换）", () => {
    expect(
      isAlreadyApplied("def old_name(x):\n", "def old_name(x):", "def new_name(x):"),
    ).toBe(false);
  });

  it("新文本不在文件里 → false", () => {
    expect(isAlreadyApplied("y = 2\n", "compute_value(1)", "compute_value(1)")).toBe(false);
  });

  it("new_string 太短（<8 字符）不做判定，避免偶然命中", () => {
    expect(isAlreadyApplied("x = 1\n", "x = 0", "x = 1")).toBe(false);
  });

  it("old === new 且文本已在 → true（模型以为没生效又发了一遍）", () => {
    expect(isAlreadyApplied("x = compute_value(1)\n", "compute_value(1)", "compute_value(1)")).toBe(true);
  });
});
