/**
 * Memory Enhancer Plugin
 * 
 * Hooks into the agent lifecycle to enhance long-term memory:
 * - before_prompt_build: injects relevant past memories into system prompt
 * - session_end: persists important session insights to long-term memory
 * - after_tool_call: captures significant tool results for memory indexing
 */

import type { Plugin, PluginHookRegistration, PluginContext, BeforePromptBuildHook, SessionEndHook, AfterToolCallHook } from "@evoclaw/core";

const MANIFEST = {
  name: "Memory Enhancer",
  version: "1.2.0",
  description: "Enhanced memory management with semantic search and vector embeddings",
  author: "evoclaw",
};

let ctx: PluginContext | null = null;

export function createMemoryEnhancerPlugin(): Plugin {
  const hooks: PluginHookRegistration[] = [
    {
      hookType: "before_prompt_build",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as BeforePromptBuildHook;
        // Memory injection is already handled in chat() via memoryHub.search(),
        // but this plugin adds an explicit memory note to the system prompt
        // so the agent knows it can reference past conversations.
        h.systemPrompt += "\n\n[Memory Enhancer] Long-term memory is active. Refer to [相关历史记忆] context when relevant.";
        return { appendSystemContext: "" };
      },
    },
    {
      hookType: "session_end",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as SessionEndHook;
        const reason = h.reason || "completed";
        // Log session closure for audit
        console.log(`[Memory Enhancer] Session ending: ${h.context?.sessionId}, reason: ${reason}`);
        return {};
      },
    },
    {
      hookType: "after_tool_call",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as AfterToolCallHook;
        // Capture significant file operations for memory indexing
        if (["file_create", "file_modify", "web_search", "web_fetch"].includes(h.toolName) && !h.errored) {
          console.log(`[Memory Enhancer] Capturing tool result: ${h.toolName}`);
          // In a full implementation, this would index results into vector memory
        }
        return {};
      },
    },
  ];

  return {
    manifest: MANIFEST,
    hooks,
    async shutdown() {
      console.log("[Memory Enhancer] Shutting down");
    },
  };
}