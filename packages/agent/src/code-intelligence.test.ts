import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock child_process.execFile（必须在 import GitOperations 之前）
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { GitOperations } from "./git-operations";
import { CodeIntelligence } from "./code-intelligence";
import { parsePatch, applyPatch } from "./apply-patch-tool";

let tmpDir: string;

/** 检测当前环境是否支持创建 symlink（Windows 非管理员/未开启开发者模式时会失败） */
const SYMLINK_SUPPORTED = (() => {
  try {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "symtest-"));
    const t = path.join(d, "target.txt");
    const l = path.join(d, "link.txt");
    fs.writeFileSync(t, "");
    fs.symlinkSync(t, l);
    fs.rmSync(d, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-test-"));
  vi.mocked(execFile).mockReset();
});

afterEach(() => {
  vi.mocked(execFile).mockReset();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 设置 execFile mock：固定输出或按 args 动态返回 */
function setGitMock(output: string | ((args: string[]) => string)): void {
  vi.mocked(execFile).mockImplementation(
    ((...args: unknown[]) => {
      const cmdArgs = (args[1] as string[]) ?? [];
      const cb = args[args.length - 1] as (
        err: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      if (typeof cb !== "function") return undefined;
      const out = typeof output === "function" ? output(cmdArgs) : output;
      cb(null, out, "");
      return undefined;
    }) as unknown as typeof execFile,
  );
}

/** 访问 GitOperations 的 private run 方法用于测试危险命令拦截 */
function callRun(git: GitOperations, args: string[]): Promise<string> {
  return (git as unknown as { run: (a: string[]) => Promise<string> }).run(args);
}

// ── GitOperations ────────────────────────────────────────────

describe("GitOperations", () => {
  it("应正确解析 porcelain v1 status 输出", async () => {
    setGitMock(
      "M  src/foo.ts\n M src/bar.ts\n?? src/baz.ts\nA  src/new.ts\nR  src/renamed.ts -> src/old.ts",
    );
    const git = new GitOperations({ cwd: tmpDir });
    const result = await git.status();
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ path: "src/foo.ts", staged: "modified", unstaged: null });
    expect(result[1]).toEqual({ path: "src/bar.ts", staged: "untracked", unstaged: "modified" });
    expect(result[2]).toEqual({ path: "src/baz.ts", staged: "untracked", unstaged: null });
    expect(result[3]).toEqual({ path: "src/new.ts", staged: "added", unstaged: null });
    expect(result[4]).toEqual({ path: "src/renamed.ts", staged: "renamed", unstaged: null });
  });

  it("应正确解析 log 输出（pretty + numstat）", async () => {
    setGitMock(
      "abc123|John|john@x.com|2024-01-01 12:00:00 +0000|fix: bug\n1\t2\tsrc/foo.ts\n\ndef456|Jane|jane@x.com|2024-01-01 11:00:00 +0000|refactor\n3\t0\tsrc/bar.ts",
    );
    const git = new GitOperations({ cwd: tmpDir });
    const result = await git.log();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      hash: "abc123",
      author: "John",
      email: "john@x.com",
      date: "2024-01-01 12:00:00 +0000",
      message: "fix: bug",
      filesChanged: 1,
    });
    expect(result[1]).toMatchObject({
      hash: "def456",
      author: "Jane",
      message: "refactor",
      filesChanged: 1,
    });
  });

  it("应正确解析 blame -p 输出", async () => {
    // 注意：git blame -p 内容行必须以 \t 开头
    setGitMock(
      "abc123 1 1\nauthor John\nauthor-mail <john@x.com>\nauthor-time 1704067200\nsummary fix\n\ttest line 1\nabc123 2 2\nauthor John\nauthor-time 1704067200\nsummary fix\n\tline 2 content",
    );
    const git = new GitOperations({ cwd: tmpDir });
    const result = await git.blame("src/foo.ts");
    expect(result).toHaveLength(2);
    expect(result[0].hash).toBe("abc123");
    expect(result[0].author).toBe("John");
    expect(result[0].line).toBe(1);
    expect(result[1].line).toBe(2);
  });

  it("push 不带 force 时不应添加 --force 参数", async () => {
    setGitMock("");
    const git = new GitOperations({ cwd: tmpDir });
    await git.push("origin", "main");
    const callArgs = vi.mocked(execFile).mock.calls.at(-1);
    const args = (callArgs?.[1] as string[]) ?? [];
    expect(args).not.toContain("--force");
  });

  it("push 带 force=true 时应添加 --force 并 warn", async () => {
    setGitMock("");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const git = new GitOperations({ cwd: tmpDir });
    await git.push("origin", "main", true);
    const callArgs = vi.mocked(execFile).mock.calls.at(-1);
    const args = (callArgs?.[1] as string[]) ?? [];
    expect(args).toContain("--force");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("应拦截 reset --hard 命令", async () => {
    const git = new GitOperations({ cwd: tmpDir });
    await expect(callRun(git, ["reset", "--hard", "HEAD"])).rejects.toThrow(
      "reset --hard is not allowed",
    );
  });

  it("应拦截 clean -fd 命令", async () => {
    const git = new GitOperations({ cwd: tmpDir });
    await expect(callRun(git, ["clean", "-fd"])).rejects.toThrow("clean -fd is not allowed");
  });

  it("应拦截 branch -D 命令", async () => {
    const git = new GitOperations({ cwd: tmpDir });
    await expect(callRun(git, ["branch", "-D", "feature"])).rejects.toThrow(
      "branch -D is not allowed",
    );
  });

  it("git 命令失败时 reject 的 Error 应包含 stderr", async () => {
    // 重新 mock 让 cb 返回 err+stderr
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        err: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      if (typeof cb === "function") cb(new Error("exit code 1"), "", "fatal: not a git repository");
      return undefined;
    }) as unknown as typeof execFile);
    const git = new GitOperations({ cwd: tmpDir });
    await expect(git.status()).rejects.toThrow(/fatal: not a git repository/);
  });
});

// ── CodeIntelligence ─────────────────────────────────────────

describe("CodeIntelligence", () => {
  it("detectLanguage 应按扩展名映射语言", () => {
    const ci = new CodeIntelligence(tmpDir);
    expect(ci.detectLanguage("foo.ts")).toBe("typescript");
    expect(ci.detectLanguage("foo.tsx")).toBe("typescript");
    expect(ci.detectLanguage("foo.js")).toBe("javascript");
    expect(ci.detectLanguage("foo.py")).toBe("python");
    expect(ci.detectLanguage("foo.go")).toBe("go");
    expect(ci.detectLanguage("foo.rs")).toBe("rust");
    expect(ci.detectLanguage("foo.unknown")).toBe("unknown");
  });

  it("parseSymbols 应解析 TS 文件的函数/类/接口/类型/变量", async () => {
    const tsContent = [
      "export function foo() { return 1; }",
      "export class Bar { baz() {} }",
      "export interface Qux {}",
      "export type Quux = number;",
      "const x = 1;",
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "test.ts"), tsContent);
    const ci = new CodeIntelligence(tmpDir);
    const symbols = await ci.parseSymbols("test.ts");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("foo");
    expect(names).toContain("Bar");
    expect(names).toContain("Qux");
    expect(names).toContain("Quux");
    expect(names).toContain("x");

    const fooSym = symbols.find((s) => s.name === "foo");
    expect(fooSym?.kind).toBe("function");
    expect(fooSym?.language).toBe("typescript");
    expect(fooSym?.startLine).toBe(1);

    const quxSym = symbols.find((s) => s.name === "Qux");
    expect(quxSym?.kind).toBe("interface");
  });

  it("parseSymbols 应解析 Python 文件的 def/class", async () => {
    const pyContent = [
      "def foo():",
      "    pass",
      "",
      "class Bar:",
      "    def baz(self):",
      "        pass",
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "test.py"), pyContent);
    const ci = new CodeIntelligence(tmpDir);
    const symbols = await ci.parseSymbols("test.py");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("foo");
    expect(names).toContain("Bar");
    expect(names).toContain("baz");

    const bazSym = symbols.find((s) => s.name === "baz");
    expect(bazSym?.kind).toBe("method");
    expect(bazSym?.language).toBe("python");

    const fooSym = symbols.find((s) => s.name === "foo");
    expect(fooSym?.kind).toBe("function");
  });

  it("findReferences 应在指定文件中查找引用并跳过注释行", async () => {
    const tsContent = [
      "export function foo() { return 1; }",
      "const x = foo();",
      "const y = foo() + 1;",
      "// foo comment",
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "ref.ts"), tsContent);
    const ci = new CodeIntelligence(tmpDir);
    const refs = await ci.findReferences("foo", "ref.ts");
    // 定义行 + 2 个调用行（注释行被跳过）
    expect(refs).toHaveLength(3);
    expect(refs.every((r) => r.filePath.endsWith("ref.ts"))).toBe(true);
    const lines = refs.map((r) => r.line).sort((a, b) => a - b);
    expect(lines).toEqual([1, 2, 3]);
  });

  it("planRename 应构建重命名计划", async () => {
    const tsContent = ["export function foo() { return 1; }", "const x = foo();"].join("\n");
    fs.writeFileSync(path.join(tmpDir, "rename.ts"), tsContent);
    const ci = new CodeIntelligence(tmpDir);
    const plan = await ci.planRename("foo", "bar", "rename.ts");
    expect(plan.oldName).toBe("foo");
    expect(plan.newName).toBe("bar");
    expect(plan.totalOccurrences).toBe(2);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].changes).toHaveLength(2);
  });

  it("applyRename 应实际修改文件内容", async () => {
    const tsContent = ["export function foo() { return 1; }", "const x = foo();"].join("\n");
    const filePath = path.join(tmpDir, "rename-apply.ts");
    fs.writeFileSync(filePath, tsContent);
    const ci = new CodeIntelligence(tmpDir);
    const plan = await ci.planRename("foo", "bar", "rename-apply.ts");
    const result = await ci.applyRename(plan);
    expect(result.filesChanged).toBe(1);
    expect(result.occurrences).toBe(2);
    const newContent = fs.readFileSync(filePath, "utf-8");
    expect(newContent).toContain("function bar()");
    expect(newContent).toContain("x = bar()");
    expect(newContent).not.toContain("foo");
  });

  it("parseSymbols 应拒绝工作区外的路径（防路径越界）", async () => {
    // ../../etc/passwd 或绝对路径都应被拒绝
    const ci = new CodeIntelligence(tmpDir);
    await expect(ci.parseSymbols("../../etc/passwd")).rejects.toThrow(/Path escapes workspace/i);
    await expect(
      ci.parseSymbols("../../../windows/system32/config/sam"),
    ).rejects.toThrow(/Path escapes workspace/i);
  });

  it("findReferences 应拒绝工作区外的路径", async () => {
    const ci = new CodeIntelligence(tmpDir);
    await expect(ci.findReferences("foo", "../../etc/passwd")).rejects.toThrow(
      /Path escapes workspace/i,
    );
  });
});

// ── applyPatch ───────────────────────────────────────────────

describe("applyPatch", () => {
  it("parsePatch 应解析 SEARCH/REPLACE 块格式", () => {
    const patch = [
      "<<<<<<< SEARCH src/foo.ts",
      "old line 1",
      "old line 2",
      "=======",
      "new line 1",
      "new line 2",
      ">>>>>>> REPLACE",
    ].join("\n");
    const hunks = parsePatch(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].relativePath).toBe("src/foo.ts");
    expect(hunks[0].search).toBe("old line 1\nold line 2");
    expect(hunks[0].replace).toBe("new line 1\nnew line 2");
  });

  it("parsePatch 应解析 unified diff 格式", () => {
    const patch = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,2 +1,2 @@",
      " context line",
      "-old line",
      "+new line",
    ].join("\n");
    const hunks = parsePatch(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].relativePath).toBe("src/foo.ts");
    expect(hunks[0].search).toContain("old line");
    expect(hunks[0].replace).toContain("new line");
  });

  it("applyPatch 应应用单个 hunk", async () => {
    fs.writeFileSync(path.join(tmpDir, "single.ts"), "old content\nline 2");
    const result = await applyPatch(tmpDir, [
      { relativePath: "single.ts", search: "old content", replace: "new content" },
    ]);
    expect(result.success).toBe(true);
    expect(result.appliedHunks).toBe(1);
    expect(result.failedHunks).toBe(0);
    expect(fs.readFileSync(path.join(tmpDir, "single.ts"), "utf-8")).toBe("new content\nline 2");
  });

  it("applyPatch 应对同文件应用多个 hunk（累积修改）", async () => {
    fs.writeFileSync(path.join(tmpDir, "multi.ts"), "alpha\nbeta\ngamma");
    const result = await applyPatch(tmpDir, [
      { relativePath: "multi.ts", search: "alpha", replace: "ALPHA" },
      { relativePath: "multi.ts", search: "gamma", replace: "GAMMA" },
    ]);
    expect(result.success).toBe(true);
    expect(result.appliedHunks).toBe(2);
    expect(fs.readFileSync(path.join(tmpDir, "multi.ts"), "utf-8")).toBe("ALPHA\nbeta\nGAMMA");
  });

  it("applyPatch 应拦截路径逃逸（../../）", async () => {
    const result = await applyPatch(tmpDir, [
      { relativePath: "../../../etc/passwd", search: "x", replace: "y" },
    ]);
    expect(result.success).toBe(false);
    expect(result.failedHunks).toBe(1);
    expect(result.errors[0].reason).toContain("Path escape");
  });

  it("applyPatch 在 SEARCH 不存在时应给出相似行 hint", async () => {
    fs.writeFileSync(path.join(tmpDir, "hint.ts"), "function foo() {}\nfunction bar() {}");
    const result = await applyPatch(tmpDir, [
      { relativePath: "hint.ts", search: "function baz() {}", replace: "function qux() {}" },
    ]);
    expect(result.success).toBe(false);
    expect(result.failedHunks).toBe(1);
    expect(result.errors[0].reason).toContain("similar");
  });

  it("applyPatch 4-pass 匹配应支持行尾空白差异", async () => {
    // 文件中行尾有多余空格，search 不带空格 → Pass 2 (rstrip) 应命中
    fs.writeFileSync(path.join(tmpDir, "rstrip.ts"), "line one   \nline two");
    const result = await applyPatch(tmpDir, [
      { relativePath: "rstrip.ts", search: "line one", replace: "LINE ONE" },
    ]);
    expect(result.success).toBe(true);
    const newContent = fs.readFileSync(path.join(tmpDir, "rstrip.ts"), "utf-8");
    expect(newContent).toContain("LINE ONE");
  });

  it.skipIf(!SYMLINK_SUPPORTED)("applyPatch 应拦截 symlink 逃逸（symlink 指向 workspace 外）", async () => {
    const outsideFile = path.join(os.tmpdir(), `outside-target-${Date.now()}.txt`);
    fs.writeFileSync(outsideFile, "outside content");
    const symlinkPath = path.join(tmpDir, "link.ts");
    fs.symlinkSync(outsideFile, symlinkPath);
    try {
      const result = await applyPatch(tmpDir, [
        { relativePath: "link.ts", search: "outside", replace: "hacked" },
      ]);
      expect(result.success).toBe(false);
      // 原文件未被修改
      expect(fs.readFileSync(outsideFile, "utf-8")).toBe("outside content");
    } finally {
      fs.unlinkSync(outsideFile);
    }
  });
});
