/**
 * Code Analyzer Plugin
 * 
 * Provides static code analysis, basic linting, and security scanning
 * for development tasks. Hooks into:
 * - before_tool_call: scans code in file_create/file_modify for issues
 * - before_agent_reply: scans code blocks in assistant responses
 * 
 * No external dependency required — uses regex-based pattern matching.
 */

import type { Plugin, PluginHookRegistration, BeforeToolCallHook, BeforeAgentReplyHook } from "@evoclaw/core";

const MANIFEST = {
  name: "Code Analyzer",
  version: "2.0.0",
  description: "Static code analysis, linting, and security scanning for development tasks",
  author: "evoclaw",
};

interface CodeIssue {
  line: number;
  severity: "warning" | "danger" | "info";
  message: string;
  pattern: string;
}

/** Security-sensitive patterns to flag */
const SECURITY_PATTERNS: Array<{ regex: RegExp; message: string; severity: CodeIssue["severity"] }> = [
  { regex: /\beval\s*\(/g, message: "eval() is a security risk — prefer safer alternatives", severity: "danger" },
  { regex: /process\.env\s*\.\s*(\w+)/g, message: "Environment variable $1 accessed — ensure it's not leaked", severity: "warning" },
  { regex: /=+\s*['"]?(\w*password\w*|secret|api.?key|token)['"]?\s*=+\s*['"][^'"]+['"]/gi, message: "Hardcoded credential detected: $1", severity: "danger" },
  { regex: /innerHTML\s*=/g, message: "innerHTML assignment is vulnerable to XSS — use textContent or sanitize", severity: "danger" },
  { regex: /dangerouslySetInnerHTML/g, message: "React dangerouslySetInnerHTML — ensure content is sanitized", severity: "danger" },
  { regex: /os\.system\s*\(|subprocess\.call\s*\(\s*['"]/g, message: "Shell command injection risk — use subprocess.run() with list args", severity: "danger" },
  { regex: /\.exec\s*\(\s*['"][^'"]*\$\{/g, message: "Command injection risk — avoid string interpolation in exec()", severity: "danger" },
  { regex: /\.query\s*\(\s*['"][^'"]*\$\{/g, message: "Potential SQL injection — use parameterized queries", severity: "danger" },
  { regex: /f['"]SELECT.*WHERE.*\{.*\}[^'"]*['"]/gi, message: "Potential SQL injection in f-string — use parameterized queries", severity: "danger" },
  { regex: /JSON\.parse\s*\(.*(?:req\.|request\.|params\.|body\.)/g, message: "Parsing user input without validation — wrap in try-catch", severity: "warning" },
];

/** Code quality patterns */
const QUALITY_PATTERNS: Array<{ regex: RegExp; message: string; severity: CodeIssue["severity"] }> = [
  { regex: /console\.(log|debug|trace)\s*\(/g, message: "Debug console statement — consider removing in production", severity: "info" },
  { regex: /TODO|FIXME|HACK|XXX(?!Stack|Model|-pro)/g, message: "Code contains TODO/FIXME/HACK marker", severity: "info" },
  { regex: /\.then\s*\(.*\)\s*\.catch\s*\(/g, message: "Consider using async/await instead of .then().catch()", severity: "info" },
  { regex: /var\s+\w+\s*=/g, message: "Use 'let' or 'const' instead of 'var'", severity: "info" },
  { regex: /function\s*\w+\s*\([^)]*\)\s*\{[\s\S]{100,}\}/g, message: "Function exceeds 100 chars — consider refactoring", severity: "info" },
];

function scanCode(code: string, language?: string): CodeIssue[] {
  const issues: CodeIssue[] = [];
  const lines = code.split("\n");

  const patternSets = [
    ...SECURITY_PATTERNS,
    ...QUALITY_PATTERNS,
  ];

  for (const { regex, message, severity } of patternSets) {
    // Reset regex state
    regex.lastIndex = 0;
    const matches = code.matchAll(regex);
    for (const match of matches) {
      const matchIndex = match.index ?? 0;
      const lineNum = code.substring(0, matchIndex).split("\n").length;
      issues.push({
        line: lineNum,
        severity,
        message: message.replace(/\$(\d+)/g, (_, n) => match[parseInt(n)] || ""),
        pattern: match[0],
      });
    }
  }

  // Deduplicate by line + message
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.line}:${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatIssues(issues: CodeIssue[], fileContext: string): string {
  if (issues.length === 0) return "";

  const dangerCount = issues.filter((i) => i.severity === "danger").length;
  const warnCount = issues.filter((i) => i.severity === "warning").length;
  const infoCount = issues.filter((i) => i.severity === "info").length;

  let report = `\n\n---\n## Code Analyzer Report\n`;
  report += `- Source: \`${fileContext}\`\n`;
  report += `- Found ${issues.length} issue(s): `;
  const parts: string[] = [];
  if (dangerCount > 0) parts.push(`${dangerCount} critical`);
  if (warnCount > 0) parts.push(`${warnCount} warning(s)`);
  if (infoCount > 0) parts.push(`${infoCount} info`);
  report += parts.join(", ") + "\n\n";

  // Show dangerous issues first
  const sorted = [...issues].sort((a, b) => {
    const order = { danger: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  });

  for (const issue of sorted.slice(0, 10)) {
    const emoji = issue.severity === "danger" ? "🔴" : issue.severity === "warning" ? "🟡" : "🔵";
    report += `- ${emoji} L${issue.line}: ${issue.message}\n`;
  }

  if (issues.length > 10) {
    report += `- ... and ${issues.length - 10} more issue(s)\n`;
  }

  report += "\n---\n";
  return report;
}

export function createCodeAnalyzerPlugin(): Plugin {
  let analyzeCount = 0;

  const hooks: PluginHookRegistration[] = [
    {
      hookType: "before_tool_call",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as BeforeToolCallHook;
        // Only analyze code in file_create and file_modify tools
        if (h.toolName !== "file_create" && h.toolName !== "file_modify") return {};

        const params = h.params || {};
        const content = String(params.content || "");
        const filePath = String(params.path || "");
        if (!content || content.length < 10) return {};

        // Only analyze known code file extensions
        const codeExts = /\.(js|ts|tsx|jsx|py|java|go|rs|cpp|c|rb|php|swift|kt|sh|bash|yaml|yml|json|html|css|scss|sql)$/i;
        if (!codeExts.test(filePath)) return {};

        const issues = scanCode(content, filePath.split(".").pop());
        if (issues.length > 0) {
          analyzeCount++;
          const report = formatIssues(issues, filePath);
          console.log(`[Code Analyzer] Found ${issues.length} issue(s) in ${filePath} (total analyses: ${analyzeCount})`);

          // Append the report as a prefix comment to the file content
          // so the agent sees the analysis results
          const prefixedContent = `/* [Code Analyzer v2.0.0] Scan results for ${filePath}: */\n${report}\n${content}`;

          return {
            params: { ...params, content: prefixedContent },
          };
        }
        return {};
      },
    },
    {
      hookType: "before_agent_reply",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as BeforeAgentReplyHook;
        // Scan any code blocks in the messages for potential issues
        // This is passive — we add a note to the system context about findings
        const messages = h.messages || [];
        let totalIssues = 0;

        for (const msg of messages) {
          if (msg.role !== "assistant") continue;
          const content = typeof msg.content === "string" ? msg.content : "";
          // Extract code blocks
          const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
          for (const block of codeBlocks) {
            const issues = scanCode(block);
            if (issues.length > 0) {
              totalIssues += issues.length;
              console.log(`[Code Analyzer] Found ${issues.length} issue(s) in assistant reply code block`);
            }
          }
        }

        if (totalIssues > 0) {
          return {
            appendSystemContext: `\n[Code Analyzer] The last assistant reply contained ${totalIssues} potential code quality/security issue(s). Review the flagged patterns before proceeding.`,
          };
        }
        return {};
      },
    },
  ];

  return {
    manifest: MANIFEST,
    hooks,
    async init(ctx) {
      console.log(`[Code Analyzer] Initialized — using built-in regex patterns (no external deps required)`);
    },
    async shutdown() {
      console.log(`[Code Analyzer] Shutting down — analyzed ${analyzeCount} file(s) during session`);
    },
    async healthCheck() {
      return { healthy: true, message: `Active (${analyzeCount} files analyzed)` };
    },
  };
}