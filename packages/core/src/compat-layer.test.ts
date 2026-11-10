import { describe, expect, it } from "vitest";
import { resolveRegisteredToolName } from "./compat-layer";

/**
 * 工具名别名修复（hermes turn_tool_validation 语义）。
 * 规则：原名已注册绝不改写；原名未注册且别名目标已注册才改写；否则原样返回。
 */
describe("resolveRegisteredToolName", () => {
  const registered = (...names: string[]) => (candidate: string) => names.includes(candidate);

  it("passes through when the original name is registered", () => {
    // 即使别名目标也存在，也不能改写模型明确调用的原名
    expect(resolveRegisteredToolName("write_file", registered("write_file", "file_write"))).toBe("write_file");
  });

  it("rewrites a legacy name to the registered alias target", () => {
    expect(resolveRegisteredToolName("write_file", registered("file_write"))).toBe("file_write");
    expect(resolveRegisteredToolName("read_file", registered("file_read"))).toBe("file_read");
    expect(resolveRegisteredToolName("send_mail", registered("email"))).toBe("email");
  });

  it("returns the original when neither name nor alias is registered", () => {
    expect(resolveRegisteredToolName("write_file", registered("shell_exec"))).toBe("write_file");
  });

  it("returns the original when no alias exists", () => {
    expect(resolveRegisteredToolName("my_custom_tool", registered("my_custom_tool2"))).toBe("my_custom_tool");
  });
});
