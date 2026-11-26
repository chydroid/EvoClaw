/**
 * shell_exec cwd 推断回归测试（2026-10-20 eval15 t05 事故）
 *
 * 验证 inferCwdFromScript：当模型未传 cwd 且命令执行位于 workspace 子目录的脚本时，
 * 应推断 cwd 为脚本所在目录，而非默认的 workspace 根（否则脚本内部相对路径
 * 落到 workspace 根，验收找不到文件）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { inferCwdFromScript, resolveShellCwd, collapseWorkspaceRootAlias, inferCodeLanguage } from "../src/tools/shell-media-tools";

const workspaceDir = path.resolve(__dirname, "..", "..", "..", "data", "workspace");
const evalDir = path.join(workspaceDir, "eval15", "t05-cwd");
const scriptPath = path.join(evalDir, "build.sh");

describe("inferCwdFromScript", () => {
  beforeAll(() => {
    fs.mkdirSync(evalDir, { recursive: true });
    fs.writeFileSync(scriptPath, "#!/bin/bash\necho hi\n", { mode: 0o755 });
  });
  afterAll(() => {
    fs.rmSync(evalDir, { recursive: true, force: true });
  });

  it("命令为 bash <workspace-relative script> 时推断 cwd 为脚本目录", () => {
    const result = inferCwdFromScript("bash eval15/t05-cwd/build.sh", workspaceDir);
    expect(result).toBe(evalDir);
  });

  it("命令为 python <workspace-relative script> 时推断 cwd 为脚本目录", () => {
    const py = path.join(evalDir, "run.py");
    fs.writeFileSync(py, "# placeholder\n");
    const result = inferCwdFromScript("python eval15/t05-cwd/run.py", workspaceDir);
    expect(result).toBe(evalDir);
    fs.rmSync(py, { force: true });
  });

  it("未显式 cwd + 脚本不存在时返回 null（维持默认 cwd）", () => {
    const result = inferCwdFromScript("bash eval15/t05-cwd/nope.sh", workspaceDir);
    expect(result).toBeNull();
  });

  it("命令里没脚本路径时返回 null", () => {
    expect(inferCwdFromScript("echo hello", workspaceDir)).toBeNull();
    expect(inferCwdFromScript("ls -la", workspaceDir)).toBeNull();
  });

  it("脚本为绝对路径时不推断（交给安全校验处理)", () => {
    expect(inferCwdFromScript(`bash ${scriptPath}`, workspaceDir)).toBeNull();
  });
});

describe("resolveShellCwd — 显式 cwd 缺失必须拒绝执行", () => {
  const explicitDir = path.join(workspaceDir, "eval15", "t05-explicit-cwd");
  beforeAll(() => {
    fs.mkdirSync(explicitDir, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(explicitDir, { recursive: true, force: true });
  });

  it("显式 cwd 存在 → 使用该目录", () => {
    const result = resolveShellCwd(explicitDir, "echo hi", workspaceDir);
    expect(result).toEqual({ cwd: explicitDir });
  });

  it("相对 cwd 优先按 workspace 根解析（模型不写绝对路径也能进子目录）", () => {
    const result = resolveShellCwd("eval15/t05-explicit-cwd", "echo hi", workspaceDir);
    expect(result).toEqual({ cwd: explicitDir });
  });

  it("显式 cwd 不存在 → exitCode 126 且命令不执行（不静默回退）", () => {
    const missing = path.join(workspaceDir, "eval15", "definitely-missing-dir");
    const result = resolveShellCwd(missing, "touch out.txt", workspaceDir);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.exitCode).toBe(126);
      expect(result.error).toContain("did not run");
      expect(result.error).toContain(missing);
    }
  });

  it("未显式 cwd 且默认目录缺失 → 回退 workspace（保持原行为）", () => {
    // inferCwdFromScript 返回 null → 走默认 workspace；workspace 本身存在
    const result = resolveShellCwd(null, "echo hi", workspaceDir);
    expect(result).toEqual({ cwd: workspaceDir });
  });

  it("显式 cwd 逃逸出 workspace → 拒绝", () => {
    const result = resolveShellCwd("/tmp", "echo hi", workspaceDir);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("within workspace");
  });
});

describe("collapseWorkspaceRootAlias — workspace 根别名确定性折叠", () => {
  const wsRoot = path.join(workspaceDir, "eval15", "alias-probe");

  beforeAll(() => {
    fs.mkdirSync(wsRoot, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  it("★ cwd = workspace 根：同一命令内「先 mkdir 后写入」两处前缀都被折叠", () => {
    // footer-probe 事故：存在性门禁在 spawn 前求值，mkdir 出来的目录看不到，
    // 导致一条命令被劈成两个路径基准（产物写进 data/workspace/data/workspace/…）。
    const cmd = "mkdir -p data/workspace/probe && echo hi > data/workspace/probe/hello.txt && ls data/workspace/probe";
    const out = collapseWorkspaceRootAlias(cmd, wsRoot, wsRoot);
    expect(out).not.toContain("data/workspace/");
    expect(out).toContain("mkdir -p probe");
    expect(out).toContain("> probe/hello.txt");
    expect(out).toContain("ls probe");
  });

  it("★ cwd = workspace 根：反斜杠写法同样折叠", () => {
    const out = collapseWorkspaceRootAlias("cat data\\workspace\\a.txt", wsRoot, wsRoot);
    expect(out).toBe("cat a.txt");
  });

  it("cwd 为子目录且目标与其父目录都不存在 → 保留原样（不猜测）", () => {
    const sub = path.join(wsRoot, "sub");
    fs.mkdirSync(sub, { recursive: true });
    const out = collapseWorkspaceRootAlias("cat data/workspace/missing-dir/file.txt", sub, wsRoot);
    expect(out).toContain("data/workspace/");
  });

  it("绝对路径永不匹配（前置 / 由 lookbehind 排除）", () => {
    const out = collapseWorkspaceRootAlias(`cat ${wsRoot}/data/workspace/a.txt`, wsRoot, wsRoot);
    expect(out).toContain("/data/workspace/a.txt");
  });

  it("cwd 非 workspace 根且目标存在 → 仍按旧门禁折叠", () => {
    const sub = path.join(wsRoot, "sub2");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(wsRoot, "there.txt"), "x", "utf-8");
    const out = collapseWorkspaceRootAlias("cat data/workspace/there.txt", sub, wsRoot);
    expect(out).toBe("cat there.txt");
  });
});

/**
 * execute_code 语言推断（2026-11-26 会话取证）。
 *
 * 事故：`language` 省略时旧实现一律按 node 跑，9 次缺 language 的调用里
 * 4 次是 Python（`from pathlib import Path` → `SyntaxError: Unexpected
 * identifier 'pathlib'`、`print(...)` → `ReferenceError: print is not
 * defined`），整轮报废。hermes 的 execute_code 永远 Python 没有这层歧义。
 */
describe("inferCodeLanguage — 省略 language 时按代码形状判定", () => {
  it("Python 独占语法 → python", () => {
    expect(inferCodeLanguage("from pathlib import Path\np = Path('x')")).toBe("python");
    expect(inferCodeLanguage("import json\ndata = json.loads('{}')")).toBe("python");
    expect(inferCodeLanguage("def fnv1(s):\n    h = 2166136261\n    return h")).toBe("python");
    expect(inferCodeLanguage("print(0x84 & 0x7F)")).toBe("python");
    expect(inferCodeLanguage("class Foo:\n    pass")).toBe("python");
    expect(inferCodeLanguage("if __name__ == '__main__':\n    main()")).toBe("python");
  });

  it("Node 语法 → node（含只有 Node 信号的混合）", () => {
    expect(inferCodeLanguage("const x = 1;\nconsole.log(x);")).toBe("node");
    expect(inferCodeLanguage("function f(a) { return a; }\nf(1);")).toBe("node");
    expect(inferCodeLanguage("const fs = require('fs');")).toBe("node");
    expect(inferCodeLanguage("import fs from 'node:fs';")).toBe("node");
    expect(inferCodeLanguage("module.exports = { a: 1 };")).toBe("node");
  });

  it("判不出来 → 保持 node 旧默认（不因形状模糊就换解释器）", () => {
    expect(inferCodeLanguage("")).toBe("node");
    expect(inferCodeLanguage("42")).toBe("node");
    expect(inferCodeLanguage("x + y")).toBe("node");
  });

  it("Python 信号多于 Node 信号 → python（FNV 压测里的混合片段）", () => {
    const src = "def fnv1a(s):\n    h = 2166136261\n    for b in s.encode():\n        h = h ^ b\n    return h\nprint(fnv1a(''))";
    expect(inferCodeLanguage(src)).toBe("python");
  });
});
