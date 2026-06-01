import type { Plugin, PluginHookRegistration, BeforeAgentReplyHook, AgentEndHook } from "@evoclaw/core";

const MANIFEST = {
  name: "Response Validator",
  version: "2.0.0",
  description: "Validates AI response quality — catches and auto-fixes broken replies before delivery",
  author: "evoclaw",
};

interface ValidationIssue {
  type: string;
  severity: "warning" | "error";
  message: string;
  snippet?: string;
  autoFixed?: boolean;
}

const BROKEN_RESPONSE_PATTERNS: Array<{ pattern: RegExp; type: string; severity: "warning" | "error" }> = [
  { pattern: /\[(object Object|undefined|null)\]/i, type: "raw_object_in_output", severity: "error" },
  { pattern: /\{\s*"error"\s*:\s*"[^"]*"\s*\}/i, type: "error_json_leak", severity: "error" },
  { pattern: /I (cannot|can't|am unable to|don't have the ability to)/i, type: "capability_disclaimer", severity: "warning" },
  { pattern: /As an AI (language model|assistant)/i, type: "ai_self_reference", severity: "warning" },
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

  const tripleBackticks = (text.match(/```/g) || []).length;
  if (tripleBackticks % 2 !== 0) {
    issues.push({ type: "unclosed_code_block", severity: "error", message: "Unclosed code block detected" });
  }

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

  if (/(\.\.\.|…)\s*$/.test(text.trim()) && text.length > 300) {
    issues.push({ type: "possible_truncation", severity: "warning", message: "Response appears truncated" });
  }

  return issues;
}

function autoFixResponse(text: string, issues: ValidationIssue[]): string {
  let fixed = text;

  for (const issue of issues) {
    switch (issue.type) {
      case "unclosed_code_block": {
        const count = (fixed.match(/```/g) || []).length;
        if (count % 2 !== 0) {
          fixed += "\n```\n";
          issue.autoFixed = true;
        }
        break;
      }
      case "raw_object_in_output": {
        fixed = fixed.replace(/\[(object Object|undefined|null)\]/gi, "[数据异常，已过滤]");
        issue.autoFixed = true;
        break;
      }
      case "error_json_leak": {
        fixed = fixed.replace(/\{\s*"error"\s*:\s*"[^"]*"\s*\}/gi, "[错误信息已过滤]");
        issue.autoFixed = true;
        break;
      }
      case "possible_truncation": {
        fixed = fixed.replace(/(\.\.\.|…)\s*$/, "\n\n[注：回复可能被截断，如需完整内容请告知]");
        issue.autoFixed = true;
        break;
      }
    }
  }

  return fixed;
}

let totalValidated = 0;
let issuesFound = 0;
let autoFixed = 0;

export function createResponseValidatorPlugin(): Plugin {
  return {
    manifest: MANIFEST,
    hooks: [
      {
        hookType: "before_agent_reply",
        priority: "normal",
        handler: (hook: BeforeAgentReplyHook) => {
          const lastAssistantMsg = [...hook.messages].reverse().find((m) => m.role === "assistant");
          if (lastAssistantMsg?.content) {
            const issues = validateResponse(lastAssistantMsg.content);
            totalValidated++;
            if (issues.length > 0) {
              issuesFound++;

              const fixedContent = autoFixResponse(lastAssistantMsg.content, issues);
              const wasFixed = issues.some((i) => i.autoFixed);

              if (wasFixed) {
                autoFixed++;
                lastAssistantMsg.content = fixedContent;
              }

              const hasWarnings = issues.some((i) => i.severity === "warning" && !i.autoFixed);
              if (hasWarnings) {
                const warningTypes = issues.filter((i) => i.severity === "warning").map((i) => i.type);
                hook.messages.push({
                  role: "user",
                  content: `[系统提示：你的回复中检测到以下问题：${warningTypes.join("、")}。请注意避免这些问题，直接给出有用的回答，不要声明能力限制或自我引用。]`,
                });
              }

              for (const issue of issues) {
                if (issue.severity === "error") {
                  console.warn(`[ResponseValidator] ${issue.autoFixed ? "AUTO-FIXED" : issue.type}: ${issue.message}`, issue.snippet || "");
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
      console.log("[ResponseValidator] Initialized — validating and auto-fixing agent responses");
    },

    async shutdown() {
      console.log(`[ResponseValidator] Shutdown — Validated ${totalValidated} responses, ${issuesFound} had issues, ${autoFixed} auto-fixed`);
    },

    async healthCheck() {
      return {
        healthy: true,
        message: `${totalValidated} validated, ${issuesFound} issues, ${autoFixed} auto-fixed`,
      };
    },
  };
}
