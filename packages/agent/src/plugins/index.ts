export { createMemoryEnhancerPlugin } from "./memory-enhancer.plugin";
export { createCodeAnalyzerPlugin } from "./code-analyzer.plugin";
export { createWebBrowserPlugin } from "./web-browser.plugin";
export { createSystemLoggerPlugin } from "./system-logger.plugin";
export { createCostTrackerPlugin, getCostSummary, getSessionCost } from "./cost-tracker.plugin";
export { createResponseValidatorPlugin } from "./response-validator.plugin";
export { createConversationSummarizerPlugin } from "./conversation-summarizer.plugin";
export { createClaudeCodeToolsPlugin } from "./claude-code.plugin";
export { createMarkItDownPlugin } from "./markitdown.plugin";
export { createEnhancedBrowserPlugin } from "./enhanced-browser.plugin";

import type { Plugin } from "@evoclaw/core";
import { createMemoryEnhancerPlugin } from "./memory-enhancer.plugin";
import { createCodeAnalyzerPlugin } from "./code-analyzer.plugin";
import { createSystemLoggerPlugin } from "./system-logger.plugin";
import { createCostTrackerPlugin } from "./cost-tracker.plugin";
import { createResponseValidatorPlugin } from "./response-validator.plugin";
import { createConversationSummarizerPlugin } from "./conversation-summarizer.plugin";
import { createClaudeCodeToolsPlugin } from "./claude-code.plugin";
import { createMarkItDownPlugin } from "./markitdown.plugin";
import { createEnhancedBrowserPlugin } from "./enhanced-browser.plugin";

// ★ 2026-11-23 P2：Web Browser（v1.0.0）从内置工厂摘除——它的
//   before_tool_call 拦截与 after_tool_call 格式化全部被 Enhanced Browser
//   v2.0.0 严格覆盖（工具名单子集 + 拦截模式子集 + 同款格式化前缀），
//   双插件同时挂 after_tool_call 时靠注册顺序让 Enhanced 的结果胜出，
//   Web Browser 的 handler 是纯冗余。文件保留（createWebBrowserPlugin
//   仍导出，SDK/自定义装配可用），但不再默认注册。
export const BUILTIN_PLUGIN_FACTORIES: Array<() => Plugin> = [
  createMemoryEnhancerPlugin,
  createCodeAnalyzerPlugin,
  createSystemLoggerPlugin,
  createCostTrackerPlugin,
  createResponseValidatorPlugin,
  createConversationSummarizerPlugin,
  createClaudeCodeToolsPlugin,
  createMarkItDownPlugin,
  createEnhancedBrowserPlugin,
];
