import { describe, it, expect } from "vitest";
import { loadErrorCopy } from "./load-error-copy";

describe("loadErrorCopy", () => {
  it("生成标题并填入加载对象名称", () => {
    const c = loadErrorCopy("LLM 提供商");
    expect(c.title).toBe("加载LLM 提供商失败");
    expect(c.details).toBeNull();
  });

  it("失败细节非空时拼接原因", () => {
    const c = loadErrorCopy("会话列表", "HTTP 503");
    expect(c.title).toBe("加载会话列表失败");
    expect(c.details).toBe("原因: HTTP 503");
  });

  it("空字符串细节与 null 等价，不生成 details", () => {
    expect(loadErrorCopy("技能", null).details).toBeNull();
    expect(loadErrorCopy("技能", "").details).toBeNull();
  });

  it("what 为空时回退为「数据」", () => {
    expect(loadErrorCopy("").title).toBe("加载数据失败");
  });
});