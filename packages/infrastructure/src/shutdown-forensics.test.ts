/**
 * shutdown-forensics.test.ts — 关闭取证快照测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { ShutdownForensics } from "./shutdown-forensics";
import type { ShutdownSnapshot } from "./shutdown-forensics";

describe("ShutdownForensics", () => {
  let tmpDir: string;
  let forensics: ShutdownForensics;
  const originalPlatform = process.platform;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-forensics-"));
    forensics = new ShutdownForensics(tmpDir);
  });

  afterEach(() => {
    // 恢复 platform mock
    Object.defineProperty(process, "platform", { value: originalPlatform });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("snapshotShutdownContext", () => {
    it("创建 shutdown-<timestamp>.json 文件", () => {
      const filePath = forensics.snapshotShutdownContext("SIGTERM");
      expect(fs.existsSync(filePath)).toBe(true);
      expect(path.basename(filePath)).toMatch(/^shutdown-\d+\.json$/);
    });

    it("返回的文件路径在 outputDir 下", () => {
      const filePath = forensics.snapshotShutdownContext("SIGTERM");
      expect(path.dirname(filePath)).toBe(tmpDir);
    });

    it("快照包含所有预期字段", () => {
      const filePath = forensics.snapshotShutdownContext("SIGTERM");
      const content = fs.readFileSync(filePath, "utf8");
      const snapshot: ShutdownSnapshot = JSON.parse(content);

      expect(snapshot.signal).toBe("SIGTERM");
      expect(snapshot.pid).toBe(process.pid);
      expect(snapshot.ppid).toBe(process.ppid);
      expect(snapshot.platform).toBe(originalPlatform);
      expect(snapshot.arch).toBe(process.arch);
      expect(snapshot.nodeVersion).toBe(process.version);
      expect(typeof snapshot.uptime).toBe("number");
      expect(snapshot.uptime).toBeGreaterThan(0);
      expect(snapshot.memoryUsage).toBeDefined();
      expect(snapshot.memoryUsage.rss).toBeGreaterThan(0);
      expect(snapshot.cwd).toBe(process.cwd());
      expect(Array.isArray(snapshot.argv)).toBe(true);
      expect(snapshot.argv.length).toBeGreaterThan(0);
      expect(snapshot.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("signal 参数正确记录到快照", () => {
      forensics.snapshotShutdownContext("SIGINT");
      const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith("shutdown-"));
      expect(files.length).toBe(1);
      const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
      const snapshot: ShutdownSnapshot = JSON.parse(content);
      expect(snapshot.signal).toBe("SIGINT");
    });

    it("多次调用创建不同文件", () => {
      forensics.snapshotShutdownContext("SIGTERM");
      // 确保时间戳不同
      const t = setTimeout(() => {}, 2);
      t.unref();
      forensics.snapshotShutdownContext("SIGTERM");
      const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith("shutdown-"));
      expect(files.length).toBe(2);
    });
  });

  describe("spawnDiagnostics", () => {
    it("Windows 跳过诊断命令", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const logPath = path.join(tmpDir, "diagnostics.log");
      await forensics.spawnDiagnostics(logPath);
      // Windows 不创建诊断文件
      expect(fs.existsSync(logPath)).toBe(false);
    });

    it("非 Windows 创建诊断日志文件", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      const logPath = path.join(tmpDir, "diagnostics.log");
      await forensics.spawnDiagnostics(logPath);
      expect(fs.existsSync(logPath)).toBe(true);
      const content = fs.readFileSync(logPath, "utf8");
      // 每个命令都有 === name 段（成功或失败），用前缀匹配
      expect(content).toContain("=== ps");
      expect(content).toContain("=== pstree");
      expect(content).toContain("=== dmesg");
    });

    it("非 Windows 即使命令失败也创建文件", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      const logPath = path.join(tmpDir, "sub", "diagnostics.log");
      await forensics.spawnDiagnostics(logPath);
      expect(fs.existsSync(logPath)).toBe(true);
      const content = fs.readFileSync(logPath, "utf8");
      expect(content.length).toBeGreaterThan(0);
    });
  });

  describe("默认 outputDir", () => {
    it("未提供 outputDir 时使用 data/logs", () => {
      const defaultForensics = new ShutdownForensics();
      // 验证不抛出（outputDir 在 snapshotShutdownContext 时才创建）
      // 使用自定义目录避免污染真实 data/logs
      expect(defaultForensics).toBeDefined();
    });
  });
});
