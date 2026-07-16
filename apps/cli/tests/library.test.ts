import { describe, it, expect } from "vitest";
import {
  applyTemplate,
  PortInUseError,
  ensurePortAvailable,
  runExec,
  ensureBinary,
  waitForever,
} from "../src/library";

describe("Library mode (library.ts)", () => {
  describe("applyTemplate", () => {
    it("替换 {{var}} 占位符", () => {
      expect(applyTemplate("Hello {{name}}!", { name: "world" })).toBe("Hello world!");
    });

    it("缺失变量替换为空字符串", () => {
      expect(applyTemplate("a={{a}},b={{b}}", { a: "1" })).toBe("a=1,b=");
    });

    it("支持数字值", () => {
      expect(applyTemplate("n={{n}}", { n: 42 })).toBe("n=42");
    });

    it("null 视为空字符串", () => {
      expect(applyTemplate("v={{v}}", { v: null })).toBe("v=");
    });

    it("无占位符时原样返回", () => {
      expect(applyTemplate("plain text", {})).toBe("plain text");
    });
  });

  describe("PortInUseError", () => {
    it("携带 port 字段", () => {
      const err = new PortInUseError(27788);
      expect(err.port).toBe(27788);
      expect(err.message).toContain("27788");
      expect(err.name).toBe("PortInUseError");
      expect(err instanceof Error).toBe(true);
    });

    it("允许自定义消息", () => {
      const err = new PortInUseError(8080, "custom");
      expect(err.message).toBe("custom");
      expect(err.port).toBe(8080);
    });
  });

  describe("ensurePortAvailable", () => {
    it("空闲端口应 resolve", async () => {
      // 选取一个空闲端口：监听 0 让系统分配
      const net = await import("node:net");
      const probe = net.createServer();
      const port: number = await new Promise((resolve) => {
        probe.once("listening", () => {
          const addr = probe.address();
          resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
        probe.listen(0);
      });
      probe.close();
      // 关闭后端口应可用
      await expect(ensurePortAvailable(port)).resolves.toBeUndefined();
    });

    it("占用端口应抛 PortInUseError", async () => {
      const net = await import("node:net");
      const holder = net.createServer();
      const port: number = await new Promise((resolve) => {
        holder.once("listening", () => {
          const addr = holder.address();
          resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
        holder.listen(0);
      });
      try {
        await expect(ensurePortAvailable(port)).rejects.toBeInstanceOf(PortInUseError);
      } finally {
        holder.close();
      }
    });
  });

  describe("runExec", () => {
    it("返回 stdout 字符串", () => {
      const out = runExec(process.platform === "win32" ? "cmd" : "echo", process.platform === "win32" ? ["/c", "echo", "hi"] : ["hi"]);
      expect(out.trim()).toBe("hi");
    });
  });

  describe("ensureBinary", () => {
    it("node 二进制必定可用", async () => {
      await expect(ensureBinary("node")).resolves.toBe(true);
    });

    it("不存在的二进制返回 false", async () => {
      await expect(ensureBinary("evoclaw-nonexistent-bin-xyz-12345")).resolves.toBe(false);
    });
  });

  describe("waitForever", () => {
    it("返回一个未 resolve 的 Promise", () => {
      const p = waitForever();
      expect(p).toBeInstanceOf(Promise);
      // 不 await，避免阻塞测试
    });
  });
});
