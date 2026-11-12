import { describe, it, expect } from "vitest";
import {
  findUniqueMemoryMatch,
  findNearestMemory,
  countOccurrences,
  memorySimilarity,
  type MemoryMatchTarget,
} from "./memory-match";

/**
 * P4 — 记忆写入闸门匹配器（对标 Hermes memory_tool_store.py）。
 */
describe("findUniqueMemoryMatch", () => {
  const entries: MemoryMatchTarget[] = [
    { id: "a", content: "项目进度：完成登录页" },
    { id: "b", content: "项目进度：完成注册页" },
    { id: "c", content: "季度目标" },
  ];

  it("整条精确匹配优先于子串匹配", () => {
    const list: MemoryMatchTarget[] = [
      { id: "exact", content: "季度目标" },
      { id: "contains", content: "本周季度目标说明" },
    ];
    const outcome = findUniqueMemoryMatch(list, "季度目标");
    expect(outcome.status).toBe("matched");
    if (outcome.status === "matched") {
      expect(outcome.entry.id).toBe("exact");
      expect(outcome.exact).toBe(true);
    }
  });

  it("唯一子串匹配 → matched(exact=false)", () => {
    const outcome = findUniqueMemoryMatch(entries, "季度");
    expect(outcome.status).toBe("matched");
    if (outcome.status === "matched") {
      expect(outcome.entry.id).toBe("c");
      expect(outcome.exact).toBe(false);
    }
  });

  it("跨条目歧义 → ambiguous + 候选（内容截断 200）", () => {
    const outcome = findUniqueMemoryMatch(entries, "项目进度");
    expect(outcome.status).toBe("ambiguous");
    if (outcome.status === "ambiguous") {
      expect(outcome.candidates.map((c) => c.id)).toEqual(["a", "b"]);
      for (const c of outcome.candidates) expect(c.content.length).toBeLessThanOrEqual(201);
    }
  });

  it("无匹配 → not_found + 最近条目", () => {
    const outcome = findUniqueMemoryMatch(entries, "登录页进度");
    expect(outcome.status).toBe("not_found");
    if (outcome.status === "not_found") {
      expect(outcome.nearest?.id).toBe("a");
    }
  });

  it("空 needle → not_found", () => {
    expect(findUniqueMemoryMatch(entries, "").status).toBe("not_found");
  });

  it("多条内容完全相同的精确匹配 → ambiguous", () => {
    const list: MemoryMatchTarget[] = [
      { id: "1", content: "same" },
      { id: "2", content: "same" },
    ];
    expect(findUniqueMemoryMatch(list, "same").status).toBe("ambiguous");
  });
});

describe("findNearestMemory / memorySimilarity", () => {
  it("bigram 相似度：相同文本为 1，完全不相关为 0", () => {
    expect(memorySimilarity("hello world", "hello world")).toBeCloseTo(1);
    expect(memorySimilarity("今天天气不错", "hello")).toBe(0);
  });

  it("空输入返回 undefined", () => {
    expect(findNearestMemory([], "x")).toBeUndefined();
    expect(findNearestMemory([{ id: "a", content: "x" }], "")).toBeUndefined();
  });
});

describe("countOccurrences", () => {
  it("统计不重叠出现次数", () => {
    expect(countOccurrences("a-b-a-b", "a")).toBe(2);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abc", "z")).toBe(0);
    expect(countOccurrences("abc", "")).toBe(0);
  });
});
