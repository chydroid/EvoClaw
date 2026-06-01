/**
 * Claude Code Tools Plugin — EvoClaw 编程任务调度插件适配器
 *
 * 将 ClaudeCodePlugin 类包装为 EvoClaw Plugin 接口，
 * 使其能被 PluginManager 发现、注册并在 WebUI 中显示。
 */

import type { Plugin, PluginHookRegistration, PluginContext, BeforePromptBuildHook, BeforeToolCallHook, AfterToolCallHook } from "@evoclaw/core";
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
        h.systemPrompt += `

[Claude Code Tools v2.0] 编程任务调度系统已就绪。

可用工具:
- execute_programming_task: 执行复杂编程任务（自动分解→调度→整合），支持策略: sequential/parallel/hybrid
- get_task_result: 查询异步任务进度和结果
- decompose_programming_task: 预览任务分解方案（不执行）
- assess_coding_capability: 评估当前编程能力等级

最佳实践:
1. 复杂任务(>3步骤)使用 execute_programming_task 而非直接编写
2. 先用 decompose_programming_task 评估复杂度再决定执行策略
3. 异步任务提交后用 get_task_result 轮询结果(间隔15秒)
4. 定期 assess_coding_capability 了解系统能力边界
5. 代码生成后建议使用 Code Analyzer 扫描质量`;
        return { appendSystemContext: "" };
      },
    },
    {
      hookType: "before_tool_call",
      priority: "first",
      handler: async (hook) => {
        const h = hook as BeforeToolCallHook;
        if (h.toolName === "execute_programming_task") {
          const params = h.params || {};
          const desc = String(params.task_description || "");
          if (desc.length < 10) {
            return {
              params: {
                ...params,
                task_description: desc + "\n\n[系统提示: 任务描述过于简短，请提供更详细的需求描述以获得更好的分解结果]",
              },
            };
          }
        }
        return {};
      },
    },
    {
      hookType: "after_tool_call",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as AfterToolCallHook;
        const toolNames = ["execute_programming_task", "decompose_programming_task", "assess_coding_capability", "get_task_result"];
        if (toolNames.includes(h.toolName)) {
          if (h.errored) {
            console.error(`[Claude Code Tools] Tool ${h.toolName} failed`);
          } else {
            console.log(`[Claude Code Tools] Tool ${h.toolName} executed successfully`);
          }
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
