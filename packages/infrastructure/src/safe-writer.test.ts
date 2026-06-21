import { describe, it, expect } from "vitest";
import { SafeWriter, getSafeStdout, getSafeStderr, installSafeIOHandlers } from "./safe-writer";

describe("SafeWriter", () => {
  it("应能创建 SafeWriter 实例", () => {
    const writer = new SafeWriter(process.stdout);
    expect(writer).toBeInstanceOf(SafeWriter);
  });

  it("write 应返回 boolean", () => {
    const writer = new SafeWriter(process.stdout);
    const result = writer.write("test\n");
    expect(typeof result).toBe("boolean");
  });

  it("getErrorCount 初始应为 0", () => {
    const writer = new SafeWriter(process.stdout);
    expect(writer.getErrorCount()).toBe(0);
  });

  it("reset 应重置错误计数", () => {
    const writer = new SafeWriter(process.stdout);
    writer.reset();
    expect(writer.getErrorCount()).toBe(0);
  });

  it("getSafeStdout 应返回单例", () => {
    const w1 = getSafeStdout();
    const w2 = getSafeStdout();
    expect(w1).toBe(w2);
  });

  it("getSafeStderr 应返回单例", () => {
    const w1 = getSafeStderr();
    const w2 = getSafeStderr();
    expect(w1).toBe(w2);
  });

  it("installSafeIOHandlers 不应抛出异常", () => {
    expect(() => installSafeIOHandlers()).not.toThrow();
  });

  it("写入已销毁的流应返回 false 而非抛出", () => {
    const mockStream = {
      write: () => { throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" }); },
      destroyed: false,
      writableEnded: false,
      on: () => {},
    } as any;
    const writer = new SafeWriter(mockStream);
    const result = writer.write("test");
    expect(result).toBe(false);
  });
});
