import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  getWorkspaceDir,
  setWorkspaceDir,
  clearWorkspaceOverride,
  peekWorkspaceOverride,
} from "./workspace-path";

describe("workspace-path", () => {
  let tmpRoot: string;
  const envBackup: string | undefined = process.env.EvoClaw_WORKSPACE;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-wspath-"));
    delete process.env.EvoClaw_WORKSPACE;
    clearWorkspaceOverride();
  });

  afterEach(() => {
    // 清理 override + tmp 目录
    clearWorkspaceOverride();
    if (envBackup !== undefined) {
      process.env.EvoClaw_WORKSPACE = envBackup;
    } else {
      delete process.env.EvoClaw_WORKSPACE;
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  describe("默认路径解析", () => {
    it("未设 env 也未 override 时返回 process.cwd()/data/workspace", () => {
      const dir = getWorkspaceDir();
      expect(dir).toBe(path.resolve(process.cwd(), "data", "workspace"));
    });

    it("EvoClaw_WORKSPACE env 存在时优先", () => {
      const custom = path.join(tmpRoot, "env-workspace");
      process.env.EvoClaw_WORKSPACE = custom;
      const dir = getWorkspaceDir();
      expect(dir).toBe(custom);
      // 自动 mkdir
      expect(fs.existsSync(custom)).toBe(true);
    });

    it("env 优先于 default 但低于运行时 override", () => {
      const envDir = path.join(tmpRoot, "env");
      const overrideDir = path.join(tmpRoot, "override");
      process.env.EvoClaw_WORKSPACE = envDir;
      clearWorkspaceOverride();
      // 第一次：env
      expect(getWorkspaceDir()).toBe(envDir);
      // 第二次：override 覆盖 env
      const resolved = setWorkspaceDir(overrideDir);
      expect(resolved).toBe(overrideDir);
      expect(getWorkspaceDir()).toBe(overrideDir);
    });
  });

  describe("运行时 override", () => {
    it("setWorkspaceDir 自动创建目录", () => {
      const target = path.join(tmpRoot, "deeply", "nested", "ws");
      expect(fs.existsSync(target)).toBe(false);
      const resolved = setWorkspaceDir(target);
      expect(resolved).toBe(target);
      expect(fs.existsSync(target)).toBe(true);
      expect(peekWorkspaceOverride()).toBe(target);
    });

    it("clearWorkspaceOverride 回到 env 语义", () => {
      const envDir = path.join(tmpRoot, "env");
      process.env.EvoClaw_WORKSPACE = envDir;
      const overrideDir = path.join(tmpRoot, "override");
      setWorkspaceDir(overrideDir);
      expect(peekWorkspaceOverride()).toBe(overrideDir);
      clearWorkspaceOverride();
      expect(peekWorkspaceOverride()).toBeNull();
      expect(getWorkspaceDir()).toBe(envDir);
    });

    it("clearWorkspaceOverride 后未设 env 时回到默认 data/workspace", () => {
      const overrideDir = path.join(tmpRoot, "override");
      // 没有 env
      delete process.env.EvoClaw_WORKSPACE;
      setWorkspaceDir(overrideDir);
      expect(getWorkspaceDir()).toBe(overrideDir);
      clearWorkspaceOverride();
      expect(getWorkspaceDir()).toBe(
        path.resolve(process.cwd(), "data", "workspace"),
      );
    });

    it("setWorkspacePath 接受相对路径并 resolve 为绝对路径", () => {
      // Node 相对路径 - "cwd/data/workspace"
      const relative = "some/relative/ws";
      const resolved = setWorkspaceDir(relative);
      expect(resolved).toBe(path.resolve(relative));
      expect(fs.existsSync(resolved)).toBe(true);
      // reset
      clearWorkspaceOverride();
    });
  });

  describe("getWorkspaceDir 多次调用一致性", () => {
    it("多次调用返回同一值（忽略 env 改动）", () => {
      // 如果没有 override，getWorkspaceDir 每次都重新读 env。这里验证：
      const d1 = getWorkspaceDir();
      // 设置 override 后再次调用
      setWorkspaceDir(path.join(tmpRoot, "ws"));
      expect(getWorkspaceDir()).toBe(path.join(tmpRoot, "ws"));
      // 还原：再调用返回 override 值（不重算 env）
      expect(getWorkspaceDir()).toBe(path.join(tmpRoot, "ws"));
      // 才能回到 default
      clearWorkspaceOverride();
      expect(getWorkspaceDir()).toBe(d1);
    });
  });
});
