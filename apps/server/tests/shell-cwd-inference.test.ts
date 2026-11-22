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
import { inferCwdFromScript, resolveShellCwd } from "../src/tools/shell-media-tools";

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
