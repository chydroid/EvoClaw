export { createMemoryEnhancerPlugin } from "./memory-enhancer.plugin";
export { createCodeAnalyzerPlugin } from "./code-analyzer.plugin";
export { createWebBrowserPlugin } from "./web-browser.plugin";
export { createSystemLoggerPlugin } from "./system-logger.plugin";
export { createCostTrackerPlugin } from "./cost-tracker.plugin";
export { createResponseValidatorPlugin } from "./response-validator.plugin";
export { createConversationSummarizerPlugin } from "./conversation-summarizer.plugin";
export { createClaudeCodeToolsPlugin } from "./claude-code.plugin";
export { createMarkItDownPlugin } from "./markitdown.plugin";
export { createEnhancedBrowserPlugin } from "./enhanced-browser.plugin";

import type { Plugin } from "@evoclaw/core";
import { createMemoryEnhancerPlugin } from "./memory-enhancer.plugin";
import { createCodeAnalyzerPlugin } from "./code-analyzer.plugin";
import { createWebBrowserPlugin } from "./web-browser.plugin";
import { createSystemLoggerPlugin } from "./system-logger.plugin";
import { createCostTrackerPlugin } from "./cost-tracker.plugin";
import { createResponseValidatorPlugin } from "./response-validator.plugin";
import { createConversationSummarizerPlugin } from "./conversation-summarizer.plugin";
import { createClaudeCodeToolsPlugin } from "./claude-code.plugin";
import { createMarkItDownPlugin } from "./markitdown.plugin";
import { createEnhancedBrowserPlugin } from "./enhanced-browser.plugin";

export const BUILTIN_PLUGIN_FACTORIES: Array<() => Plugin> = [
  createMemoryEnhancerPlugin,
  createCodeAnalyzerPlugin,
  createWebBrowserPlugin,
  createSystemLoggerPlugin,
  createCostTrackerPlugin,
  createResponseValidatorPlugin,
  createConversationSummarizerPlugin,
  createClaudeCodeToolsPlugin,
  createMarkItDownPlugin,
  createEnhancedBrowserPlugin,
];
