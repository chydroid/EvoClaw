import { describe, it, expect } from "vitest";
import {
  ToolResultMiddleware,
  createRedactionTransform,
  type ToolResultContext,
} from "./tool-result-middleware";

function makeCtx(result: unknown): ToolResultContext {
  return {
    toolName: "shell_exec",
    toolCallId: "call-1",
    sessionId: "s1",
    turnId: "1",
    args: {},
    result,
    durationMs: 1,
    success: true,
  };
}

/**
 * transformResult 是主执行链（llm-caller 工具结果路径）实际调用的入口：
 * 不包装执行，只对进入模型上下文的字符串结果做脱敏。
 */
describe("ToolResultMiddleware.transformResult", () => {
  it("应用脱敏转换并统计真实转换次数", () => {
    const mw = new ToolResultMiddleware();
    mw.addResultTransform(
      createRedactionTransform([{ pattern: /sk-[A-Za-z0-9]+/g, replacement: "[REDACTED]" }]),
    );

    const transformed = mw.transformResult(makeCtx("key=sk-abc123 done"));

    expect(transformed.result).toBe("key=[REDACTED] done");
    const stats = mw.getStats();
    expect(stats.resultTransformApplications).toBe(1);
    expect(stats.transformedResults).toBe(1);
  });

  it("未命中内容不计入 transformedResults", () => {
    const mw = new ToolResultMiddleware();
    mw.addResultTransform(
      createRedactionTransform([{ pattern: /sk-[A-Za-z0-9]+/g, replacement: "[REDACTED]" }]),
    );

    const transformed = mw.transformResult(makeCtx("nothing sensitive here"));

    expect(transformed.result).toBe("nothing sensitive here");
    expect(mw.getStats().resultTransformApplications).toBe(1);
    expect(mw.getStats().transformedResults).toBe(0);
  });

  it("禁用结果转换时原样返回", () => {
    const mw = new ToolResultMiddleware({ enableResultTransform: false });
    mw.addResultTransform(createRedactionTransform([{ pattern: /x/g, replacement: "y" }]));

    const ctx = makeCtx("xxx");
    expect(mw.transformResult(ctx)).toBe(ctx);
    expect(mw.getStats().transformedResults).toBe(0);
  });
});
