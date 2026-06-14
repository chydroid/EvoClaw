/**
 * Content Safety Guard — input sanitization, output filtering,
 * PII detection, harmful content detection, and compliance enforcement.
 *
 * Features:
 *  - Input sanitization (XSS, SQL injection, prompt injection patterns)
 *  - PII detection (email, phone, SSN, credit card, addresses, API keys)
 *  - Harmful content detection (violence, hate speech, self-harm, illegal)
 *  - Output guardrails (prevent sensitive data leaks)
 *  - Content rating classification
 *  - GDPR/CCPA compliance helpers
 *  - Rule-based and pattern-based detection
 */

// ── Types ─────────────────────────────────────────────────

export type SafetyLevel = "safe" | "caution" | "flagged" | "blocked";

export interface ContentCheckResult {
  /** Overall safety level */
  level: SafetyLevel;
  /** Whether content passed all checks */
  passed: boolean;
  /** Individual check results */
  checks: Array<{
    rule: string;
    passed: boolean;
    matches: string[];
    severity: "low" | "medium" | "high" | "critical";
  }>;
  /** Sanitized version of the content (if sanitization applied) */
  sanitized?: string;
  /** Detected PII types */
  piiDetected: string[];
  /** Detailed findings */
  findings: string[];
  /** Timestamp */
  checkedAt: number;
}

export interface PIIMatch {
  type: string;
  value: string; // Redacted version
  start: number;
  end: number;
  confidence: number; // 0-1
}

export interface ContentGuardConfig {
  /** Whether to enable input sanitization */
  sanitizeInput?: boolean;
  /** Whether to block on PII detection */
  blockOnPII?: boolean;
  /** Whether to block on harmful content */
  blockOnHarmful?: boolean;
  /** Minimum safety level to pass */
  minSafetyLevel?: SafetyLevel;
  /** Custom blocked terms */
  blockedTerms?: string[];
  /** Custom allowed terms (whitelist) */
  allowedTerms?: string[];
  /** Maximum content length before truncation */
  maxContentLength?: number;
}

// ── PII Patterns ─────────────────────────────────────────

const PII_PATTERNS: Array<{ type: string; pattern: RegExp; severity: "high" | "critical"; description: string }> = [
  // Email
  {
    type: "email",
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    severity: "high",
    description: "Email address detected",
  },
  // Phone numbers (international and US)
  {
    type: "phone",
    pattern: /(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g,
    severity: "high",
    description: "Phone number detected",
  },
  // SSN
  {
    type: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    severity: "critical",
    description: "Social Security Number detected",
  },
  // Credit Card
  {
    type: "credit_card",
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    severity: "critical",
    description: "Credit card number detected",
  },
  // API Keys (common patterns)
  {
    type: "api_key",
    pattern: /(?:sk-[a-zA-Z0-9-]{32,}|(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}|AIza[0-9A-Za-z_-]{35,}|xox[bpras]-[a-zA-Z0-9-]+)/g,
    severity: "critical",
    description: "API key/token detected",
  },
  // AWS keys
  {
    type: "aws_key",
    pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
    severity: "critical",
    description: "AWS access key detected",
  },
  // IP Addresses
  {
    type: "ip_address",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    severity: "high",
    description: "IP address detected",
  },
  // JWT tokens
  {
    type: "jwt",
    pattern: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
    severity: "high",
    description: "JWT token detected",
  },
  // Passport numbers
  {
    type: "passport",
    pattern: /\b[A-Z]{1,2}\d{6,8}\b/g,
    severity: "high",
    description: "Possible passport number detected",
  },
  // Private keys
  {
    type: "private_key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    severity: "critical",
    description: "Private key detected",
  },
];

// ── Harmful Content Patterns ──────────────────────────────

const HARMFUL_PATTERNS: Array<{ type: string; pattern: RegExp | string; severity: "high" | "critical"; description: string }> = [
  // Self-harm
  {
    type: "self_harm",
    pattern: /(?:suicide|self[- ]?harm|kill myself|end my life|want to die)/i,
    severity: "critical",
    description: "Self-harm or suicidal content",
  },
  // Violence threats
  {
    type: "violence",
    pattern: /(?:kill (?:you|them|everyone|all)|bomb|shoot|massacre|terrorist)/i,
    severity: "critical",
    description: "Violent threats or content",
  },
  // Hate speech
  {
    type: "hate_speech",
    pattern: /(?:racist|nazi|hate (?:crime|speech)|supremacist|racial slur)/i,
    severity: "critical",
    description: "Hate speech detected",
  },
  // CSAM indicators
  {
    type: "csam",
    pattern: /(?:child (?:porn|abuse|exploitation)|CSAM|underage)/i,
    severity: "critical",
    description: "Child safety concern",
  },
  // Illegal activities
  {
    type: "illegal",
    pattern: /(?:how to (?:hack|crack|steal|launder|traffic)|malware|ransomware|phishing site|dark.?web)/i,
    severity: "high",
    description: "Illegal activity reference",
  },
  // Doxxing
  {
    type: "doxxing",
    pattern: /(?:home address|live at|works at|phone number is|social security)/i,
    severity: "critical",
    description: "Potential doxxing content",
  },
];

// ── Input Sanitization Patterns ───────────────────────────

const SANITIZATION_PATTERNS: Array<{ pattern: RegExp; replacement: string; description: string }> = [
  // XSS - script tags
  { pattern: /<script[\s\S]*?>[\s\S]*?<\/script>/gi, replacement: "[filtered:script]", description: "XSS script tag" },
  // XSS - event handlers
  { pattern: /\s+on\w+\s*=\s*["'][^"']*["']/gi, replacement: " [filtered:handler]", description: "XSS event handler" },
  // SQL injection patterns
  { pattern: /(?:\b(?:DROP|DELETE|TRUNCATE|ALTER)\s+(?:TABLE|DATABASE|INDEX)\b)/gi, replacement: "[filtered:sql]", description: "SQL injection" },
  // Path traversal
  { pattern: /\.\.\/\.\.\//gi, replacement: "./", description: "Path traversal" },
  // Null byte injection
  { pattern: /\0/g, replacement: "", description: "Null byte injection" },
  // HTML entities for XSS
  { pattern: /&#x?[0-9a-f]+;/gi, replacement: "", description: "HTML entity XSS" },
];

// ── Content Safety Guard ──────────────────────────────────

export class ContentGuard {
  private config: Required<Omit<ContentGuardConfig, "blockedTerms" | "allowedTerms">> & {
    blockedTerms: string[];
    allowedTerms: string[];
  };

  constructor(config: ContentGuardConfig = {}) {
    this.config = {
      sanitizeInput: config.sanitizeInput ?? true,
      blockOnPII: config.blockOnPII ?? true,
      blockOnHarmful: config.blockOnHarmful ?? true,
      minSafetyLevel: config.minSafetyLevel ?? "caution",
      blockedTerms: config.blockedTerms ?? [],
      allowedTerms: config.allowedTerms ?? [],
      maxContentLength: config.maxContentLength ?? 100_000,
    };
  }

  // ── Full Content Check ──────────────────────────────────

  /**
   * Run complete safety check on content.
   * Checks PII, harmful content, blocked terms, and sanitization.
   */
  check(content: string): ContentCheckResult {
    const checks: ContentCheckResult["checks"] = [];
    const findings: string[] = [];
    const piiDetected: string[] = [];
    let sanitized: string | undefined;

    // Truncate overlong content
    if (content.length > this.config.maxContentLength) {
      const originalLength = content.length;
      content = content.slice(0, this.config.maxContentLength);
      findings.push(`Content truncated from ${originalLength} chars`);
    }

    // Sanitize input
    if (this.config.sanitizeInput) {
      const sanitizeResult = this.sanitize(content);
      if (sanitizeResult.sanitized !== content) {
        sanitized = sanitizeResult.sanitized;
        content = sanitizeResult.sanitized;
        checks.push({
          rule: "sanitization",
          passed: sanitizeResult.matchCount === 0,
          matches: sanitizeResult.matches,
          severity: sanitizeResult.matchCount > 5 ? "high" : "medium",
        });
        findings.push(`Sanitized ${sanitizeResult.matchCount} patterns`);
      }
    }

    // Check PII
    const piiResult = this.detectPII(content);
    piiDetected.push(...piiResult.types);
    checks.push({
      rule: "pii_detection",
      passed: !this.config.blockOnPII || piiResult.matches.length === 0,
      matches: piiResult.matches.map((m) => m.type),
      severity: piiResult.matches.some((m) => m.confidence > 0.9) ? "critical" : "high",
    });
    if (piiResult.matches.length > 0) {
      findings.push(`Detected PII: ${piiResult.types.join(", ")}`);
    }

    // Check harmful content
    const harmfulResult = this.detectHarmful(content);
    checks.push({
      rule: "harmful_content",
      passed: !this.config.blockOnHarmful || harmfulResult.matches.length === 0,
      matches: harmfulResult.matches.map((m) => m.type),
      severity: harmfulResult.matches.length > 0 ? "critical" : "low",
    });
    if (harmfulResult.matches.length > 0) {
      findings.push(`Harmful content detected: ${harmfulResult.matches.map((m) => m.type).join(", ")}`);
    }

    // Check blocked terms
    const blockedResult = this.checkBlockedTerms(content);
    checks.push({
      rule: "blocked_terms",
      passed: blockedResult.length === 0,
      matches: blockedResult,
      severity: blockedResult.length > 0 ? "high" : "low",
    });

    // Determine safety level
    const hasCritical = checks.some((c) => !c.passed && c.severity === "critical");
    const hasHigh = checks.some((c) => !c.passed && c.severity === "high");
    const hasMedium = checks.some((c) => !c.passed && c.severity === "medium");

    let level: SafetyLevel;
    if (hasCritical) level = "blocked";
    else if (hasHigh) level = "flagged";
    else if (hasMedium) level = "caution";
    else level = "safe";

    const safetyOrder: SafetyLevel[] = ["blocked", "flagged", "caution", "safe"];
    const passed = safetyOrder.indexOf(level) >= safetyOrder.indexOf(this.config.minSafetyLevel);

    return {
      level,
      passed,
      checks,
      sanitized,
      piiDetected,
      findings,
      checkedAt: Date.now(),
    };
  }

  /**
   * Quick pre-check before processing.
   * Returns true if content appears safe enough for immediate handling.
   */
  quickCheck(content: string): boolean {
    const criticalPII = PII_PATTERNS.filter((p) => p.severity === "critical");
    for (const pattern of criticalPII) {
      if (pattern.pattern.test(content)) return false;
    }

    for (const harmful of HARMFUL_PATTERNS) {
      if (harmful.severity === "critical" && typeof harmful.pattern === "object") {
        if ((harmful.pattern as RegExp).test(content)) return false;
      }
    }

    return true;
  }

  // ── PII Detection ───────────────────────────────────────

  /**
   * Detect Personally Identifiable Information in content.
   * Returns matches with positions and confidence levels.
   */
  detectPII(content: string): { matches: PIIMatch[]; types: string[] } {
    const matches: PIIMatch[] = [];
    const types = new Set<string>();

    for (const rule of PII_PATTERNS) {
      let match: RegExpExecArray | null;
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags);

      while ((match = regex.exec(content)) !== null) {
        const value = match[0];
        // Filter false positives for IP addresses
        if (rule.type === "ip_address") {
          const parts = value.split(".").map(Number);
          if (parts.some((p: number) => p > 255)) continue;
          // Exclude common private IPs if they look like version numbers
          if (parts[0] === 127 || parts[0] === 0) continue;
        }

        matches.push({
          type: rule.type,
          value: this.redact(value, rule.type),
          start: match.index,
          end: match.index + value.length,
          confidence: rule.type === "email" || rule.type === "ssn" || rule.type === "credit_card" ? 0.95 : 0.8,
        });
        types.add(rule.type);
      }
    }

    return { matches, types: Array.from(types) };
  }

  /** Redact PII from content, replacing with type indicators */
  redactPII(content: string): string {
    let result = content;
    const matches = this.detectPII(content).matches;

    // Sort by position descending to avoid offset issues
    matches.sort((a, b) => b.start - a.start);

    for (const match of matches) {
      const prefix = result.slice(0, match.start);
      const suffix = result.slice(match.end);
      result = prefix + `[REDACTED:${match.type}]` + suffix;
    }

    return result;
  }

  // ── Harmful Content Detection ───────────────────────────

  detectHarmful(content: string): { matches: Array<{ type: string; description: string }> } {
    const matches: Array<{ type: string; description: string }> = [];

    for (const rule of HARMFUL_PATTERNS) {
      if (typeof rule.pattern === "string") {
        if (content.toLowerCase().includes(rule.pattern.toLowerCase())) {
          matches.push({ type: rule.type, description: rule.description });
        }
      } else {
        if (rule.pattern.test(content)) {
          matches.push({ type: rule.type, description: rule.description });
        }
      }
    }

    return { matches };
  }

  // ── Sanitization ────────────────────────────────────────

  /** Sanitize content to neutralize XSS, SQL injection, etc. */
  sanitize(content: string): { sanitized: string; matchCount: number; matches: string[] } {
    let result = content;
    let matchCount = 0;
    const matchedDescs: string[] = [];

    for (const rule of SANITIZATION_PATTERNS) {
      const before = result.length;
      result = result.replace(rule.pattern, rule.replacement);
      if (result.length !== before) {
        matchCount++;
        matchedDescs.push(rule.description);
      }
    }

    return { sanitized: result, matchCount, matches: matchedDescs };
  }

  // ── Blocked Terms ───────────────────────────────────────

  checkBlockedTerms(content: string): string[] {
    if (this.config.blockedTerms.length === 0) return [];

    const matches: string[] = [];
    const lowerContent = content.toLowerCase();

    for (const term of this.config.blockedTerms) {
      if (lowerContent.includes(term.toLowerCase())) {
        // Check if term is whitelisted
        const isAllowed = this.config.allowedTerms.some(
          (allowed) => lowerContent.includes(allowed.toLowerCase())
        );
        if (!isAllowed) {
          matches.push(term);
        }
      }
    }

    return matches;
  }

  // ── Output Guardrails ───────────────────────────────────

  /**
   * Filter agent output to prevent sensitive information leaks.
   * Ensures the agent doesn't reveal system prompts, secrets, or PII.
   */
  filterOutput(output: string): {
    safe: boolean;
    filtered: string;
    blocks: string[];
  } {
    const blocks: string[] = [];
    let filtered = output;

    // Check for system prompt leakage
    const systemPromptIndicators = [
      /system prompt/i,
      /your instructions are/i,
      /I am an AI assistant (?:created|developed|built)/i,
      /my system message says/i,
      /according to my instructions/i,
    ];

    for (const indicator of systemPromptIndicators) {
      if (indicator.test(output)) {
        blocks.push("system_prompt_leak");
        filtered = filtered.replace(indicator, "[filtered]");
      }
    }

    // Check for secret leakage
    const secretCheck = this.detectPII(output);
    if (secretCheck.matches.length > 0) {
      blocks.push("pii_in_output");
      filtered = this.redactPII(filtered);
    }

    return {
      safe: blocks.length === 0,
      filtered,
      blocks,
    };
  }

  // ── Content Rating ──────────────────────────────────────

  /**
   * Rate content safety level (0-100, higher = safer).
   */
  rateContent(content: string): { score: number; rating: SafetyLevel } {
    const check = this.check(content);

    let score = 100;

    // Deduct for PII
    if (check.piiDetected.length > 0) {
      score -= check.piiDetected.length * 20;
    }

    // Deduct for harmful content
    const harmfulChecks = check.checks.filter((c) => c.rule === "harmful_content");
    if (harmfulChecks.length > 0 && harmfulChecks[0].matches.length > 0) {
      score -= harmfulChecks[0].matches.length * 30;
    }

    // Deduct for blocked terms
    const blockedChecks = check.checks.filter((c) => c.rule === "blocked_terms");
    if (blockedChecks.length > 0 && blockedChecks[0].matches.length > 0) {
      score -= blockedChecks[0].matches.length * 25;
    }

    score = Math.max(0, Math.min(100, score));

    let rating: SafetyLevel;
    if (score >= 80) rating = "safe";
    else if (score >= 50) rating = "caution";
    else if (score >= 20) rating = "flagged";
    else rating = "blocked";

    return { score, rating };
  }

  // ── GDPR / CCPA Helpers ─────────────────────────────────

  /**
   * Check if content contains GDPR-relevant personal data.
   */
  checkGDPR(content: string): {
    hasPersonalData: boolean;
    dataCategories: string[];
    requiresConsent: boolean;
    dataSubjectRequest: boolean;
  } {
    const pii = this.detectPII(content);
    const categories = pii.types;

    // Check if it's a data subject access request
    const isDSAR = /(?:delete|remove|export|access|download).*(?:my|personal).*(?:data|information)/i.test(content) ||
      /(?:GDPR|CCPA|data subject|right to (?:access|deletion|portability))/i.test(content);

    return {
      hasPersonalData: categories.length > 0,
      dataCategories: categories,
      requiresConsent: categories.includes("email") || categories.includes("phone"),
      dataSubjectRequest: isDSAR,
    };
  }

  // ── Management ──────────────────────────────────────────

  /** Add custom blocked term */
  addBlockedTerm(term: string): void {
    if (!this.config.blockedTerms.includes(term)) {
      this.config.blockedTerms.push(term);
    }
  }

  /** Remove blocked term */
  removeBlockedTerm(term: string): void {
    this.config.blockedTerms = this.config.blockedTerms.filter((t) => t !== term);
  }

  /** Add custom allowed term (whitelist) */
  addAllowedTerm(term: string): void {
    if (!this.config.allowedTerms.includes(term)) {
      this.config.allowedTerms.push(term);
    }
  }

  /** Get all safety rules and their descriptions */
  getRules(): Array<{ name: string; description: string; active: boolean }> {
    return [
      { name: "pii_detection", description: "PII/Personal data detection", active: this.config.blockOnPII },
      { name: "harmful_content", description: "Harmful content detection", active: this.config.blockOnHarmful },
      { name: "sanitization", description: "Input sanitization (XSS/SQLi)", active: this.config.sanitizeInput },
      { name: "blocked_terms", description: "Custom blocked terms", active: this.config.blockedTerms.length > 0 },
    ];
  }

  // ── Internal ────────────────────────────────────────────

  private redact(value: string, type: string): string {
    switch (type) {
      case "email": return value.replace(/(.{2}).*(@.*)/, "$1***$2");
      case "phone": return value.replace(/(.{3}).*(.{4})/, "$1****$2");
      case "ssn": return "***-**-****";
      case "credit_card": return "****-****-****-" + value.slice(-4);
      case "api_key": return value.slice(0, 6) + "..." + value.slice(-4);
      case "private_key": return "[REDACTED PRIVATE KEY]";
      default: return "[REDACTED]";
    }
  }
}