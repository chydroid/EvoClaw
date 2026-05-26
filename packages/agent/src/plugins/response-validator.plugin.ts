/**
 * Response Validator Plugin
 *
 * Validates agent response quality before delivery to user.
 * Hooks into:
 * - before_agent_reply: checks response for common issues
 * - agent_end: validates final message quality
 *
 * Checks for: empty responses, truncation, error leaks, placeholder text,
 * incomplete code blocks, and excessive repetition.
 */

import type { Plugin, PluginHookRegistration, BeforeAgentReplyHook, AgentEndHook } from "@evoclaw/core";

const MANIFEST = {
  name: "Response Validator",
  version: "1.0.0",
  description: "Validates AI response quality — catches empty, truncated, or broken replies before delivery",
  author: "evoclaw",
};

interface ValidationIssue {
  type: string;
  severity: "warning" | "error";
  message: string;
  snippet?: string;
}

// ── Patterns that indicate broken/incomplete responses ──
const BROKEN_RESPONSE_PATTERNS: Array<{ pattern: RegExp; type: string; severity: "warning" | "error" }> = [
  { pattern: /\[(object Object|undefined|null)\]/i, type: "raw_object_in_output", severity: "error" },
  { pattern: /\{\s*"error"\s*:\s*"[^"]*"\s*\}/i, type: "error_json_leak", severity: "error" },
  { pattern: /I (cannot|can't|am unable to|don't have the ability to)/i, type: "capability_disclaimer", severity: "warning" },
  { pattern: /As an AI (language model|assistant)/i, type: "ai_self_reference", severity: "warning" },
  { pattern: /```[a-z]*\s*$/, type: "unclosed_code_block", severity: "error" },
  { pattern: /\b(todo|placeholder|TBD|FIXME|XXX)\b.*:\s*$/, type: "placeholder_text", severity: "warning" },
  { pattern: /\(https?:\/\/[^\s)]*\)\s*$/, type: "dangling_url", severity: "warning" },
];

const MIN_RESPONSE_CHARS = 2;
const MAX_REPETITION_RATIO = 0.6;

function validateResponse(text: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!text || text.trim().length < MIN_RESPONSE_CHARS) {
    issues.push({ type: "empty_response", severity: "error", message: "Response is empty or too short" });
    return issues;
  }

  // Check for broken patterns
  for (const { pattern, type, severity } of BROKEN_RESPONSE_PATTERNS) {
    if (pattern.test(text)) {
      const match = text.match(pattern);
      issues.push({
        type,
        severity,
        message: `Detected "${type}" in response`,
        snippet: match ? match[0].substring(0, 80) : undefined,
      });
    }
  }

  // Check for unclosed code blocks (count backticks)
  const tripleBackticks = (text.match(/```/g) || []).length;
  if (tripleBackticks % 2 !== 0) {
    issues.push({ type: "unclosed_code_block", severity: "error", message: "Unclosed code block detected" });
  }

  // Check for excessive repetition
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length > 5) {
    const uniqueLines = new Set(lines.map((l) => l.trim()));
    const repetitionRatio = 1 - uniqueLines.size / lines.length;
    if (repetitionRatio > MAX_REPETITION_RATIO) {
      issues.push({
        type: "excessive_repetition",
        severity: "warning",
        message: `Response has ${(repetitionRatio * 100).toFixed(0)}% repeated lines`,
      });
    }
  }

  // Check for truncation markers
  if (/(\.\.\.|…)\s*$/.test(text.trim()) && text.length > 300) {
    issues.push({ type: "possible_truncation", severity: "warning", message: "Response appears truncated" });
  }

  return issues;
}

let totalValidated = 0;
let issuesFound = 0;

export function createResponseValidatorPlugin(): Plugin {
  return {
    manifest: MANIFEST,
    hooks: [
      {
        hookType: "before_agent_reply",
        priority: "last",
        handler: (hook: BeforeAgentReplyHook) => {
          // Check the last assistant message
          const lastAssistantMsg = [...hook.messages].reverse().find((m) => m.role === "assistant");
          if (lastAssistantMsg?.content) {
            const issues = validateResponse(lastAssistantMsg.content);
            totalValidated++;
            if (issues.length > 0) {
              issuesFound++;
              for (const issue of issues) {
                if (issue.severity === "error") {
                  console.warn(`[ResponseValidator] ${issue.type}: ${issue.message}`, issue.snippet || "");
                }
              }
            }
          }
        },
      } as PluginHookRegistration,
      {
        hookType: "agent_end",
        priority: "normal",
        handler: (hook: AgentEndHook) => {
          // Check the final message in agent end results
          const lastMsg = hook.messages[hook.messages.length - 1];
          if (lastMsg?.content && lastMsg.role === "assistant") {
            const issues = validateResponse(lastMsg.content);
            if (issues.some((i) => i.severity === "error")) {
              console.warn(
                `[ResponseValidator] Session "${hook.context.sessionId || "unknown"}" ended with validation errors`
              );
            }
          }
        },
      } as PluginHookRegistration,
    ],

    async init() {
      console.log("[ResponseValidator] Initialized — validating all agent responses");
    },

    async shutdown() {
      console.log(`[ResponseValidator] Shutdown — Validated ${totalValidated} responses, ${issuesFound} had issues`);
    },

    async healthCheck() {
      return {
        healthy: true,
        message: `${totalValidated} responses validated, ${issuesFound} issues found`,
      };
    },
  };
}