import { describe, it, expect } from "vitest";
import {
  stableStringify,
  stableHash,
  stableEqual,
  stableDiff,
} from "./stable-stringify";

describe("stableStringify", () => {
  it("基础类型：string/number/boolean/null", () => {
    expect(stableStringify("hello")).toBe('"hello"');
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify(true)).toBe("true");
    expect(stableStringify(false)).toBe("false");
    expect(stableStringify(null)).toBe("null");
  });

  it("对象 key 按字典序排序", () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { a: 2, b: 1, c: 3 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(a)).toBe('{"a":2,"b":1,"c":3}');
  });

  it("数组：保持顺序，不排序", () => {
    const arr = [3, 1, 2];
    expect(stableStringify(arr)).toBe("[3,1,2]");
  });

  it("嵌套对象递归排序", () => {
    const a = { outer: { z: 1, a: 2 } };
    const b = { outer: { a: 2, z: 1 } };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(a)).toBe('{"outer":{"a":2,"z":1}}');
  });

  it("默认丢弃 undefined 值", () => {
    const obj = { a: 1, b: undefined, c: 3 };
    expect(stableStringify(obj)).toBe('{"a":1,"c":3}');
  });

  it("dropUndefined=false 时 undefined → null", () => {
    const obj = { a: 1, b: undefined, c: 3 };
    expect(stableStringify(obj, { dropUndefined: false })).toBe(
      '{"a":1,"b":null,"c":3}',
    );
  });

  it("NaN/Infinity 默认转为 null（JSON 规范）", () => {
    expect(stableStringify(NaN)).toBe("null");
    expect(stableStringify(Infinity)).toBe("null");
    expect(stableStringify(-Infinity)).toBe("null");
  });

  it("normalizeNumeric=false 时 NaN/Infinity 转为字符串", () => {
    expect(stableStringify(NaN, { normalizeNumeric: false })).toBe('"NaN"');
    expect(stableStringify(Infinity, { normalizeNumeric: false })).toBe('"Infinity"');
  });

  it("topLevelKeyOrder 按指定顺序输出", () => {
    const obj = { name: "x", id: 1, age: 30, type: "user" };
    const out = stableStringify(obj, {
      topLevelKeyOrder: ["id", "type", "name"],
    });
    // id, type, name 按指定顺序，age 按字典序追加
    expect(out).toBe('{"id":1,"type":"user","name":"x","age":30}');
  });

  it("replacer 自定义值转换", () => {
    const obj = { secret: "abc", name: "x" };
    const out = stableStringify(obj, {
      replacer: (key, value) => {
        if (key === "secret") return "[REDACTED]";
        return value;
      },
    });
    expect(out).toBe('{"name":"x","secret":"[REDACTED]"}');
  });

  it("处理循环引用不抛错", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = stableStringify(a);
    expect(out).toContain("[Circular]");
  });

  it("indent 选项产生缩进输出", () => {
    const obj = { b: 1, a: 2 };
    const out = stableStringify(obj, { indent: 2 });
    expect(out).toContain("\n");
    expect(out).toContain('  "a": 2');
  });

  it("Date → ISO 字符串", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    expect(stableStringify(d)).toBe('"2026-01-01T00:00:00.000Z"');
  });

  it("Map → 按 key 字典序的对象", () => {
    const m = new Map([
      ["z", 1],
      ["a", 2],
    ]);
    expect(stableStringify(m)).toBe('{"a":2,"z":1}');
  });

  it("Set → 数组", () => {
    const s = new Set([3, 1, 2]);
    expect(stableStringify(s)).toBe("[3,1,2]");
  });

  it("bigint → 字符串", () => {
    expect(stableStringify(123n)).toBe('"123"');
  });
});

describe("stableHash", () => {
  it("相同对象产生相同 hash", () => {
    const a = { b: 1, a: 2 };
    const b = { a: 2, b: 1 };
    expect(stableHash(a)).toBe(stableHash(b));
  });

  it("不同对象产生不同 hash", () => {
    const a = { a: 1 };
    const b = { a: 2 };
    expect(stableHash(a)).not.toBe(stableHash(b));
  });

  it("hash 包含长度后缀", () => {
    const hash = stableHash({ a: 1 });
    expect(hash).toContain(":");
    const [, lenPart] = hash.split(":");
    expect(parseInt(lenPart, 36)).toBeGreaterThan(0);
  });
});

describe("stableEqual", () => {
  it("语义相同返回 true（key 顺序不同）", () => {
    const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
    const b = { a: 2, b: 1, c: { x: 2, y: 1 } };
    expect(stableEqual(a, b)).toBe(true);
  });

  it("语义不同返回 false", () => {
    const a = { a: 1 };
    const b = { a: 2 };
    expect(stableEqual(a, b)).toBe(false);
  });
});

describe("stableDiff", () => {
  it("新增字段标记为 added", () => {
    const diffs = stableDiff({ a: 1 }, { a: 1, b: 2 });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("added");
    expect(diffs[0].path).toBe("b");
    expect(diffs[0].newValue).toBe(2);
  });

  it("删除字段标记为 removed", () => {
    const diffs = stableDiff({ a: 1, b: 2 }, { a: 1 });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("removed");
    expect(diffs[0].path).toBe("b");
    expect(diffs[0].oldValue).toBe(2);
  });

  it("字段变化标记为 changed", () => {
    const diffs = stableDiff({ a: 1 }, { a: 2 });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("changed");
    expect(diffs[0].oldValue).toBe(1);
    expect(diffs[0].newValue).toBe(2);
  });

  it("嵌套路径正确", () => {
    const diffs = stableDiff(
      { user: { name: "a", age: 1 } },
      { user: { name: "b", age: 1 } },
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toBe("user.name");
  });

  it("数组元素差异按索引标记", () => {
    const diffs = stableDiff([1, 2, 3], [1, 9, 3]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toBe("[1]");
  });

  it("数组长度变化标记 added/removed", () => {
    const diffs = stableDiff([1, 2], [1, 2, 3]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("added");
    expect(diffs[0].path).toBe("[2]");
  });

  it("完全相同返回空数组", () => {
    const diffs = stableDiff({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] });
    expect(diffs).toEqual([]);
  });

  it("支持 basePath 前缀", () => {
    const diffs = stableDiff({ a: 1 }, { a: 2 }, "root");
    expect(diffs[0].path).toBe("root.a");
  });
});
