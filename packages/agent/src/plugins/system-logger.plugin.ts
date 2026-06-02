/**
 * System Logger Plugin
 * 
 * Provides comprehensive activity logging for audit and debugging.
 * Hooks into:
 * - before_agent_start: logs incoming requests
 * - agent_end: logs completion with metrics
 * - after_tool_call: logs tool executions
 */

import type { Plugin, PluginHookRegistration, BeforeAgentStartHook, AgentEndHook, AfterToolCallHook } from "@evoclaw/core";

const MANIFEST = {
  name: "System Logger",
  version: "1.0.0",
  description: "Comprehensive activity logging for audit, debugging, and analytics",
  description_zh: "系统日志：全面的操作活动记录，支持审计、调试和分析",
  author: "evoclaw",
};

interface ActivityLog {
  timestamp: string;
  type: "request" | "response" | "tool" | "error";
  sessionId?: string;
  detail: string;
  metadata?: Record<string, unknown>;
}

export function createSystemLoggerPlugin(): Plugin {
  const activityLog: ActivityLog[] = [];
  const MAX_LOG_SIZE = 500;

  function addLog(entry: ActivityLog): void {
    activityLog.push(entry);
    if (activityLog.length > MAX_LOG_SIZE) {
      activityLog.shift(); // Keep the log bounded
    }
  }

  const hooks: PluginHookRegistration[] = [
    {
      hookType: "before_agent_start",
      priority: "last",
      handler: async (hook) => {
        const h = hook as BeforeAgentStartHook;
        const msgPreview = h.message?.slice(0, 100) ?? "";
        const attCount = h.attachments?.length ?? 0;

        addLog({
          timestamp: new Date().toISOString(),
          type: "request",
          sessionId: h.context?.sessionId,
          detail: `Incoming request: "${msgPreview}"${attCount > 0 ? ` (${attCount} attachments)` : ""}`,
          metadata: { channel: h.context?.channel, peerId: h.context?.peerId, attachmentCount: attCount },
        });

        console.log(`[System Logger] Request #${activityLog.length}: session=${h.context?.sessionId}, channel=${h.context?.channel}`);
        return {};
      },
    },
    {
      hookType: "agent_end",
      priority: "last",
      handler: async (hook) => {
        const h = hook as AgentEndHook;
        const meta = h.metadata || {};
        const replyLen = (h.messages?.[0]?.content as string)?.length ?? 0;

        addLog({
          timestamp: new Date().toISOString(),
          type: "response",
          sessionId: h.context?.sessionId,
          detail: `Response: ${replyLen} chars, ${meta.tokensUsed ?? 0} tokens, ${meta.duration ?? 0}ms, ${meta.toolCalls ?? 0} tools`,
          metadata: {
            tokensUsed: meta.tokensUsed,
            duration: meta.duration,
            toolCalls: meta.toolCalls,
            success: meta.success,
            error: meta.error,
          },
        });

        console.log(`[System Logger] Response: ${replyLen} chars, ${meta.tokensUsed ?? 0} tokens, ${meta.duration ?? 0}ms`);
        return {};
      },
    },
    {
      hookType: "after_tool_call",
      priority: "last",
      handler: async (hook) => {
        const h = hook as AfterToolCallHook;
        const resultLen = typeof h.result === "string" ? h.result.length : JSON.stringify(h.result || "").length;

        addLog({
          timestamp: new Date().toISOString(),
          type: h.errored ? "error" : "tool",
          sessionId: h.context?.sessionId,
          detail: `Tool "${h.toolName}" ${h.errored ? "FAILED" : "completed"} — ${resultLen} chars result`,
          metadata: {
            toolName: h.toolName,
            params: h.params,
            errored: h.errored,
            error: h.error,
            resultLength: resultLen,
          },
        });

        if (h.errored) {
          console.log(`[System Logger] Tool error: ${h.toolName} — ${h.error}`);
        }
        return {};
      },
    },
  ];

  return {
    manifest: MANIFEST,
    hooks,
    async shutdown() {
      console.log(`[System Logger] Shutting down — ${activityLog.length} activity records`);
      // In a full implementation, this would persist the log to disk
    },
    async healthCheck() {
      return { healthy: true, message: `Active (${activityLog.length} events logged)` };
    },
  };
}