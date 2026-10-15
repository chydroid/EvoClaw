/**
 * Code Analyzer 插件回归（2026-10-15 评测事故）：
 * 旧实现把「分析报告」经 before_tool_call 内联写进 file_create 的 content 参数——
 * JS/TS 文件被 C 风格注释头污染后 SyntaxError 无法运行，模型绕 5+ 轮仍失败。
 * 新行为：磁盘文件保持模型写入的原始字节；报告作为 codeAnalysis 字段随
 * after_tool_call 的 tool_result 下发。
 */
import { describe, it, expect } from "vitest";
import { createCodeAnalyzerPlugin, scanCode } from "./code-analyzer.plugin";
import type { AfterToolCallHook } from "@evoclaw/core";

const JS_WITH_ISSUES = `function add(a, b) {
  return a + b;
}
console.log("debug");
`;

describe("code-analyzer 插件（报告不再污染磁盘文件）", () => {
  const plugin = createCodeAnalyzerPlugin();

  it("不再有 before_tool_call 钩子（旧内联报告路径已移除）", () => {
    const before = plugin.hooks.filter((h) => h.hookType === "before_tool_call");
    expect(before).toHaveLength(0);
  });

  it("after_tool_call 命中 issue 时把报告放进 result.codeAnalysis，不改工具参数", async () => {
    const hook = plugin.hooks.find((h) => h.hookType === "after_tool_call")!;
    expect(hook).toBeDefined();
    const result = await (hook.handler as (h: AfterToolCallHook) => Promise<{ result?: unknown }>)({
      type: "after_tool_call",
      context: { sessionId: "s1", agentId: "default", channel: "webchat" },
      toolName: "file_create",
      params: { path: "x.js", content: JS_WITH_ISSUES },
      result: { path: "/ws/x.js", size: 44, created: true },
      errored: false,
    });
    const merged = result as { result: Record<string, unknown> };
    // 原工具结果保留
    expect(merged.result.path).toBe("/ws/x.js");
    // 报告随结果下发
    expect(String(merged.result.codeAnalysis)).toContain("Code Analyzer Report");
  });

  it("无 issue 的代码不打扰（返回空）", async () => {
    const hook = plugin.hooks.find((h) => h.hookType === "after_tool_call")!;
    const clean = `const x = 1;\nexport { x };\n`;
    const result = await (hook.handler as (h: AfterToolCallHook) => Promise<Record<string, unknown>>)(
      {
        type: "after_tool_call",
        context: { sessionId: "s1", agentId: "default", channel: "webchat" },
        toolName: "file_create",
        params: { path: "x.ts", content: clean },
        result: { path: "/ws/x.ts", size: clean.length, created: true },
        errored: false,
      } as unknown as AfterToolCallHook
    );
    expect(result).toEqual({});
  });

  it("工具失败（errored）时不附报告", async () => {
    const hook = plugin.hooks.find((h) => h.hookType === "after_tool_call")!;
    const result = await (hook.handler as (h: AfterToolCallHook) => Promise<Record<string, unknown>>)(
      {
        type: "after_tool_call",
        context: { sessionId: "s1", agentId: "default", channel: "webchat" },
        toolName: "file_create",
        params: { path: "x.js", content: JS_WITH_ISSUES },
        result: null,
        errored: true,
        error: "write failed",
      } as unknown as AfterToolCallHook
    );
    expect(result).toEqual({});
  });

  it("非代码扩展名不扫描", async () => {
    const hook = plugin.hooks.find((h) => h.hookType === "after_tool_call")!;
    const result = await (hook.handler as (h: AfterToolCallHook) => Promise<Record<string, unknown>>)(
      {
        type: "after_tool_call",
        context: { sessionId: "s1", agentId: "default", channel: "webchat" },
        toolName: "file_create",
        params: { path: "notes.md", content: "## TODO fix things later please ok ok ok" },
        result: { path: "/ws/notes.md", size: 40, created: true },
        errored: false,
      } as unknown as AfterToolCallHook
    );
    expect(result).toEqual({});
  });

  it("scanCode 保持导出可用（CLI 面不破坏）", () => {
    const issues = scanCode("var x = 1;\n");
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].category).toBe("quality");
  });
});
