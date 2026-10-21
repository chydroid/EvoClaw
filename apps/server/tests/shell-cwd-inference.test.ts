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
import { inferCwdFromScript } from "../src/tools/shell-media-tools";

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
