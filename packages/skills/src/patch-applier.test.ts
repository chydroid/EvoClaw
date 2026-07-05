import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  seekSequence,
  blockAnchorMatch,
  findSimilarLines,
  isPathSafe,
  applyPatch,
  applySearchReplaceBlocks,
  PatchError,
} from "./patch-applier";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("seekSequence", () => {
  it("pass 1: exact match", () => {
    const content = "line1\nline2\nline3";
    const result = seekSequence(content, "line2");
    expect(result.lineNum).toBe(1);
    expect(result.passUsed).toBe(1);
  });

  it("pass 2: rstrip match (trailing whitespace)", () => {
    const content = "line1   \nline2\nline3";
    const result = seekSequence(content, "line1");
    expect(result.lineNum).toBe(0);
    expect(result.passUsed).toBe(2);
  });

  it("pass 3: strip match (leading whitespace)", () => {
    const content = "  line1\nline2\nline3";
    const result = seekSequence(content, "line1");
    expect(result.lineNum).toBe(0);
    expect(result.passUsed).toBe(3);
  });

  it("pass 4: Unicode 归一化（智能引号 → 普通引号）", () => {
    const content = "it\u2019s a test\nline2"; // 右单引号
    const result = seekSequence(content, "it's a test");
    expect(result.lineNum).toBe(0);
    expect(result.passUsed).toBe(4);
  });

  it("pass 4: Unicode 归一化（em-dash → -）", () => {
    const content = "hello\u2014world\nline2"; // em-dash
    const result = seekSequence(content, "hello-world");
    expect(result.lineNum).toBe(0);
    expect(result.passUsed).toBe(4);
  });

  it("pass 4: NBSP → 普通空格", () => {
    const content = "hello\u00A0world\nline2";
    const result = seekSequence(content, "hello world");
    expect(result.lineNum).toBe(0);
    expect(result.passUsed).toBe(4);
  });

  it("未找到返回 -1", () => {
    const content = "line1\nline2";
    const result = seekSequence(content, "not-exist");
    expect(result.lineNum).toBe(-1);
  });

  it("End-of-File 优先匹配末尾", () => {
    const content = "dup\ndup\ndup\nlast";
    const result = seekSequence(content, "last", true);
    expect(result.lineNum).toBe(3);
  });

  it("多行 block 匹配", () => {
    const content = "a\nb\nc\nd\ne";
    const result = seekSequence(content, "b\nc\nd");
    expect(result.lineNum).toBe(1);
  });
});

describe("blockAnchorMatch", () => {
  it("首末行锚 + 中间 Levenshtein（≥3 行）", () => {
    const content = "header\nfoo bar baz\nqux\nfooter";
    const search = "header\nfoo baz baz\nfooter"; // 中间一行有差异
    const result = blockAnchorMatch(content, search, 0.5);
    expect(result.lineNum).toBe(0);
    expect(result.similarity).toBeGreaterThan(0.5);
  });

  it("相似度不足时不匹配", () => {
    const content = "header\ncompletely different\nfooter";
    const search = "header\nvery different content here\nfooter";
    const result = blockAnchorMatch(content, search, 0.9);
    expect(result.lineNum).toBe(-1);
  });

  it("小于 3 行不适用块锚定", () => {
    const content = "a\nb";
    const search = "a\nb";
    const result = blockAnchorMatch(content, search);
    expect(result.lineNum).toBe(-1);
  });
});

describe("findSimilarLines", () => {
  it("找出相似度 > 0.6 的行", () => {
    const content = "function foo() {\n  return 1;\n}\nfunction bar() {\n  return 2;\n}";
    const search = "function foo()";
    const results = findSimilarLines(content, search, 3, 0.6);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].line).toContain("function foo");
  });

  it("无相似行返回空", () => {
    const content = "abc\ndef\nghi";
    const search = "xyz qwerty";
    const results = findSimilarLines(content, search, 3, 0.6);
    expect(results.length).toBe(0);
  });
});

describe("isPathSafe", () => {
  it("合法相对路径", () => {
    expect(isPathSafe(tmpDir, "SKILL.md")).toBe(true);
    expect(isPathSafe(tmpDir, "subdir/file.md")).toBe(true);
  });

  it("路径逃逸检测（../..）", () => {
    expect(isPathSafe(tmpDir, "../../etc/passwd")).toBe(false);
    expect(isPathSafe(tmpDir, "../../../etc/shadow")).toBe(false);
  });
});

describe("applyPatch", () => {
  it("两阶段原子应用：成功", async () => {
    const filePath = path.join(tmpDir, "test.md");
    fs.writeFileSync(filePath, "line1\nline2\nline3");

    const result = await applyPatch(tmpDir, [
      {
        relativePath: "test.md",
        blocks: [
          { search: "line2", replace: "LINE_TWO" },
        ],
      },
    ]);

    expect(result.success).toBe(true);
    expect(result.appliedBlocks).toBe(1);
    expect(result.modifiedFiles).toEqual([filePath]);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("line1\nLINE_TWO\nline3");
  });

  it("有错误时不写盘", async () => {
    const filePath = path.join(tmpDir, "test.md");
    const originalContent = "line1\nline2\nline3";
    fs.writeFileSync(filePath, originalContent);

    const result = await applyPatch(tmpDir, [
      {
        relativePath: "test.md",
        blocks: [{ search: "NOT_EXIST", replace: "x" }],
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toBeInstanceOf(PatchError);
    // 文件未被修改
    expect(fs.readFileSync(filePath, "utf-8")).toBe(originalContent);
  });

  it("路径逃逸拒绝", async () => {
    const result = await applyPatch(tmpDir, [
      {
        relativePath: "../../etc/passwd",
        blocks: [{ search: "x", replace: "y" }],
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain("Path escape");
  });

  it("文件不存在拒绝", async () => {
    const result = await applyPatch(tmpDir, [
      {
        relativePath: "not-exist.md",
        blocks: [{ search: "x", replace: "y" }],
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain("File not found");
  });

  it("多 block 应用", async () => {
    const filePath = path.join(tmpDir, "multi.md");
    fs.writeFileSync(filePath, "foo\nbar\nbaz\nfoo\nbar\nbaz");

    const result = await applySearchReplaceBlocks(filePath, [
      { search: "foo", replace: "FOO" },
      { search: "bar", replace: "BAR" },
    ]);

    expect(result.success).toBe(true);
    expect(result.appliedBlocks).toBe(2);
    // 第一个 foo/bar 被替换
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("FOO");
    expect(content).toContain("BAR");
  });
});

describe("Unicode 归一化应用", () => {
  it("智能引号匹配后替换", async () => {
    const filePath = path.join(tmpDir, "unicode.md");
    fs.writeFileSync(filePath, "it\u2019s a test\nline2");

    const result = await applySearchReplaceBlocks(filePath, [
      { search: "it's a test", replace: "REPLACED" },
    ]);

    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("REPLACED\nline2");
  });

  it("em-dash 匹配后替换", async () => {
    const filePath = path.join(tmpDir, "dash.md");
    fs.writeFileSync(filePath, "hello\u2014world\nline2");

    const result = await applySearchReplaceBlocks(filePath, [
      { search: "hello-world", replace: "HI_WORLD" },
    ]);

    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("HI_WORLD\nline2");
  });
});
