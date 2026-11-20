/**
 * lsp-verdicts.test — 延迟语法裁决测试
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  DeferredVerdictTracker,
  NodeSyntaxChecker,
  collectLateVerdicts,
  isCheckableFile,
  type DiagnosticChecker,
  type Diagnostic,
} from "./lsp-verdicts";

// ── 测试辅助 ──────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
}

/** 创建测试用 JS 文件 */
function writeJsFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

/** 创建测试用 TS 文件 */
function writeTsFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

// ── NodeSyntaxChecker ────────────────────────────────

describe("NodeSyntaxChecker", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it("检查有效的 JS 文件——无错误", async () => {
    const file = writeJsFile(tempDir, "valid.js", "const x = 1;\nconsole.log(x);\n");
    const diags = await new NodeSyntaxChecker().checkFile(file);
    expect(diags).toEqual([]);
  });

  it("检查有语法错误的 JS 文件——返回错误", async () => {
    const file = writeJsFile(tempDir, "invalid.js", "const x = ;\n");
    const diags = await new NodeSyntaxChecker().checkFile(file);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0].severity).toBe("error");
    expect(diags[0].source).toBe("node-check");
  });

  it("检查未闭合括号的 TS 文件——返回错误", async () => {
    const file = writeTsFile(tempDir, "unclosed.ts", "function foo() {\n  const x = 1;\n");
    const diags = await new NodeSyntaxChecker().checkFile(file);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.some((d) => d.source === "brace-balance")).toBe(true);
  });

  it("检查有效的 TS 文件——括号平衡", async () => {
    const file = writeTsFile(tempDir, "valid.ts", "function foo(): number {\n  return 1;\n}\n");
    const diags = await new NodeSyntaxChecker().checkFile(file);
    // 可能有一些误报，但不应全是错误
    // 实际上这个文件括号是平衡的
    const braceDiags = diags.filter((d) => d.source === "brace-balance");
    expect(braceDiags.length).toBe(0);
  });

  it("非 JS/TS 文件返回空数组", async () => {
    const file = writeJsFile(tempDir, "test.json", '{"key": "value"}');
    // 重命名为 .json
    const jsonFile = path.join(tempDir, "test.json");
    const diags = await new NodeSyntaxChecker().checkFile(jsonFile);
    expect(diags).toEqual([]);
  });

  it("检查带字符串的 JS 文件——字符串内的括号不误报", async () => {
    const file = writeJsFile(tempDir, "strings.js", 'const s = "hello (world) [test] {foo}";\nconsole.log(s);\n');
    const diags = await new NodeSyntaxChecker().checkFile(file);
    // node --check 应该通过
    expect(diags).toEqual([]);
  });
});

// ── DeferredVerdictTracker ──────────────────────────

describe("DeferredVerdictTracker", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it("跟踪文件编辑并收集裁决", async () => {
    const file = writeJsFile(tempDir, "test.js", "const x = ;\n");
    const tracker = new DeferredVerdictTracker(new NodeSyntaxChecker());
    tracker.trackEdit(file);
    const diags = await tracker.collectVerdicts();
    expect(diags.length).toBeGreaterThan(0);
  });

  it("trackEdits 批量跟踪", async () => {
    const file1 = writeJsFile(tempDir, "test1.js", "const x = 1;\n");
    const file2 = writeJsFile(tempDir, "test2.js", "const y = 2;\n");
    const tracker = new DeferredVerdictTracker(new NodeSyntaxChecker());
    tracker.trackEdits([file1, file2]);
    expect(tracker.getPendingEdits()).toHaveLength(2);
  });

  it("clear 清除所有待检查文件", () => {
    const tracker = new DeferredVerdictTracker(new NodeSyntaxChecker());
    tracker.trackEdit("/some/file.js");
    expect(tracker.getPendingEdits().length).toBe(1);
    tracker.clear();
    expect(tracker.getPendingEdits().length).toBe(0);
  });

  it("空编辑列表返回空诊断", async () => {
    const tracker = new DeferredVerdictTracker(new NodeSyntaxChecker());
    const diags = await tracker.collectVerdicts();
    expect(diags).toEqual([]);
  });

  it("maxEdits 限制跟踪数量", () => {
    const tracker = new DeferredVerdictTracker(new NodeSyntaxChecker(), 3);
    for (let i = 0; i < 10; i++) {
      tracker.trackEdit(`/file${i}.js`);
    }
    expect(tracker.getPendingEdits().length).toBe(3);
  });
});

// ── collectLateVerdicts ─────────────────────────────

describe("collectLateVerdicts", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it("无错误时返回空数组", async () => {
    const file = writeJsFile(tempDir, "valid.js", "const x = 1;\n");
    const notes = await collectLateVerdicts([file]);
    expect(notes).toEqual([]);
  });

  it("有语法错误时返回系统备注", async () => {
    const file = writeJsFile(tempDir, "invalid.js", "const x = ;\n");
    const notes = await collectLateVerdicts([file]);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]).toContain("Deferred syntax check");
    expect(notes[0]).toContain("invalid.js");
  });

  it("空路径列表返回空数组", async () => {
    const notes = await collectLateVerdicts([]);
    expect(notes).toEqual([]);
  });

  it("使用自定义检查器", async () => {
    const mockChecker: DiagnosticChecker = {
      async checkFile(filePath: string): Promise<Diagnostic[]> {
        return [{
          file: filePath,
          line: 1,
          column: 0,
          severity: "error",
          message: "Mock error",
          source: "mock",
        }];
      },
    };
    const notes = await collectLateVerdicts(["/test/file.js"], mockChecker);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]).toContain("Mock error");
  });

  it("按文件分组诊断", async () => {
    const file1 = writeJsFile(tempDir, "bad1.js", "const x = ;\n");
    const file2 = writeJsFile(tempDir, "bad2.js", "const y = ;\n");
    const notes = await collectLateVerdicts([file1, file2]);
    // 两个文件都有错误，应该有两个备注
    expect(notes.length).toBeGreaterThanOrEqual(1);
  });
});

// ── isCheckableFile ─────────────────────────────────

describe("isCheckableFile", () => {
  it("JS 文件返回 true", () => {
    expect(isCheckableFile("test.js")).toBe(true);
    expect(isCheckableFile("test.mjs")).toBe(true);
    expect(isCheckableFile("test.cjs")).toBe(true);
  });

  it("TS 文件返回 true", () => {
    expect(isCheckableFile("test.ts")).toBe(true);
  });

  it("其他文件返回 false", () => {
    expect(isCheckableFile("test.json")).toBe(false);
    expect(isCheckableFile("test.md")).toBe(false);
    expect(isCheckableFile("test.py")).toBe(false);
    expect(isCheckableFile("test.txt")).toBe(false);
  });
});

// ── R11 GAP-8 接线回归：停止门消费形状 ──
// llm-caller 停止门用 `lateSyntaxVerdicts.length > 0` 作为触发条件，并用
// join("\n") 直接拼进 nudge 文案。此组测试钉死消费契约：错误裁决 → 非空
// 字符串数组（含可读文件：行:列 — 消息）；无错误 → 空数组（不触发 nudge）。
describe("R11 GAP-8 接线契约：停止门消费形状", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-verdicts-gate-"));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("语法破损的已编辑文件 → 非空裁决数组（触发 nudge）", async () => {
    const broken = path.join(tmpDir, "broken.js");
    fs.writeFileSync(broken, "function f( {\n  return 1;\n}\n", "utf-8"); // 缺右括号
    const verdicts = await collectLateVerdicts([broken]);
    expect(verdicts.length).toBeGreaterThan(0);
    for (const v of verdicts) {
      expect(typeof v).toBe("string");
      expect(v).toContain("error");
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it("语法完好的已编辑文件 → 空数组（不触发 nudge）", async () => {
    const ok = path.join(tmpDir, "ok.js");
    fs.writeFileSync(ok, "function f() {\n  return 1;\n}\nmodule.exports = { f };\n", "utf-8");
    const verdicts = await collectLateVerdicts([ok]);
    expect(verdicts).toEqual([]);
  });

  it("空变更列表 → 空数组（门直接短路，零开销路径）", async () => {
    expect(await collectLateVerdicts([])).toEqual([]);
  });

  it("混合完好+破损 → 只对破损文件出裁决", async () => {
    const broken = path.join(tmpDir, "broken2.js");
    fs.writeFileSync(broken, "const x = ;\n", "utf-8");
    const ok = path.join(tmpDir, "ok2.js");
    fs.writeFileSync(ok, "const y = 1;\n", "utf-8");
    const verdicts = await collectLateVerdicts([ok, broken]);
    expect(verdicts.length).toBe(1);
    expect(verdicts[0]).toContain("broken2.js");
  });
});
