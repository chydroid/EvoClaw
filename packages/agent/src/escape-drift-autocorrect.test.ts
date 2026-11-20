import { describe, it, expect } from "vitest";
import { maybeCorrectEscapeDrift, AmbiguousEscapeDriftError } from "./escape-drift-autocorrect";

/**
 * 移植 hermes escape_drift_autocorrect 语义的回归测试。
 * 核心不变量：纠正必须先对照文件证实；证不实就原样返回；
 * 证了 old 但 new 的意图无法证明 → AmbiguousEscapeDriftError。
 *
 * JS 源码转义说明：`"x\\\\y"` 是实际字符串 `x\\y`（两个反斜杠），
 * `"x\\y"` 是 `x\y`（一个反斜杠）。
 */
describe("maybeCorrectEscapeDrift — quote 级", () => {
  it("\\' 同时出现在 old+new 且去转义后命中文件 → 纠正并给 note", () => {
    const content = "const msg = 'it works';\n";
    const r = maybeCorrectEscapeDrift(
      "const msg = \\'it works\\';", // wire 伪影：\' 双转义
      "const msg = \\'it fails\\';",
      content,
    );
    expect(r.old).toBe("const msg = 'it works';");
    expect(r.new).toBe("const msg = 'it fails';");
    expect(r.note).toContain("escape-drift auto-corrected");
    expect(r.note).toContain("quote");
  });

  it('\\" 同时出现且去转义后命中 → 纠正', () => {
    const content = 'print("hello")\n';
    const r = maybeCorrectEscapeDrift(
      'print(\\"hello\\")',
      'print(\\"world\\")',
      content,
    );
    expect(r.old).toBe('print("hello")');
    expect(r.new).toBe('print("world")');
    expect(r.note).not.toBeNull();
  });

  it("old_string 本来就命中文件（无漂移）→ 原样返回、note=null", () => {
    const content = "const s = 'x';\n";
    const r = maybeCorrectEscapeDrift("const s = 'x';", "const s = 'y';", content);
    expect(r.old).toBe("const s = 'x';");
    expect(r.note).toBeNull();
  });

  it("去转义后仍不命中文件（文件真含反斜杠转义）→ 拒绝纠正", () => {
    // 文件真的包含 \' 字面量 → strip 后 old 不在文件里 → 不能纠正
    const content = "const s = \\'it works\\';\n";
    const r = maybeCorrectEscapeDrift(
      "const s = \\'it works\\';",
      "const s = \\'it fails\\';",
      content,
    );
    expect(r.old).toBe("const s = \\'it works\\';");
    expect(r.note).toBeNull();
  });

  it("new_string 转义了 old_string 没有的引号种类 → AmbiguousEscapeDriftError", () => {
    // old 只有 \'；new 同时有 \'（签名成立）和 \"（old 没有该种类）→ \" 无法证明是漂移
    const content = "const s = 'it works';\n";
    expect(() =>
      maybeCorrectEscapeDrift(
        "const s = \\'it works\\';",
        String.raw`const t = \'x\' + \"y\";`,
        content,
      ),
    ).toThrow(AmbiguousEscapeDriftError);
  });

  it("裸引号与转义引号混用（种类未被漂移污染）→ 拒绝纠正、原样返回", () => {
    // old_string 里 \' 存在但同时有裸 ' → 该引号种类无法判定为全漂移
    const content = "const a = 'x'; // it's here\n";
    const r = maybeCorrectEscapeDrift(
      "const a = 'x'; // it\\'s here",
      "const a = 'y'; // it\\'s there",
      content,
    );
    expect(r.note).toBeNull();
    expect(r.old).toBe("const a = 'x'; // it\\'s here");
  });
});

describe("maybeCorrectEscapeDrift — backslash 级", () => {
  it("old 全 run 偶数、减半后命中、new 无反斜杠 → 减半 old + note", () => {
    const fileContent = "anchor: x\\y\n"; // 实际字符串：anchor: x\y
    const r = maybeCorrectEscapeDrift(
      "anchor: x\\\\y",       // wire 双倍：anchor: x\\y
      "anchor: replaced-y",   // 无反斜杠
      fileContent,
    );
    expect(r.old).toBe("anchor: x\\y");
    expect(r.new).toBe("anchor: replaced-y");
    expect(r.note).toContain("halved");
  });

  it("减半命中但 new_string 含反斜杠 → AmbiguousEscapeDriftError", () => {
    const fileContent = "anchor: x\\y\n";
    expect(() =>
      maybeCorrectEscapeDrift("anchor: x\\\\y", "anchor: a\\b", fileContent),
    ).toThrow(AmbiguousEscapeDriftError);
  });

  it("run 长度为奇数 → 不满足全偶数 → 拒绝纠正", () => {
    const fileContent = "anchor: x\\y\n";
    // x\\\y 的 run 长度 3（奇数）
    const r = maybeCorrectEscapeDrift("anchor: x\\\\\\y", "anchor: z", fileContent);
    expect(r.note).toBeNull();
    expect(r.old).toBe("anchor: x\\\\\\y");
  });

  it("减半后不命中文件 → 拒绝纠正", () => {
    const fileContent = "anchor: x\\y\n";
    const r = maybeCorrectEscapeDrift("anchor: q\\\\z", "anchor: z", fileContent);
    expect(r.note).toBeNull();
  });

  it("old 本来就命中文件（无漂移）→ 原样返回", () => {
    const fileContent = "anchor: x\\y\n";
    // oldString = "anchor: x\\y" 实际是 x\y，直接命中 → 不走纠正
    const r = maybeCorrectEscapeDrift("anchor: x\\y", "anchor: z", fileContent);
    expect(r.note).toBeNull();
    expect(r.old).toBe("anchor: x\\y");
  });
});

describe("maybeCorrectEscapeDrift — 主入口", () => {
  it("quote 级先于 backslash 级", () => {
    // 签名要求 \' 同时出现在 old+new；old 是双倍反斜杠形态时 quote 路径仍先命中
    const content = "s = 'a'\n";
    const r = maybeCorrectEscapeDrift("s = \\'a\\'", "s = \\'b\\'", content);
    expect(r.note).toContain("quote");
    expect(r.old).toBe("s = 'a'");
    expect(r.new).toBe("s = 'b'");
  });

  it("无任何签名 → 原样返回 note=null", () => {
    const r = maybeCorrectEscapeDrift("foo", "bar", "foo\nbar\n");
    expect(r.note).toBeNull();
    expect(r.old).toBe("foo");
    expect(r.new).toBe("bar");
  });

  it("AmbiguousEscapeDriftError 是 Error 子类、name 正确", () => {
    const e = new AmbiguousEscapeDriftError("test");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("AmbiguousEscapeDriftError");
  });
});
