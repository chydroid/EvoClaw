import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { findExecutable, commandExists } from "./command-exists";

describe("commandExists — 健壮的命令探测", () => {
  // 真实事故（2026-10-07）：用户装好 mineru-open-api 后，技能仍报
  // "Required binary is not found in PATH"，且「一键安装缺失工具」无反应。
  // 根因：旧实现只 execFileSync("where", [bin])，而这条路径在真实环境里
  // 对**任何**二进制都失败（含确定已安装的 node/python），因为
  // ① spawnSync where EBUSY（WorkBuddy shim 目录）
  // ② process.env.PATH 畸形（出现裸 `C` 段、截断条目）
  // ③ npm/pip 全局目录（%APPDATA%\npm 等）根本不在 PATH 里

  it("★ 必须能认出当前进程可用的运行时（node）", () => {
    // 用进程自身可执行文件做基准：它一定存在
    const self = findExecutable(process.execPath);
    expect(self, "process.execPath 应当能被解析出来").toBeTruthy();
  });

  it("★ 传入绝对路径且文件存在时直接命中", () => {
    const resolved = findExecutable(process.execPath);
    expect(resolved).toBeTruthy();
    expect(fs.statSync(resolved!).isFile()).toBe(true);
  });

  it("不存在的命令必须返回 null（不能误报为已安装）", () => {
    expect(findExecutable("definitely-not-a-real-binary-xyz-123")).toBeNull();
    expect(commandExists("definitely-not-a-real-binary-xyz-123")).toBe(false);
  });

  it("空字符串 / 空白输入安全返回 null", () => {
    expect(findExecutable("")).toBeNull();
    expect(findExecutable("   ")).toBeNull();
  });

  it("★ 畸形 PATH 条目不得导致崩溃或误判", () => {
    // PATH 中确实存在裸驱动器段（`C`）与截断条目，探测必须容忍
    const original = process.env.PATH;
    try {
      process.env.PATH = ["C", "", "  ", '"D:\\does\\not\\exist"', ...(original ? [original] : [])].join(path.delimiter);
      // 不崩溃 + 不误报
      expect(() => findExecutable("definitely-not-a-real-binary-xyz-123")).not.toThrow();
      expect(findExecutable("definitely-not-a-real-binary-xyz-123")).toBeNull();
    } finally {
      process.env.PATH = original;
    }
  });

  it("PATH 为空时仍不抛异常", () => {
    const original = process.env.PATH;
    try {
      process.env.PATH = "";
      expect(() => findExecutable("some-binary")).not.toThrow();
    } finally {
      process.env.PATH = original;
    }
  });

  it("commandExists 是 findExecutable 的布尔包装", () => {
    const p = process.execPath;
    expect(commandExists(p)).toBe(true);
  });
});