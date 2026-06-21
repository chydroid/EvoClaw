// EvoClaw Skill Dispatch Error Handler
// Unified error classification and handling for skill dispatch results

export interface SkillDispatchResult {
  success: boolean;
  path: string;
  skillName?: string;
  output?: unknown;
  reasoning: string;
  duration: number;
  error?: string;
}

export interface ClassifiedSkillError {
  category: "auth" | "rateLimit" | "network" | "config" | "timeout" | "unknown";
  userMessage: string;
  shouldFallbackToLLM: boolean;
  retryable: boolean;
}

const SKILL_ERROR_PATTERNS: Record<string, { patterns: string[]; userMessage: string; retryable: boolean; fallbackToLLM: boolean }> = {
  auth: {
    patterns: [
      "must be set in environment",
      "api key is required",
      "authentication failed",
      "unauthorized",
      "invalid api key",
      "api_key is not set",
      "missing api key",
      "invalid_token",
      "token expired",
    ],
    userMessage: "技能执行失败：API 密钥未配置或无效。请在技能管理页面配置相应的 API Key。",
    retryable: false,
    fallbackToLLM: false,
  },
  rateLimit: {
    patterns: [
      "rate limit exceeded",
      "quota exceeded",
      "too many requests",
      "429",
      "rate_limit",
      "throttled",
    ],
    userMessage: "正在通过其他方式继续处理，请稍候...",
    retryable: true,
    fallbackToLLM: true,
  },
  network: {
    patterns: [
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "network error",
      "connection refused",
      "ECONNRESET",
      "DNS resolution failed",
      "socket hang up",
    ],
    userMessage: "正在通过其他方式继续处理，请稍候...",
    retryable: true,
    fallbackToLLM: true,
  },
  config: {
    patterns: [
      "missing required",
      "config not found",
      "not configured",
      "invalid configuration",
      "configuration error",
    ],
    userMessage: "技能执行失败：配置缺失。请在技能管理页面完善配置。",
    retryable: false,
    fallbackToLLM: false,
  },
  timeout: {
    patterns: [
      "timeout",
      "timed out",
      "operation timed out",
      "deadline exceeded",
    ],
    userMessage: "正在通过其他方式继续处理，请稍候...",
    retryable: true,
    fallbackToLLM: true,
  },
};

/**
 * Classify skill dispatch error based on output content
 */
export function classifySkillError(result: SkillDispatchResult, outputStr: string): ClassifiedSkillError | null {
  if (result.success) return null;

  const lower = outputStr.toLowerCase();

  for (const [category, config] of Object.entries(SKILL_ERROR_PATTERNS)) {
    if (config.patterns.some(p => lower.includes(p.toLowerCase()))) {
      return {
        category: category as ClassifiedSkillError["category"],
        userMessage: config.userMessage,
        shouldFallbackToLLM: config.fallbackToLLM,
        retryable: config.retryable,
      };
    }
  }

  // Unknown error — fallback to LLM
  return {
    category: "unknown",
    userMessage: result.error || "正在通过其他方式继续处理，请稍候...",
    shouldFallbackToLLM: true,
    retryable: false,
  };
}

/**
 * Check if skill output is essentially empty or meaningless
 */
export function isEmptySkillOutput(output: unknown): boolean {
  if (!output) return true;

  if (typeof output === "string") {
    const s = output.trim();
    return (
      s.length < 50 ||
      s.includes("no scripts defined") ||
      s.includes("executed successfully") ||
      s.includes("no results found") ||
      s.includes("nothing to report")
    );
  }

  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    const hasContent = obj.content || obj.text || obj.body || obj.data || obj.results;

    if (!hasContent && obj.message && typeof obj.message === "string") {
      const msg = obj.message.toLowerCase();
      return (
        msg.includes("no scripts defined") ||
        msg.includes("no results") ||
        msg.includes("nothing found")
      );
    }

    return !hasContent;
  }

  return false;
}

/**
 * Format skill dispatch result for user display
 */
export function formatSkillReply(result: SkillDispatchResult, outputStr: string): string {
  if (result.path === "skill" && result.success) {
    return `🎯 **技能调度**: \`${result.skillName}\`\n\n${outputStr}\n\n---\n<details><summary>📋 调度详情</summary>\n\n${result.reasoning}\n</details>`;
  }

  if (result.path === "web_search" && result.success) {
    return `🔍 **网页搜索**: \`${result.skillName}\`\n\n${outputStr}`;
  }

  return outputStr;
}

/**
 * Sanitize skill output by stripping web noise
 */
export function sanitizeSkillOutput(output: unknown): string {
  const stripWebNoise = (s: string): string => {
    // Remove common web noise patterns
    return s
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  };

  if (typeof output === "string") {
    return stripWebNoise(output);
  }

  if (typeof output === "object" && output !== null) {
    const obj = output as Record<string, unknown>;

    // Sanitize known fields
    for (const key of ["content", "text", "body", "snippet", "output"]) {
      if (typeof obj[key] === "string" && (obj[key] as string).length > 100) {
        obj[key] = stripWebNoise(obj[key] as string);
      }
    }

    // Sanitize results array
    if (Array.isArray(obj.results)) {
      for (const item of obj.results as Array<Record<string, unknown>>) {
        if (typeof item.snippet === "string" && (item.snippet as string).length > 100) {
          item.snippet = stripWebNoise(item.snippet as string);
        }
        if (typeof item.content === "string" && (item.content as string).length > 100) {
          item.content = stripWebNoise(item.content as string);
        }
      }
    }

    return JSON.stringify(output, null, 2);
  }

  return String(output);
}
