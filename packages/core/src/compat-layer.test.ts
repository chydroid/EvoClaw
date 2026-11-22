import { describe, expect, it } from "vitest";
import { applyImpliedToolAction, resolveRegisteredToolName } from "./compat-layer";

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

  it("resolves file_* legacy names to file_write (v26 T7 R5)", () => {
    expect(resolveRegisteredToolName("file_edit", registered("file_write"))).toBe("file_write");
    expect(resolveRegisteredToolName("file_create", registered("file_write"))).toBe("file_write");
    expect(resolveRegisteredToolName("file_modify", registered("file_write"))).toBe("file_write");
    expect(resolveRegisteredToolName("edit_file", registered("file_write"))).toBe("file_write");
  });
});

/**
 * 旧名改名后补齐 file_write 合并后必填的 action（v26 T7 实证）。
 */
describe("applyImpliedToolAction", () => {
  it("fills the implied action for legacy names", () => {
    expect(applyImpliedToolAction("write_file", "file_write", { path: "a" }).action).toBe("create");
    expect(applyImpliedToolAction("edit_file", "file_write", { path: "a" }).action).toBe("edit");
    expect(applyImpliedToolAction("file_create", "file_write", { path: "a" }).action).toBe("create");
    expect(applyImpliedToolAction("file_modify", "file_write", { path: "a" }).action).toBe("modify");
    expect(applyImpliedToolAction("file_edit", "file_write", { path: "a" }).action).toBe("edit");
  });

  it("never overrides an explicit action", () => {
    const args = { path: "a", action: "modify" };
    expect(applyImpliedToolAction("write_file", "file_write", args)).toBe(args);
  });

  it("infers edit when old_string/new_string are present", () => {
    expect(applyImpliedToolAction("write_file", "file_write", { path: "a", old_string: "x" }).action).toBe("edit");
  });

  it("leaves non-file_write targets and unknown names untouched", () => {
    const args = { path: "a" };
    expect(applyImpliedToolAction("write_file", "file_read", args)).toBe(args);
    expect(applyImpliedToolAction("my_tool", "file_write", args)).toBe(args);
  });
});
