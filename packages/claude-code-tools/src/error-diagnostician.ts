/**
 * Error Diagnostician — 智能错误诊断
 *
 * 借鉴 Claude Code 的错误处理模式：
 *   - 错误模式匹配 → 分类
 *   - 从错误日志中提取关键信息（文件路径、行号、建议修复）
 *   - 生成针对性的修复建议
 *
 * 参考: Claude Code 的 PostToolUseFailure hook + error recovery patterns
 */

// ── Types ──

export interface ErrorDiagnosis {
  /** Original error message */
  originalError: string;
  /** Error category */
  category: ErrorCategory;
  /** Extracted file paths mentioned in the error */
  files: string[];
  /** Extracted line numbers */
  lines: number[];
  /** Severity level */
  severity: "error" | "warning" | "info";
  /** Suggested fixes, ranked by likelihood */
  suggestions: string[];
  /** Whether the error is likely transient (retryable) */
  isTransient: boolean;
  /** Confidence in the diagnosis (0-1) */
  confidence: number;
}

export enum ErrorCategory {
  TypeScript = "typescript",
  JavaScript = "javascript",
  Import = "import",
  Network = "network",
  Permission = "permission",
  ParseError = "parse",
  NullReference = "null-reference",
  Timeout = "timeout",
  Unknown = "unknown",
}

// ── Error Pattern Registry ──

interface ErrorPattern {
  regex: RegExp;
  category: ErrorCategory;
  severity: ErrorDiagnosis["severity"];
  extractFile: (match: RegExpExecArray) => string | null;
  extractLine: (match: RegExpExecArray) => number | null;
  suggestions: string[];
  isTransient: boolean;
  confidence: number;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  // TypeScript type errors
  {
    regex: /error TS(\d+):\s+(.+?)(?:\.|$)/m,
    category: ErrorCategory.TypeScript,
    severity: "error",
    extractFile: (m) => null,
    extractLine: (m) => null,
    suggestions: ["Check type definitions for mismatched interfaces.", "Run tsc --noEmit to see full type error details."],
    isTransient: false,
    confidence: 0.9,
  },
  // TypeScript: Type 'X' is not assignable to type 'Y'
  {
    regex: /Type\s+'([^']+)'\s+is not assignable to type\s+'([^']+)'/,
    category: ErrorCategory.TypeScript,
    severity: "error",
    extractFile: (m) => null,
    extractLine: (m) => null,
    suggestions: [
      "Use type assertion (as) if the types are compatible.",
      "Check if the interface definition is missing optional properties.",
      "Verify the generic type parameters match the expected shape.",
    ],
    isTransient: false,
    confidence: 0.85,
  },
  // Import / module not found
  {
    regex: /Cannot find module\s+'([^']+)'|Module not found:\s+(.+?)(?:\n|$)/,
    category: ErrorCategory.Import,
    severity: "error",
    extractFile: (m) => m[1] || m[2] || null,
    extractLine: (m) => null,
    suggestions: [
      "Check package.json dependencies — is the package installed?",
      "Verify the import path is correct (case-sensitive).",
      "Run pnpm install to ensure all dependencies are resolved.",
    ],
    isTransient: false,
    confidence: 0.95,
  },
  // File path with line:col — MUST come BEFORE the generic stack trace pattern
  {
    regex: /([\w./\\-]+\.(tsx?|jsx?|mjs|cjs)):(\d+):(\d+)/,
    category: ErrorCategory.JavaScript,
    severity: "error",
    extractFile: (m) => m[1] || null,
    extractLine: (m) => parseInt(m[3], 10) || null,
    suggestions: ["Check the specific file and line for syntax or logic errors.", "Review the call stack to understand the execution path."],
    isTransient: false,
    confidence: 0.95,
  },
  // Generic stack trace
  {
    regex: /at\s+(.+?):(\d+):(\d+)/,
    category: ErrorCategory.JavaScript,
    severity: "error",
    extractFile: (m) => m[1] || null,
    extractLine: (m) => parseInt(m[2], 10) || null,
    suggestions: ["Check the specific line for syntax or logic errors.", "Review the call stack to understand the execution path."],
    isTransient: false,
    confidence: 0.8,
  },
  // Null / undefined reference
  {
    regex: /Cannot read propert(?:y|ies) of (null|undefined)\s*\(reading\s+'([^']+)'\)/,
    category: ErrorCategory.NullReference,
    severity: "error",
    extractFile: (m) => null,
    extractLine: (m) => null,
    suggestions: [
      "Add optional chaining (?.) to safely access nested properties.",
      "Add a null check (if guard) before accessing the property.",
      "Initialize the variable with a default value before using it.",
      "Check if the async operation resolved before accessing its result.",
    ],
    isTransient: false,
    confidence: 0.9,
  },
  // Network / connection error
  {
    regex: /(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|socket hang up|fetch failed)/i,
    category: ErrorCategory.Network,
    severity: "error",
    extractFile: (m) => null,
    extractLine: (m) => null,
    suggestions: ["Check if the target service is running.", "Verify network connectivity and firewall rules.", "Retry the request with exponential backoff."],
    isTransient: true,
    confidence: 0.9,
  },
  // Permission denied
  {
    regex: /EACCES|EPERM|permission denied|Access denied/i,
    category: ErrorCategory.Permission,
    severity: "error",
    extractFile: (m) => null,
    extractLine: (m) => null,
    suggestions: [
      "Check file/directory permissions (chmod 755 or equivalent).",
      "Run with appropriate user privileges.",
      "Ensure the process has read/write access to the target path.",
    ],
    isTransient: false,
    confidence: 0.85,
  },
  // JSON parse error
  {
    regex: /Unexpected token\s+(.+?) in JSON|JSON\.parse|SyntaxError.*JSON/,
    category: ErrorCategory.ParseError,
    severity: "error",
    extractFile: (m) => null,
    extractLine: (m) => null,
    suggestions: [
      "Validate the JSON structure with a linter or JSON.parse try/catch.",
      "Check for trailing commas, unquoted keys, or BOM characters.",
      "If parsing LLM output, check the rescue parser for malformed JSON.",
    ],
    isTransient: false,
    confidence: 0.9,
  },
  // Timeout
  {
    regex: /timeout|timed out|aborted/i,
    category: ErrorCategory.Timeout,
    severity: "warning",
    extractFile: (m) => null,
    extractLine: (m) => null,
    suggestions: [
      "Increase the timeout threshold for long-running operations.",
      "Split the task into smaller sub-tasks.",
      "Check if the operation is hanging on a blocking I/O call.",
    ],
    isTransient: true,
    confidence: 0.8,
  },
];

// ── Diagnostician ──

export class ErrorDiagnostician {
  private patterns: ErrorPattern[];

  constructor(customPatterns?: ErrorPattern[]) {
    this.patterns = [...ERROR_PATTERNS, ...(customPatterns ?? [])];
  }

  /**
   * Diagnose a single error message — classify and suggest fixes.
   * (Claude Code pattern: PostToolUseFailure hook → diagnose → suggest)
   */
  diagnose(errorMessage: string): ErrorDiagnosis {
    const files: string[] = [];
    const lines: number[] = [];
    let bestMatch: ErrorPattern | null = null;
    let bestMatchLength = 0;

    for (const pattern of this.patterns) {
      const match = pattern.regex.exec(errorMessage);
      if (match) {
        const matchedLength = match[0].length;
        if (matchedLength > bestMatchLength) {
          bestMatch = pattern;
          bestMatchLength = matchedLength;

          const file = pattern.extractFile(match);
          if (file && !files.includes(file)) files.push(file);

          const line = pattern.extractLine(match);
          if (line !== null && line > 0) lines.push(line);
        }
      }
    }

    if (bestMatch) {
      return {
        originalError: errorMessage,
        category: bestMatch.category,
        files,
        lines,
        severity: bestMatch.severity,
        suggestions: bestMatch.suggestions,
        isTransient: bestMatch.isTransient,
        confidence: bestMatch.confidence,
      };
    }

    // Fallback: unknown error
    return {
      originalError: errorMessage,
      category: ErrorCategory.Unknown,
      files,
      lines,
      severity: "error",
      suggestions: [
        "Review the full error message and stack trace.",
        "Check recent changes that may have introduced this issue.",
        "Search for similar errors in the project's issue tracker.",
      ],
      isTransient: false,
      confidence: 0.3,
    };
  }

  /**
   * Batch diagnose multiple error messages.
   * Useful for analyzing test suite failures or log dumps.
   */
  diagnoseBatch(errors: string[]): ErrorDiagnosis[] {
    return errors.map((e) => this.diagnose(e));
  }

  /**
   * Generate a structured report from multiple diagnoses.
   */
  generateReport(diagnoses: ErrorDiagnosis[]): string {
    const byCategory = new Map<ErrorCategory, ErrorDiagnosis[]>();
    for (const d of diagnoses) {
      const list = byCategory.get(d.category) ?? [];
      list.push(d);
      byCategory.set(d.category, list);
    }

    const parts: string[] = ["=== Error Diagnosis Report ===", ""];

    for (const [category, items] of byCategory) {
      parts.push(`[${category}] — ${items.length} issue(s)`);
      for (const item of items) {
        const fileInfo = item.files.length > 0 ? ` (${item.files.join(", ")}${item.lines.length > 0 ? `:${item.lines.join(",")}` : ""})` : "";
        parts.push(`  ${item.severity === "error" ? "❌" : "⚠"} ${item.originalError.substring(0, 120)}${fileInfo}`);
        if (item.suggestions.length > 0) {
          parts.push(`    → ${item.suggestions[0]}`);
        }
      }
      parts.push("");
    }

    const transientCount = diagnoses.filter((d) => d.isTransient).length;
    if (transientCount > 0) {
      parts.push(`Note: ${transientCount} error(s) are transient and may resolve on retry.`);
    }

    return parts.join("\n");
  }

  /**
   * Classify whether a task failure is likely recoverable.
   */
  isRecoverable(errorMessage: string): boolean {
    const diagnosis = this.diagnose(errorMessage);
    return diagnosis.isTransient || diagnosis.confidence > 0.8;
  }
}