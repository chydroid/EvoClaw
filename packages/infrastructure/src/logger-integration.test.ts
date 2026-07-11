/**
 * logger-integration.test.ts — Logger 与 RotatingFileAppender 集成测试
 *
 * 验证：
 * - setupFileLogging 创建 3 个文件
 * - agent.log 包含 INFO+ 所有级别
 * - errors.log 仅包含 WARN+
 * - gateway.log 仅包含 gateway 子系统
 * - sessionContext 注入到日志行
 * - clearSessionContext 清除注入
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { Logger } from "./logger";

describe("Logger 文件日志集成", () => {
  let tmpDir: string;
  let logger: Logger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-log-"));
    logger = new Logger({
      minLevel: "trace",
      prettyPrint: false,
      outputStream: () => {
        // 抑制控制台输出
      },
    });
  });

  afterEach(() => {
    logger.closeFileAppenders();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readLog(name: string): string {
    return fs.readFileSync(path.join(tmpDir, name), "utf8");
  }

  describe("setupFileLogging 创建文件", () => {
    it("创建 3 个日志文件", () => {
      logger.setupFileLogging({ logDir: tmpDir });
      // sync 模式下文件在首次写入时创建，写入适当级别触发各文件创建
      logger.info("gateway", "creates agent.log + gateway.log");
      logger.warn("test", "creates errors.log");
      logger.closeFileAppenders();
      expect(fs.existsSync(path.join(tmpDir, "agent.log"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "errors.log"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "gateway.log"))).toBe(true);
    });

    it("profile 感知：日志写到 logDir/profile 子目录", () => {
      logger.setupFileLogging({ logDir: tmpDir, profile: "prod" });
      logger.info("gateway", "trigger file creation");
      logger.warn("test", "trigger errors.log");
      logger.closeFileAppenders();
      expect(fs.existsSync(path.join(tmpDir, "prod", "agent.log"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "prod", "errors.log"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "prod", "gateway.log"))).toBe(true);
    });
  });

  describe("agent.log 级别过滤", () => {
    it("包含 INFO+ 所有级别，排除 trace/debug", () => {
      logger.setupFileLogging({ logDir: tmpDir });
      logger.trace("test", "trace msg");
      logger.debug("test", "debug msg");
      logger.info("test", "info msg");
      logger.warn("test", "warn msg");
      logger.error("test", "error msg");
      logger.fatal("test", "fatal msg");
      logger.closeFileAppenders();

      const content = readLog("agent.log");
      expect(content).toContain("info msg");
      expect(content).toContain("warn msg");
      expect(content).toContain("error msg");
      expect(content).toContain("fatal msg");
      expect(content).not.toContain("trace msg");
      expect(content).not.toContain("debug msg");
    });
  });

  describe("errors.log 级别过滤", () => {
    it("仅包含 WARN+，排除 trace/debug/info", () => {
      logger.setupFileLogging({ logDir: tmpDir });
      logger.trace("test", "trace msg");
      logger.debug("test", "debug msg");
      logger.info("test", "info msg");
      logger.warn("test", "warn msg");
      logger.error("test", "error msg");
      logger.fatal("test", "fatal msg");
      logger.closeFileAppenders();

      const content = readLog("errors.log");
      expect(content).toContain("warn msg");
      expect(content).toContain("error msg");
      expect(content).toContain("fatal msg");
      expect(content).not.toContain("trace msg");
      expect(content).not.toContain("debug msg");
      expect(content).not.toContain("info msg");
    });
  });

  describe("gateway.log 子系统过滤", () => {
    it("仅包含 gateway 子系统日志", () => {
      logger.setupFileLogging({ logDir: tmpDir });
      logger.info("server", "server msg");
      logger.info("gateway", "gateway msg");
      logger.info("gateway:weixin", "gateway weixin msg");
      logger.info("agent", "agent msg");
      logger.closeFileAppenders();

      const content = readLog("gateway.log");
      expect(content).toContain("gateway msg");
      expect(content).toContain("gateway weixin msg");
      expect(content).not.toContain("server msg");
      expect(content).not.toContain("agent msg");
    });

    it("gateway.log 也遵守 INFO+ 级别过滤", () => {
      logger.setupFileLogging({ logDir: tmpDir });
      logger.debug("gateway", "gateway debug msg");
      logger.info("gateway", "gateway info msg");
      logger.closeFileAppenders();

      const content = readLog("gateway.log");
      expect(content).not.toContain("gateway debug msg");
      expect(content).toContain("gateway info msg");
    });
  });

  describe("sessionContext 注入", () => {
    it("sessionId 通过 setupFileLogging 注入到日志行", () => {
      const sessionId = "sess-abc-123";
      logger.setupFileLogging({ logDir: tmpDir, sessionId });
      logger.info("test", "hello session");
      logger.closeFileAppenders();

      const content = readLog("agent.log");
      expect(content).toContain(`[${sessionId}]`);
      expect(content).toContain("hello session");
    });

    it("setSessionContext 动态设置 sessionId", () => {
      logger.setupFileLogging({ logDir: tmpDir });
      logger.setSessionContext("sess-dynamic");
      logger.info("test", "with session");
      logger.closeFileAppenders();

      const content = readLog("agent.log");
      expect(content).toContain("[sess-dynamic]");
    });

    it("clearSessionContext 清除注入", () => {
      logger.setupFileLogging({ logDir: tmpDir, sessionId: "sess-1" });
      logger.info("test", "with session");
      logger.clearSessionContext();
      logger.info("test", "without session");
      logger.closeFileAppenders();

      const lines = readLog("agent.log").split("\n").filter((l) => l.length > 0);
      const withLine = lines.find((l) => l.includes("with session"));
      const withoutLine = lines.find((l) => l.includes("without session"));
      expect(withLine).toBeDefined();
      expect(withoutLine).toBeDefined();
      expect(withLine!).toContain("[sess-1]");
      expect(withoutLine!).not.toContain("[sess-1]");
    });

    it("未设置 sessionId 时日志行不含 session 段", () => {
      logger.setupFileLogging({ logDir: tmpDir });
      logger.info("test", "no session msg");
      logger.closeFileAppenders();

      const content = readLog("agent.log");
      const line = content.split("\n").find((l) => l.includes("no session msg"));
      expect(line).toBeDefined();
      // 格式应为 [timestamp] [INFO] [test] no session msg
      expect(line!).toMatch(/\[INFO\] \[test\]/);
    });
  });

  describe("日志行格式", () => {
    it("文件日志行格式为 [timestamp] [LEVEL] [session] [subsystem] message", () => {
      logger.setupFileLogging({ logDir: tmpDir, sessionId: "s1" });
      logger.info("gateway", "format test");
      logger.closeFileAppenders();

      const content = readLog("agent.log");
      const line = content.split("\n").find((l) => l.includes("format test"));
      expect(line).toBeDefined();
      // [timestamp] [INFO] [s1] [gateway] format test
      expect(line!).toMatch(/^\[.+?\] \[INFO\] \[s1\] \[gateway\] format test/);
    });
  });
});
