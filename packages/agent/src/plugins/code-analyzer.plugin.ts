import type { Plugin, PluginHookRegistration, BeforeAgentReplyHook, AfterToolCallHook } from "@evoclaw/core";

const MANIFEST = {
  name: "Code Analyzer",
  version: "3.0.0",
  description: "Static code analysis with security, quality, type safety, performance, and architecture scanning",
  description_zh: "静态代码分析：安全性、代码质量、类型安全、性能和架构扫描",
  author: "evoclaw",
};

interface CodeIssue {
  line: number;
  severity: "critical" | "danger" | "warning" | "info";
  message: string;
  pattern: string;
  category: "security" | "quality" | "type_safety" | "performance" | "architecture";
  code?: string;
}

interface ScanConfig {
  security?: boolean;
  quality?: boolean;
  typeSafety?: boolean;
  performance?: boolean;
  architecture?: boolean;
  maxIssues?: number;
  /**
   * 2026-10-15 评测修复（v0.93 eval）：报告输出模式。
   * - "inline"（旧行为，默认）：把报告内联进 before_tool_call 的 content 参数
   *   （已废弃——会破坏磁盘文件字节，导致 JS/TS 等可执行文件 SyntaxError，
   *   模型绕 5+ 轮仍失败；Python 类注释注入则静默污染）
   * - "result"（推荐）：报告作为附加文本随 tool_result 下发，磁盘文件保持原字节
   */
  reportMode?: "inline" | "result";
}

type PatternDef = { regex: RegExp; message: string; severity: CodeIssue["severity"] };

const SECURITY_PATTERNS: PatternDef[] = [
  { regex: /\beval\s*\(/g, message: "eval() is a security risk — prefer safer alternatives", severity: "critical" },
  { regex: /process\.env\s*\.\s*(\w+)/g, message: "Environment variable $1 accessed — ensure it's not leaked", severity: "warning" },
  { regex: /=+\s*['"]?(\w*password\w*|secret|api.?key|token)['"]?\s*=+\s*['"][^'"]+['"]/gi, message: "Hardcoded credential detected: $1", severity: "critical" },
  { regex: /innerHTML\s*=/g, message: "innerHTML assignment is vulnerable to XSS — use textContent or sanitize", severity: "danger" },
  { regex: /dangerouslySetInnerHTML/g, message: "React dangerouslySetInnerHTML — ensure content is sanitized", severity: "danger" },
  { regex: /os\.system\s*\(|subprocess\.call\s*\(\s*['"]/g, message: "Shell command injection risk — use subprocess.run() with list args", severity: "danger" },
  { regex: /\.exec\s*\(\s*['"][^'"]*\$\{/g, message: "Command injection risk — avoid string interpolation in exec()", severity: "danger" },
  { regex: /\.query\s*\(\s*['"][^'"]*\$\{/g, message: "Potential SQL injection — use parameterized queries", severity: "critical" },
  { regex: /f['"]SELECT.*WHERE.*\{.*\}[^'"]*['"]/gi, message: "Potential SQL injection in f-string — use parameterized queries", severity: "critical" },
  { regex: /JSON\.parse\s*\(.*(?:req\.|request\.|params\.|body\.)/g, message: "Parsing user input without validation — wrap in try-catch", severity: "warning" },
];

const QUALITY_PATTERNS: PatternDef[] = [
  { regex: /console\.(log|debug|trace)\s*\(/g, message: "Debug console statement — consider removing in production", severity: "info" },
  { regex: /TODO|FIXME|HACK|XXX(?!Stack|Model|-pro)/g, message: "Code contains TODO/FIXME/HACK marker", severity: "info" },
  { regex: /\.then\s*\(.*\)\s*\.catch\s*\(/g, message: "Consider using async/await instead of .then().catch()", severity: "info" },
  { regex: /var\s+\w+\s*=/g, message: "Use 'let' or 'const' instead of 'var'", severity: "info" },
  { regex: /function\s*\w+\s*\([^)]*\)\s*\{[\s\S]{100,}\}/g, message: "Function exceeds 100 chars — consider refactoring", severity: "info" },
];

const TYPE_SAFETY_PATTERNS: PatternDef[] = [
  { regex: /:\s*any\b/g, message: "Avoid 'any' type — use specific types for better type safety", severity: "warning" },
  { regex: /\bas\s+any\b/g, message: "Unsafe type assertion 'as any' — use proper type guards", severity: "warning" },
  { regex: /@ts-ignore|@ts-nocheck/g, message: "TypeScript directive suppresses type checking — fix the type error instead", severity: "warning" },
  { regex: /function\s+\w+\s*\([^)]*\)\s*\{/g, message: "Consider adding explicit return type annotation", severity: "info" },
  { regex: /\w+!\s*[.\[]/g, message: "Non-null assertion '!' — consider using optional chaining or null checks", severity: "info" },
];

const PERFORMANCE_PATTERNS: PatternDef[] = [
  { regex: /setTimeout\s*\(\s*['"]/g, message: "setTimeout with string argument — use function reference instead", severity: "danger" },
  { regex: /new Array\s*\(\s*\)/g, message: "new Array() — consider using array literal [] instead", severity: "info" },
];

const ARCHITECTURE_PATTERNS: PatternDef[] = [
  { regex: /catch\s*\([^)]*\)\s*\{\s*\}/g, message: "Empty catch block — handle or log the error", severity: "warning" },
  { regex: /catch\s*\([^)]*\)\s*\{\s*console\./g, message: "Catch block only logs — consider error recovery", severity: "info" },
  { regex: /\brequire\s*\(/g, message: "CommonJS require() — consider using ES module import", severity: "info" },
  { regex: /function\s*\(.*?\)\s*\{[\s\S]{0,600}?function\s*\(.*?\)\s*\{[\s\S]{0,600}?function\s*\(.*?\)\s*\{/g, message: "Deeply nested callbacks — consider using async/await or Promises", severity: "warning" },
];

function isInComment(code: string, matchIndex: number): boolean {
  const lineStart = code.lastIndexOf("\n", matchIndex - 1) + 1;
  const beforeMatch = code.substring(lineStart, matchIndex);
  if (beforeMatch.includes("//")) return true;
  const beforeCode = code.substring(0, matchIndex);
  const openCount = (beforeCode.match(/\/\*/g) || []).length;
  const closeCount = (beforeCode.match(/\*\//g) || []).length;
  return openCount > closeCount;
}

function scanCode(code: string, language?: string | ScanConfig): CodeIssue[] {
  const config: ScanConfig = typeof language === "object" ? language : {};
  const lines = code.split("\n");
  const issues: CodeIssue[] = [];

  const enabledSets: Array<{ patterns: PatternDef[]; category: CodeIssue["category"] }> = [];
  if (config.security !== false) enabledSets.push({ patterns: SECURITY_PATTERNS, category: "security" });
  if (config.quality !== false) enabledSets.push({ patterns: QUALITY_PATTERNS, category: "quality" });
  if (config.typeSafety !== false) enabledSets.push({ patterns: TYPE_SAFETY_PATTERNS, category: "type_safety" });
  if (config.performance !== false) enabledSets.push({ patterns: PERFORMANCE_PATTERNS, category: "performance" });
  if (config.architecture !== false) enabledSets.push({ patterns: ARCHITECTURE_PATTERNS, category: "architecture" });

  for (const { patterns, category } of enabledSets) {
    for (const { regex, message, severity } of patterns) {
      regex.lastIndex = 0;
      const matches = code.matchAll(regex);
      for (const match of matches) {
        const matchIndex = match.index ?? 0;
        if (category === "type_safety" && isInComment(code, matchIndex)) continue;
        const lineNum = code.substring(0, matchIndex).split("\n").length;
        issues.push({
          line: lineNum,
          severity,
          message: message.replace(/\$(\d+)/g, (_, n) => match[parseInt(n, 10)] || ""),
          pattern: match[0],
          category,
          code: lines[lineNum - 1]?.trim() || "",
        });
      }
    }
  }

  if (config.performance !== false) {
    if (/setInterval\s*\(/.test(code) && !/clearInterval\s*\(/.test(code)) {
      const idx = code.search(/setInterval\s*\(/);
      const lineNum = code.substring(0, idx).split("\n").length;
      issues.push({
        line: lineNum, severity: "warning",
        message: "setInterval without clearInterval — potential memory leak",
        pattern: "setInterval", category: "performance",
        code: lines[lineNum - 1]?.trim() || "",
      });
    }
    if (/JSON\.parse\s*\(/.test(code) && !/\bcatch\b/.test(code)) {
      const idx = code.search(/JSON\.parse\s*\(/);
      const lineNum = code.substring(0, idx).split("\n").length;
      issues.push({
        line: lineNum, severity: "warning",
        message: "JSON.parse without error handling — wrap in try-catch",
        pattern: "JSON.parse", category: "performance",
        code: lines[lineNum - 1]?.trim() || "",
      });
    }
    if ((/\bfor\b/.test(code) || /\bwhile\b/.test(code)) && /\.push\s*\(/.test(code) && !/\.length\s*[<>=!]/.test(code)) {
      const idx = code.search(/\.push\s*\(/);
      const lineNum = code.substring(0, idx).split("\n").length;
      issues.push({
        line: lineNum, severity: "warning",
        message: "Unbounded array growth in loop — consider adding size limits",
        pattern: ".push(", category: "performance",
        code: lines[lineNum - 1]?.trim() || "",
      });
    }
  }

  const seen = new Set<string>();
  const maxIssues = config.maxIssues ?? 50;
  return issues.filter((i) => {
    const key = `${i.line}:${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, maxIssues);
}

const CATEGORY_LABELS: Record<string, string> = {
  security: "Security",
  quality: "Quality",
  type_safety: "Type Safety",
  performance: "Performance",
  architecture: "Architecture",
};

function formatIssues(issues: CodeIssue[], fileContext: string): string {
  if (issues.length === 0) return "";

  const criticalCount = issues.filter(i => i.severity === "critical").length;
  const dangerCount = issues.filter(i => i.severity === "danger").length;
  const warnCount = issues.filter(i => i.severity === "warning").length;
  const infoCount = issues.filter(i => i.severity === "info").length;
  const qualityScore = Math.max(0, 100 - (criticalCount * 25 + dangerCount * 10 + warnCount * 3 + infoCount * 1));

  let report = `\n\n---\n## Code Analyzer Report\n`;
  report += `- Source: \`${fileContext}\`\n`;
  report += `- Found ${issues.length} issue(s): `;
  const parts: string[] = [];
  if (criticalCount > 0) parts.push(`${criticalCount} critical`);
  if (dangerCount > 0) parts.push(`${dangerCount} danger`);
  if (warnCount > 0) parts.push(`${warnCount} warning(s)`);
  if (infoCount > 0) parts.push(`${infoCount} info`);
  report += parts.join(", ") + "\n";
  report += `- Quality Score: ${qualityScore}/100\n`;

  const categories = ["security", "quality", "type_safety", "performance", "architecture"] as const;
  const catParts = categories.map(c => `${CATEGORY_LABELS[c]}: ${issues.filter(i => i.category === c).length}`);
  report += `- Category Breakdown: ${catParts.join(", ")}\n\n`;

  const sorted = [...issues].sort((a, b) => {
    const order: Record<string, number> = { critical: 0, danger: 1, warning: 2, info: 3 };
    return order[a.severity] - order[b.severity];
  });

  for (const issue of sorted.slice(0, 15)) {
    const emoji = issue.severity === "critical" ? "💀" : issue.severity === "danger" ? "🔴" : issue.severity === "warning" ? "🟡" : "🔵";
    const snippet = issue.code ? ` \`${issue.code}\`` : "";
    report += `- ${emoji} L${issue.line} [${CATEGORY_LABELS[issue.category]}]: ${issue.message}${snippet}\n`;
  }

  if (issues.length > 15) {
    report += `- ... and ${issues.length - 15} more issue(s)\n`;
  }

  report += "\n---\n";
  return report;
}

export { scanCode };
export type { CodeIssue, ScanConfig };

export function createCodeAnalyzerPlugin(): Plugin {
  let analyzeCount = 0;

  const hooks: PluginHookRegistration[] = [
    {
      hookType: "after_tool_call",
      priority: "normal",
      // 2026-10-15 评测修复（v0.93 eval）：报告改为随 tool_result 下发，不再
      // 通过 before_tool_call 改写 content 参数把报告内联写进磁盘文件。
      // 旧行为（inline 模式）事故：报告文本带 C 风格 /* */ 注释头被写进
      // JS/TS 可执行文件 → 文件无法运行（SyntaxError）；Python/Shell 的注释
      // 语法差异让注入内容静默污染源码；模型 5+ 轮「重写仍被污染」死循环。
      // 现在磁盘文件保持模型写入的原始字节；分析报告作为附加文本进 tool_result，
      // 模型可读可改，且不影响文件本身。
      handler: async (hook) => {
        const h = hook as import("@evoclaw/core").AfterToolCallHook;
        if (h.toolName !== "file_write") return {};
        if (h.errored) return {};
        const params = h.params || {};
        const content = String(params.content ?? "");
        const filePath = String(params.path || "");
        if (!content || content.length < 10 || !filePath) return {};

        const codeExts = /\.(js|ts|tsx|jsx|mjs|cjs|py|java|go|rs|cpp|c|rb|php|swift|kt|sh|bash|yaml|yml|json|html|css|scss|sql)$/i;
        if (!codeExts.test(filePath)) return {};

        const issues = scanCode(content, filePath.split(".").pop());
        if (issues.length === 0) return {};
        analyzeCount++;
        const report = formatIssues(issues, filePath).trim();
        process.stdout.write(`[Code Analyzer] ${issues.length} issue(s) in ${filePath} (total analyses: ${analyzeCount}) — 报告随 tool_result 下发，磁盘文件保持原字节\n`);

        // 把报告附加到工具结果上（llm-caller 会把非字符串 result JSON.stringify）
        let base: unknown = {};
        try {
          base = typeof h.result === "string" ? JSON.parse(h.result) : h.result;
        } catch { /* result 非 JSON 时原样包装 */ }
        if (typeof base !== "object" || base === null) base = { original: base };
        return {
          result: { ...(base as Record<string, unknown>), codeAnalysis: report },
        };
      },
    },
    {
      hookType: "before_agent_reply",
      priority: "normal",
      handler: async (hook) => {
        const h = hook as import("@evoclaw/core").BeforeAgentReplyHook;
        const messages = h.messages || [];
        let totalIssues = 0;

        for (const msg of messages) {
          if (msg.role !== "assistant") continue;
          const content = typeof msg.content === "string" ? msg.content : "";
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
