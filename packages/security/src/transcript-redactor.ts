// ── Transcript Redactor ──
// OpenClaw 6.6 引入: transcripts需要redaction, 防止敏感信息泄露
// 自动遮蔽: API keys, tokens, emails, phones, credit cards, private keys等

import { isUnsafeRegex } from "./safe-regex.js";

/** 遮蔽模式定义 */
export interface RedactionPattern {
  name: string;
  pattern: RegExp;
  severity: "low" | "medium" | "high" | "critical";
  /** 替换模板, $1为第一个捕获组 */
  replacement: string;
}

/** 自定义遮蔽规则 */
export interface CustomRedaction {
  name: string;
  /** 字面匹配 */
  literal?: string;
  /** 正则匹配 */
  pattern?: string;
  replacement: string;
  severity?: "low" | "medium" | "high" | "critical";
  enabled?: boolean;
}

/** 遮蔽配置 */
export interface RedactorConfig {
  enabled: boolean;
  customRules: CustomRedaction[];
  preserveLastChars?: number; // 保留最后N个字符(用于调试)
  preserveFirstChars?: number; // 保留开头N个字符
  replacementChar?: string; // 替换字符, 默认*
  maxRedactionsPerText?: number; // 防止ReDoS
  redactInPlace?: boolean; // 是否就地修改输入对象
}

/** 遮蔽结果 */
export interface RedactionResult {
  text: string;
  redactions: Array<{
    pattern: string;
    severity: string;
    count: number;
  }>;
  totalRedactions: number;
  originalLength: number;
  redactedLength: number;
}

/** 预置遮蔽模式 */
const DEFAULT_PATTERNS: RedactionPattern[] = [
  {
    name: "openai-api-key",
    pattern: /\b(sk-[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_-]{20,})\b/g,
    severity: "critical",
    replacement: "sk-***REDACTED***",
  },
  {
    name: "anthropic-api-key",
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g,
    severity: "critical",
    replacement: "sk-ant-***REDACTED***",
  },
  {
    name: "google-api-key",
    pattern: /\b(AIza[A-Za-z0-9_-]{35})\b/g,
    severity: "critical",
    replacement: "AIza***REDACTED***",
  },
  {
    name: "aws-access-key",
    pattern: /\b((?:AKIA|ASIA)[A-Z0-9]{16})\b/g,
    severity: "critical",
    replacement: "***AWS_KEY_REDACTED***",
  },
  {
    name: "aws-secret-key",
    pattern: /(aws_secret_access_key|aws_secret_key|AWS_SECRET)\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
    severity: "critical",
    replacement: "$1=***AWS_SECRET_REDACTED***",
  },
  {
    name: "github-token",
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{82,})\b/g,
    severity: "critical",
    replacement: "gh*_***REDACTED***",
  },
  {
    name: "slack-token",
    pattern: /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
    severity: "high",
    replacement: "xox*-***REDACTED***",
  },
  {
    name: "stripe-key",
    pattern: /\b((?:sk|pk|rk)_(?:test|live)?_[A-Za-z0-9]{20,})\b/g,
    severity: "critical",
    replacement: "$1_***REDACTED***",
  },
  {
    name: "private-key-block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    severity: "critical",
    replacement: "***PRIVATE_KEY_REDACTED***",
  },
  {
    name: "jwt-token",
    pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    severity: "high",
    replacement: "***JWT_REDACTED***",
  },
  {
    name: "bearer-token",
    pattern: /(Bearer|Authorization:\s*Bearer)\s+([A-Za-z0-9_\-\.=]{20,})/gi,
    severity: "high",
    replacement: "$1 ***TOKEN_REDACTED***",
  },
  {
    name: "email",
    pattern: /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,})\b/g,
    severity: "medium",
    replacement: "***EMAIL_REDACTED***",
  },
  {
    name: "phone-cn",
    pattern: /\b(1[3-9]\d{9})\b/g,
    severity: "medium",
    replacement: "***PHONE_REDACTED***",
  },
  {
    name: "phone-intl",
    pattern: /\b(\+\d{1,3}[\s-]?)?\(?\d{3,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{4}\b/g,
    severity: "low",
    replacement: "***PHONE_REDACTED***",
  },
  {
    name: "credit-card",
    pattern: /\b(?:\d[ -]?){13,16}\b/g,
    severity: "critical",
    replacement: "***CARD_REDACTED***",
  },
  {
    name: "ssn",
    pattern: /\b(\d{3}-\d{2}-\d{4})\b/g,
    severity: "critical",
    replacement: "***SSN_REDACTED***",
  },
  {
    name: "ipv4-private",
    pattern: /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b/g,
    severity: "low",
    replacement: "***INTERNAL_IP_REDACTED***",
  },
  {
    name: "connection-string",
    pattern: /((?:postgres|mysql|mongodb|redis)(?:\+[a-z]+)?:\/\/)[^:]+:[^@]+@[^\s"']+/gi,
    severity: "critical",
    replacement: "$1***CREDENTIALS***@***HOST***",
  },
  {
    name: "env-secret",
    pattern: /\b((?:API_KEY|SECRET|PASSWORD|PRIVATE_KEY|PASSPHRASE|ACCESS_KEY))\s*[=:]\s*["']?([^\s"':]{8,})["']?/gi,
    severity: "high",
    replacement: "$1=***REDACTED***",
  },
];

/**
 * TranscriptRedactor
 * 多次执行模式匹配, 防止ReDoS
 * 限制最大匹配次数, 避免极端输入
 */
export class TranscriptRedactor {
  private config: Required<RedactorConfig>;
  private patterns: RedactionPattern[];
  private disabledRules = new Set<string>();
  private auditLog: Array<{ text: string; redactions: RedactionResult["redactions"]; totalRedactions: number; timestamp: number }> = [];
  private stats = {
    totalRedactions: 0,
    byPattern: new Map<string, number>(),
    bySeverity: new Map<string, number>(),
    textsProcessed: 0,
  };

  constructor(config: Partial<RedactorConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      customRules: config.customRules ?? [],
      preserveLastChars: config.preserveLastChars ?? 0,
      preserveFirstChars: config.preserveFirstChars ?? 0,
      replacementChar: config.replacementChar ?? "*",
      maxRedactionsPerText: config.maxRedactionsPerText ?? 1000,
      redactInPlace: config.redactInPlace ?? false,
    };
    this.patterns = [...DEFAULT_PATTERNS];
    // 编译自定义规则
    for (const rule of this.config.customRules) {
      if (rule.enabled === false) continue;
      if (rule.pattern) {
        if (isUnsafeRegex(rule.pattern)) {
          process.stderr.write(`[Security] Skipping unsafe regex pattern in transcript redactor: ${rule.pattern}\n`);
          continue;
        }
        try {
          this.patterns.push({
            name: rule.name,
            pattern: new RegExp(rule.pattern, "g"),
            severity: rule.severity ?? "medium",
            replacement: rule.replacement,
          });
        } catch {
          // 忽略无效正则
        }
      } else if (rule.literal) {
        const escaped = rule.literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        this.patterns.push({
          name: rule.name,
          pattern: new RegExp(escaped, "g"),
          severity: rule.severity ?? "medium",
          replacement: rule.replacement,
        });
      }
    }
  }

  /** 遮蔽文本 */
  redact(text: string): RedactionResult {
    if (!this.config.enabled || !text) {
      return {
        text,
        redactions: [],
        totalRedactions: 0,
        originalLength: text?.length ?? 0,
        redactedLength: text?.length ?? 0,
      };
    }
    this.stats.textsProcessed++;
    let result = text;
    const redactionMap = new Map<string, { count: number; severity: string }>();
    let total = 0;

    for (const p of this.patterns) {
      if (total >= this.config.maxRedactionsPerText) break;
      // Skip disabled rules
      if (this.disabledRules.has(p.name)) continue;
      // 每次重置lastIndex以避免lastIndex状态问题
      p.pattern.lastIndex = 0;
      const matches = result.match(p.pattern);
      if (matches && matches.length > 0) {
        // 记录替换前的总数, 以计算本模式实际替换次数
        // (maxRedactionsPerText 可能在 replace 回调中途触发, 实际替换数可能小于 matches.length)
        const before = total;
        // 避免无限循环: 防止替换后还能再次匹配
        result = result.replace(p.pattern, (match, ...args) => {
          if (total >= this.config.maxRedactionsPerText) return match;
          total++;
          // args: [group1, group2, ..., offset, string] 或
          //       [group1, group2, ..., offset, string, namedGroups]
          // 当存在命名捕获组时，最后一个元素是 groups 对象，需要多切一个。
          const hasNamedGroups = typeof args[args.length - 1] === "object" && args[args.length - 1] !== null;
          const cutCount = hasNamedGroups ? 3 : 2;
          const groups = [match, ...args.slice(0, -cutCount)];
          return this.applyReplacement(p, match, groups);
        });
        const actualCount = total - before;
        if (actualCount > 0) {
          redactionMap.set(p.name, { count: actualCount, severity: p.severity });
          this.stats.totalRedactions += actualCount;
          this.stats.byPattern.set(p.name, (this.stats.byPattern.get(p.name) ?? 0) + actualCount);
          this.stats.bySeverity.set(p.severity, (this.stats.bySeverity.get(p.severity) ?? 0) + actualCount);
        }
      }
    }
    const redactions = Array.from(redactionMap.entries()).map(([pattern, info]) => ({
      pattern,
      severity: info.severity,
      count: info.count,
    }));
    // Record audit entry
    if (redactions.length > 0) {
      this.auditLog.push({
        text: result.slice(0, 200),
        redactions,
        totalRedactions: total,
        timestamp: Date.now(),
      });
      if (this.auditLog.length > 1000) {
        const dropped = this.auditLog.length - 1000;
        process.stderr.write(`[TranscriptRedactor] auditLog overflow: dropped ${dropped} oldest entries\n`);
        this.auditLog = this.auditLog.slice(-1000);
      }
    }
    return {
      text: result,
      redactions,
      totalRedactions: total,
      originalLength: text.length,
      redactedLength: result.length,
    };
  }

  /** 遮蔽对象(递归) */
  redactObject<T = unknown>(obj: T): T {
    if (!this.config.enabled) return obj;
    // 安全：使用 visited Set 检测循环引用，防止栈溢出 DoS
    return this.redactObjectInternal(obj, new WeakSet<object>()) as T;
  }

  private redactObjectInternal(obj: unknown, visited: WeakSet<object>): unknown {
    if (typeof obj === "string") {
      return this.redact(obj).text;
    }
    if (Array.isArray(obj)) {
      // 数组不放入 visited（数组循环引用罕见且 WeakSet 键须为 object）
      return obj.map((item) => this.redactObjectInternal(item, visited));
    }
    if (obj && typeof obj === "object") {
      if (visited.has(obj as object)) {
        return "[Circular]";
      }
      visited.add(obj as object);
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = this.redactObjectInternal(v, visited);
      }
      return result;
    }
    return obj;
  }

  /** 应用替换 */
  private applyReplacement(pattern: RedactionPattern, match: string, groups?: string[]): string {
    // 如果pattern有显式的$捕获组语法, 用捕获组构造
    if (/\$[1-9]/.test(pattern.replacement) && groups && groups.length > 1) {
      return pattern.replacement.replace(/\$(\d+)/g, (_, idx) => groups[parseInt(idx, 10)] ?? "");
    }
    // 否则直接使用replacement
    return pattern.replacement;
  }

  /** 统计信息 */
  getStats() {
    return {
      ...this.stats,
      byPattern: Object.fromEntries(this.stats.byPattern),
      bySeverity: Object.fromEntries(this.stats.bySeverity),
    };
  }

  /** 重置统计 */
  resetStats(): void {
    this.stats = {
      totalRedactions: 0,
      byPattern: new Map(),
      bySeverity: new Map(),
      textsProcessed: 0,
    };
  }

  /** 添加自定义规则 */
  addRule(rule: CustomRedaction): void {
    if (rule.enabled === false) return;
    if (rule.pattern) {
      if (isUnsafeRegex(rule.pattern)) {
        process.stderr.write(`[Security] Skipping unsafe regex pattern in transcript redactor: ${rule.pattern}\n`);
        return;
      }
      try {
        this.patterns.push({
          name: rule.name,
          pattern: new RegExp(rule.pattern, "g"),
          severity: rule.severity ?? "medium",
          replacement: rule.replacement,
        });
      } catch { /* ignore */ }
    } else if (rule.literal) {
      const escaped = rule.literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      this.patterns.push({
        name: rule.name,
        pattern: new RegExp(escaped, "g"),
        severity: rule.severity ?? "medium",
        replacement: rule.replacement,
      });
    }
  }

  /** 获取所有规则及其启用状态 */
  getRules(): Array<RedactionPattern & { enabled: boolean }> {
    return this.patterns.map((p) => ({
      ...p,
      enabled: !this.disabledRules.has(p.name),
    }));
  }

  /** 切换规则启用/禁用 */
  toggleRule(name: string, enabled?: boolean): boolean {
    const rule = this.patterns.find((p) => p.name === name);
    if (!rule) return false;
    if (enabled === false || (enabled === undefined && !this.disabledRules.has(name))) {
      this.disabledRules.add(name);
    } else {
      this.disabledRules.delete(name);
    }
    return true;
  }

  /** 获取审计日志 */
  getAuditLog(limit = 100): Array<{ text: string; redactions: RedactionResult["redactions"]; totalRedactions: number; timestamp: number }> {
    return this.auditLog.slice(-limit);
  }
}
