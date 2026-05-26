/**
 * Plugin Index — aggregates all built-in plugin factories.
 * Import and register these on server startup to activate plugins.
 */

export { createMemoryEnhancerPlugin } from "./memory-enhancer.plugin";
export { createCodeAnalyzerPlugin } from "./code-analyzer.plugin";
export { createWebBrowserPlugin } from "./web-browser.plugin";
export { createSystemLoggerPlugin } from "./system-logger.plugin";
export { createCostTrackerPlugin } from "./cost-tracker.plugin";
export { createResponseValidatorPlugin } from "./response-validator.plugin";
export { createConversationSummarizerPlugin } from "./conversation-summarizer.plugin";

import type { Plugin } from "@evoclaw/core";
import { createMemoryEnhancerPlugin } from "./memory-enhancer.plugin";
import { createCodeAnalyzerPlugin } from "./code-analyzer.plugin";
import { createWebBrowserPlugin } from "./web-browser.plugin";
import { createSystemLoggerPlugin } from "./system-logger.plugin";
import { createCostTrackerPlugin } from "./cost-tracker.plugin";
import { createResponseValidatorPlugin } from "./response-validator.plugin";
import { createConversationSummarizerPlugin } from "./conversation-summarizer.plugin";

/** All built-in plugin factories — call these to create plugin instances for registration */
export const BUILTIN_PLUGIN_FACTORIES: Array<() => Plugin> = [
  createMemoryEnhancerPlugin,
  createCodeAnalyzerPlugin,
  createWebBrowserPlugin,
  createSystemLoggerPlugin,
  createCostTrackerPlugin,
  createResponseValidatorPlugin,
  createConversationSummarizerPlugin,
];