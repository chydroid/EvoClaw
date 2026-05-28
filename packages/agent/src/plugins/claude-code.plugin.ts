/**
 * Claude Code Tools Plugin — EvoClaw 编程任务调度插件适配器
 *
 * 将 ClaudeCodePlugin 类包装为 EvoClaw Plugin 接口，
 * 使其能被 PluginManager 发现、注册并在 WebUI 中显示。
 */

import type { Plugin, PluginHookRegistration, PluginContext, BeforePromptBuildHook, AfterToolCallHook } from "@evoclaw/core";
import { ClaudeCodePlugin, CLAUDE_CODE_PLUGIN_INFO } from "@evoclaw/claude-code-tools";

const MANIFEST = {
  name: CLAUDE_CODE_PLUGIN_INFO.name,
  version: CLAUDE_CODE_PLUGIN_INFO.version,
  description: CLAUDE_CODE_PLUGIN_INFO.description,
  author: CLAUDE_CODE_PLUGIN_INFO.author,
};

let pluginInstance: ClaudeCodePlugin | null = null;

export function createClaudeCodeToolsPlugin(): Plugin {
  const hooks: PluginHookRegistration[] = [
    {
      hookType: "before_prompt_build",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as BeforePromptBuildHook;
        h.systemPrompt += "\n\n[Claude Code Tools] 编程任务调度系统已就绪。可使用 execute_programming_task、decompose_programming_task、assess_coding_capability 工具处理复杂编程任务。";
        return { appendSystemContext: "" };
      },
    },
    {
      hookType: "after_tool_call",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as AfterToolCallHook;
        if (
          ["execute_programming_task", "decompose_programming_task", "assess_coding_capability"].includes(h.toolName) &&
          !h.errored
        ) {
          console.log(`[Claude Code Tools] Tool executed: ${h.toolName}`);
        }
        return {};
      },
    },
  ];

  return {
    manifest: MANIFEST,
    hooks,
    async init(ctx: PluginContext) {
      const registry = ctx.resolveService<import("@evoclaw/core").ServiceRegistry>("registry");
      const eventBus = ctx.resolveService<import("@evoclaw/core").EventBus>("eventBus");

      if (!registry || !eventBus) {
        console.error("[Claude Code Tools] Failed to initialize: registry or eventBus not available");
        return;
      }

      pluginInstance = new ClaudeCodePlugin(registry, eventBus);
      pluginInstance.initialize();
      console.log(`[Claude Code Tools] Plugin initialized via PluginManager`);
    },
    async shutdown() {
      pluginInstance = null;
      console.log("[Claude Code Tools] Plugin shut down");
    },
    async healthCheck() {
      if (!pluginInstance) {
        return { healthy: false, message: "Plugin not initialized" };
      }
      const healthy = await pluginInstance.healthCheck();
      return { healthy, message: healthy ? "Claude Code Tools operational" : "Plugin initialized but health check failed" };
    },
  };
}
