// EvoClaw Guardrails System — Three-layer safety gate (input / output / tool)
// Inspired by OpenClaw 2026.4.5 & OpenAI Agents SDK guardrails

// ─── Severity & Action Types ────────────────────────────────────────────────

export type Severity = "low" | "medium" | "high";

export type GuardrailAction = "log" | "warn" | "sanitize" | "block";

// ─── Result ─────────────────────────────────────────────────────────────────

export interface GuardrailResult {
  /** Whether the input/output/tool-call passed all checks */
  passed: boolean;
  /** Highest severity triggered (undefined when passed === true) */
  severity?: Severity;
  /** Human-readable reason for the failure */
  reason?: string;
  /** Sanitized version of the input (only when action is "sanitize") */
  sanitizedInput?: string;
  /** Sanitized version of the output (only when action is "sanitize") */
  sanitizedOutput?: string;
  /** Sanitized version of tool args (only when action is "sanitize") */
  sanitizedArgs?: Record<string, unknown>;
  /** Which rule IDs were triggered */
  triggeredRules?: string[];
}

// ─── Rule Definitions ───────────────────────────────────────────────────────

export interface InputRule {
  id: string;
  pattern: RegExp;
  severity: Severity;
  action: GuardrailAction;
  description: string;
}

export interface OutputRule {
  id: string;
  pattern: RegExp;
  severity: Severity;
  action: GuardrailAction;
  description: string;
}

export interface ToolRule {
  id: string;
  toolPattern: RegExp;
  argPattern: RegExp;
  severity: Severity;
  action: GuardrailAction;
  description: string;
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface GuardrailConfig {
  inputRules?: InputRule[];
  outputRules?: OutputRule[];
  toolRules?: ToolRule[];
  defaultSeverity: Severity;
  enabled: boolean;
  /** Per-layer on/off toggles */
  inputEnabled?: boolean;
  outputEnabled?: boolean;
  toolEnabled?: boolean;
}

// ─── Statistics ─────────────────────────────────────────────────────────────

export interface GuardrailStats {
  input:  { pass: number; warn: number; block: number };
  output: { pass: number; warn: number; block: number };
  tool:   { pass: number; warn: number; block: number };
}

// ─── Built-in Input Rules ───────────────────────────────────────────────────

const BUILTIN_INPUT_RULES: InputRule[] = [
  // Prompt injection
  {
    id: "inj-ignore-previous",
    pattern: /ignore\s+(all\s+)?previous\s+(instructions?|prompts?|rules?|directions?)/i,
    severity: "high",
    action: "block",
    description: "Prompt injection: ignore previous instructions",
  },
  {
    id: "inj-system-prompt-extraction",
    pattern: /(reveal|show|display|print|output|repeat|write)\s+(your|the|system)\s+(original|initial|system)\s+(prompt|instructions?|message)/i,
    severity: "high",
    action: "block",
    description: "Prompt injection: system prompt extraction",
  },
  {
    id: "inj-role-override",
    pattern: /you\s+are\s+now\s+(a\s+)?(DAN|evil|malicious|unrestricted|uncensored|jailbroken)/i,
    severity: "high",
    action: "block",
    description: "Prompt injection: role override",
  },
  {
    id: "inj-sudo-mode",
    pattern: /(sudo|developer|admin)\s+mode/i,
    severity: "high",
    action: "block",
    description: "Prompt injection: sudo/developer mode",
  },
  {
    id: "inj-simulate",
    pattern: /simulate\s+(an?\s+)?(AI|language\s+model|LLM)\s+(that|which|without)/i,
    severity: "medium",
    action: "warn",
    description: "Prompt injection: simulated AI without restrictions",
  },

  // PII leakage
  {
    id: "pii-email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    severity: "medium",
    action: "sanitize",
    description: "PII: email address detected",
  },
  {
    id: "pii-phone",
    pattern: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
    severity: "medium",
    action: "sanitize",
    description: "PII: phone number detected",
  },
  {
    id: "pii-ssn",
    pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/,
    severity: "high",
    action: "sanitize",
    description: "PII: SSN pattern detected",
  },
  {
    id: "pii-credit-card",
    pattern: /\b(?:\d[ -]*?){13,19}\b/,
    severity: "high",
    action: "sanitize",
    description: "PII: credit card number pattern",
  },

  // Harmful content
  {
    id: "harm-violence",
    pattern: /\b(kill|murder|assassinate|massacre|torture|mutilate|bomb|shoot|stab)\s+(someone|people|person|him|her|them|a\s+\w+)?/i,
    severity: "high",
    action: "block",
    description: "Harmful content: violence",
  },
  {
    id: "harm-self-harm",
    pattern: /\b(suicide|kill\s+myself|self[- ]?harm|end\s+my\s+life|hurt\s+myself)\b/i,
    severity: "high",
    action: "block",
    description: "Harmful content: self-harm",
  },
  {
    id: "harm-weapon",
    pattern: /\bhow\s+to\s+(make|build|create|manufacture)\s+(a\s+)?(bomb|weapon|gun|explosive|poison)/i,
    severity: "high",
    action: "block",
    description: "Harmful content: weapon manufacturing",
  },

  // Indirect injection via markdown images
  {
    id: "injection-markdown-image",
    pattern: /!\[.*?\]\(https?:\/\/[^\s)]+\?[^\s)]*\w/gi,
    severity: "high",
    action: "block",
    description: "Markdown image exfiltration attempt",
  },
  // Base64 encoded injection
  {
    id: "injection-base64",
    pattern: /(?:[A-Za-z0-9+/]{40,}={0,2})/g,
    severity: "medium",
    action: "warn",
    description: "Potential base64-encoded injection",
  },
  // Chinese injection variants
  {
    id: "injection-chinese",
    pattern: /(?:忽略(?:之前|之上|以上)的[指令说明]|假装[你是]|你(?:现在|如今)是|不要[遵守遵循]|绕过[安全限制]|解除[限制模式])/gi,
    severity: "high",
    action: "block",
    description: "Chinese prompt injection attempt",
  },
  // Developer mode bypass
  {
    id: "injection-dev-mode",
    pattern: /(?:developer\s*mode|debug\s*mode|maintenance\s*mode|god\s*mode|admin\s*mode|root\s*access|jailbreak|DAN\s*mode)/gi,
    severity: "high",
    action: "block",
    description: "Developer/debug mode bypass attempt",
  },
];

// ─── Built-in Output Rules ──────────────────────────────────────────────────

const BUILTIN_OUTPUT_RULES: OutputRule[] = [
  // Hallucinated URLs
  {
    id: "out-hallucinated-url",
    pattern: /https?:\/\/[^\s"'<>]+\.(internal|local|localhost|corp|intra)[^\s"'<>]*/i,
    severity: "medium",
    action: "sanitize",
    description: "Output: hallucinated internal URL",
  },
  {
    id: "out-suspicious-url",
    pattern: /https?:\/\/[^\s"'<>]*?(?:free|prize|winner|claim|verify|account)[^\s"'<>]*/i,
    severity: "medium",
    action: "warn",
    description: "Output: suspicious/phishing URL pattern",
  },

  // Leaked system prompts
  {
    id: "out-system-prompt-leak",
    pattern: /you\s+are\s+(EvoClaw|an?\s+AI\s+assistant)\s+(that|who|designed|built)/i,
    severity: "high",
    action: "sanitize",
    description: "Output: system prompt leak",
  },
  {
    id: "out-instruction-leak",
    pattern: /(?:your|the)\s+(?:instructions?|system\s+prompt|rules?|guidelines?)\s+(?:are|is|state|say|require)/i,
    severity: "high",
    action: "sanitize",
    description: "Output: instruction/system prompt reference leak",
  },

  // Harmful content in output
  {
    id: "out-harm-violence",
    pattern: /\b(step[- ]by[- ]step|detailed|instructions?\s+for)\s+(making|building|creating|manufacturing)\s+(a\s+)?(bomb|weapon|explosive|poison)/i,
    severity: "high",
    action: "block",
    description: "Output: harmful instructions (violence/weapon)",
  },
  {
    id: "out-harm-illegal",
    pattern: /\bhow\s+to\s+(hack|steal|forge|counterfeit|launder|traffic)/i,
    severity: "high",
    action: "block",
    description: "Output: illegal activity instructions",
  },

  // Output PII detection
  {
    id: "output-pii-email",
    pattern: /[\w.+-]+@[\w-]+\.[\w.]+/g,
    severity: "medium",
    action: "sanitize",
    description: "PII: email address in output",
  },
  {
    id: "output-pii-phone",
    pattern: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
    severity: "medium",
    action: "sanitize",
    description: "PII: phone number in output",
  },
  {
    id: "output-pii-ssn",
    pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
    severity: "high",
    action: "sanitize",
    description: "PII: SSN in output",
  },
];

// ─── Built-in Tool Rules ────────────────────────────────────────────────────

const BUILTIN_TOOL_RULES: ToolRule[] = [
  // Dangerous tool arguments
  {
    id: "tool-file-deletion",
    toolPattern: /(?:delete|remove|unlink|rm|truncate|wipe|destroy)/i,
    argPattern: /./, // any args — the tool name itself is dangerous
    severity: "high",
    action: "block",
    description: "Tool: file deletion operation",
  },
  {
    id: "tool-shell-injection",
    toolPattern: /(?:shell|exec|command|run|bash|cmd|terminal|powershell)/i,
    argPattern: /(?:;\s*(?:rm|del|format|shutdown|reboot|curl|wget|nc|ncat)|\|\s*(?:rm|del|format|shutdown|curl|wget)|&&\s*(?:rm|del|format|shutdown|curl|wget)|`[^`]*(?:rm|del|format|curl|wget)`|\$\([^)]*(?:rm|del|format|curl|wget)[^)]*\))/i,
    severity: "high",
    action: "block",
    description: "Tool: shell injection pattern in arguments",
  },
  {
    id: "tool-path-traversal",
    toolPattern: /./, // any tool
    argPattern: /(?:\.\.[\\/]){2,}/,
    severity: "high",
    action: "block",
    description: "Tool: path traversal in arguments",
  },

  // Data exfiltration - only block outbound data transfer tools
  {
    id: "tool-exfil-url",
    toolPattern: /(?:send|post|put|upload|webhook)/i,
    argPattern: /https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^\s"'<>]+/i,
    severity: "high",
    action: "block",
    description: "Tool: data exfiltration to external URL",
  },
  {
    id: "tool-exfil-base64",
    toolPattern: /./,
    argPattern: /(?:[A-Za-z0-9+/]{100,}={0,2})/,
    severity: "medium",
    action: "warn",
    description: "Tool: large base64 payload (possible exfiltration)",
  },

  // Privilege escalation
  {
    id: "tool-privilege-sudo",
    toolPattern: /(?:shell|exec|command|run|bash|terminal)/i,
    argPattern: /(?:sudo|runas|su\s|admin|root|elevated)/i,
    severity: "high",
    action: "block",
    description: "Tool: privilege escalation (sudo/admin)",
  },
  {
    id: "tool-privilege-chmod",
    toolPattern: /(?:shell|exec|command|run|bash|terminal)/i,
    argPattern: /(?:chmod|chown|chgrp|icacls|attrib)\s/i,
    severity: "medium",
    action: "warn",
    description: "Tool: permission modification",
  },

  // SQL injection in tool args
  {
    id: "tool-sql-injection",
    toolPattern: /./,
    argPattern: /(?:['"];?\s*(?:DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|EXEC|UNION|SELECT)\s|;\s*(?:DROP|DELETE|INSERT|UPDATE|ALTER)|1\s*=\s*1|OR\s+1\s*=\s*1|'\s+OR\s+'|--\s*$)/im,
    severity: "high",
    action: "block",
    description: "SQL injection pattern in tool arguments",
  },
];

// ─── Sanitization Helpers ───────────────────────────────────────────────────

function sanitizePII(text: string): string {
  let result = text;
  // Email
  result = result.replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    "[REDACTED_EMAIL]",
  );
  // SSN
  result = result.replace(
    /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
    "[REDACTED_SSN]",
  );
  // Phone
  result = result.replace(
    /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    "[REDACTED_PHONE]",
  );
  // Credit card
  result = result.replace(
    /\b(?:\d[ -]*?){13,19}\b/g,
    "[REDACTED_CC]",
  );
  return result;
}

function sanitizeOutputLeaks(text: string): string {
  let result = text;
  // Remove lines that look like system prompt leaks
  result = result.replace(
    /you\s+are\s+(EvoClaw|an?\s+AI\s+assistant)\s+(that|who|designed|built)[^\n]*/gi,
    "[SYSTEM_PROMPT_REDACTED]",
  );
  result = result.replace(
    /(?:your|the)\s+(?:instructions?|system\s+prompt|rules?|guidelines?)\s+(?:are|is|state|say|require)[^\n]*/gi,
    "[INSTRUCTION_REFERENCE_REDACTED]",
  );
  // Remove hallucinated internal URLs
  result = result.replace(
    /https?:\/\/[^\s"'<>]+\.(internal|local|localhost|corp|intra)[^\s"'<>]*/gi,
    "[REDACTED_URL]",
  );
  return result;
}

function sanitizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      sanitized[key] = sanitizePII(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// ─── InputGuardrail ─────────────────────────────────────────────────────────

export class InputGuardrail {
  private readonly rules: InputRule[];
  private readonly defaultSeverity: Severity;

  constructor(rules: InputRule[], defaultSeverity: Severity) {
    this.rules = rules;
    this.defaultSeverity = defaultSeverity;
  }

  check(input: string): GuardrailResult {
    const triggeredRules: string[] = [];
    let highestSeverity: Severity | undefined;
    let worstAction: GuardrailAction = "log";
    let reason: string | undefined;
    let sanitizedInput: string | undefined;
    let needsSanitization = false;

    for (const rule of this.rules) {
      try {
        // BUG 8.1 fix: 带 g flag 的 RegExp test() 会累积 lastIndex，
        // 导致同一输入第二次 test 返回 false（安全规则时灵时不灵）。
        // 每次测试前重置 lastIndex。
        rule.pattern.lastIndex = 0;
        if (!rule.pattern.test(input)) {
          continue;
        }

        triggeredRules.push(rule.id);

        // Track highest severity
        if (!highestSeverity || severityRank(rule.severity) > severityRank(highestSeverity)) {
          highestSeverity = rule.severity;
          reason = rule.description;
        }

        // Track worst action
        if (actionRank(rule.action) > actionRank(worstAction)) {
          worstAction = rule.action;
        }

        if (rule.action === "sanitize") {
          needsSanitization = true;
        }
      } catch {
        // Regex execution error — skip this rule, continue checking
      }
    }

    // No rules triggered → pass
    if (triggeredRules.length === 0) {
      return { passed: true, triggeredRules: [] };
    }

    // Apply sanitization if needed
    if (needsSanitization) {
      sanitizedInput = sanitizePII(input);
    }

    const severity = highestSeverity ?? this.defaultSeverity;

    // Determine pass/fail based on worst action
    if (worstAction === "block") {
      return {
        passed: false,
        severity,
        reason: reason ?? "Input blocked by guardrail",
        sanitizedInput,
        triggeredRules,
      };
    }

    if (worstAction === "sanitize" || worstAction === "warn") {
      // "warn" and "sanitize" still pass (with sanitized content when applicable)
      return {
        passed: true,
        severity,
        reason: reason ?? "Input flagged by guardrail",
        sanitizedInput,
        triggeredRules,
      };
    }

    // "log" only
    return {
      passed: true,
      severity,
      reason: reason ?? "Input logged by guardrail",
      triggeredRules,
    };
  }
}

// ─── OutputGuardrail ────────────────────────────────────────────────────────

export class OutputGuardrail {
  private readonly rules: OutputRule[];
  private readonly defaultSeverity: Severity;

  constructor(rules: OutputRule[], defaultSeverity: Severity) {
    this.rules = rules;
    this.defaultSeverity = defaultSeverity;
  }

  check(output: string): GuardrailResult {
    const triggeredRules: string[] = [];
    let highestSeverity: Severity | undefined;
    let worstAction: GuardrailAction = "log";
    let reason: string | undefined;
    let sanitizedOutput: string | undefined;
    let needsSanitization = false;

    for (const rule of this.rules) {
      try {
        // BUG 8.1 fix: 同 checkInput，重置 lastIndex 防止 g flag 累积
        rule.pattern.lastIndex = 0;
        if (!rule.pattern.test(output)) {
          continue;
        }

        triggeredRules.push(rule.id);

        if (!highestSeverity || severityRank(rule.severity) > severityRank(highestSeverity)) {
          highestSeverity = rule.severity;
          reason = rule.description;
        }

        if (actionRank(rule.action) > actionRank(worstAction)) {
          worstAction = rule.action;
        }

        if (rule.action === "sanitize") {
          needsSanitization = true;
        }
      } catch {
        // Regex execution error — skip this rule
      }
    }

    if (triggeredRules.length === 0) {
      return { passed: true, triggeredRules: [] };
    }

    if (needsSanitization) {
      sanitizedOutput = sanitizeOutputLeaks(output);
    }

    const severity = highestSeverity ?? this.defaultSeverity;

    if (worstAction === "block") {
      return {
        passed: false,
        severity,
        reason: reason ?? "Output blocked by guardrail",
        sanitizedOutput,
        triggeredRules,
      };
    }

    if (worstAction === "sanitize" || worstAction === "warn") {
      return {
        passed: true,
        severity,
        reason: reason ?? "Output flagged by guardrail",
        sanitizedOutput,
        triggeredRules,
      };
    }

    return {
      passed: true,
      severity,
      reason: reason ?? "Output logged by guardrail",
      triggeredRules,
    };
  }
}

// ─── ToolGuardrail ──────────────────────────────────────────────────────────

export class ToolGuardrail {
  private readonly rules: ToolRule[];
  private readonly defaultSeverity: Severity;

  constructor(rules: ToolRule[], defaultSeverity: Severity) {
    this.rules = rules;
    this.defaultSeverity = defaultSeverity;
  }

  check(toolName: string, args: Record<string, unknown>): GuardrailResult {
    const triggeredRules: string[] = [];
    let highestSeverity: Severity | undefined;
    let worstAction: GuardrailAction = "log";
    let reason: string | undefined;
    let sanitizedArgs: Record<string, unknown> | undefined;
    let needsSanitization = false;

    // Serialize args for pattern matching
    const argsString = JSON.stringify(args);

    for (const rule of this.rules) {
      try {
        if (!rule.toolPattern.test(toolName)) {
          continue;
        }

        // Check argPattern against both individual arg values and the serialized whole
        let argMatched = false;
        if (rule.argPattern.test(argsString)) {
          argMatched = true;
        }
        if (!argMatched) {
          for (const value of Object.values(args)) {
            if (typeof value === "string" && rule.argPattern.test(value)) {
              argMatched = true;
              break;
            }
          }
        }

        if (!argMatched) {
          continue;
        }

        triggeredRules.push(rule.id);

        if (!highestSeverity || severityRank(rule.severity) > severityRank(highestSeverity)) {
          highestSeverity = rule.severity;
          reason = rule.description;
        }

        if (actionRank(rule.action) > actionRank(worstAction)) {
          worstAction = rule.action;
        }

        if (rule.action === "sanitize") {
          needsSanitization = true;
        }
      } catch {
        // Regex execution error — skip this rule
      }
    }

    if (triggeredRules.length === 0) {
      return { passed: true, triggeredRules: [] };
    }

    if (needsSanitization) {
      sanitizedArgs = sanitizeToolArgs(args);
    }

    const severity = highestSeverity ?? this.defaultSeverity;

    if (worstAction === "block") {
      return {
        passed: false,
        severity,
        reason: reason ?? "Tool call blocked by guardrail",
        sanitizedArgs,
        triggeredRules,
      };
    }

    if (worstAction === "sanitize" || worstAction === "warn") {
      return {
        passed: true,
        severity,
        reason: reason ?? "Tool call flagged by guardrail",
        sanitizedArgs,
        triggeredRules,
      };
    }

    return {
      passed: true,
      severity,
      reason: reason ?? "Tool call logged by guardrail",
      triggeredRules,
    };
  }
}

// ─── GuardrailsManager ──────────────────────────────────────────────────────

export class GuardrailsManager {
  private readonly config: GuardrailConfig;
  private readonly inputGuardrail: InputGuardrail;
  private readonly outputGuardrail: OutputGuardrail;
  private readonly toolGuardrail: ToolGuardrail;
  private readonly stats: GuardrailStats;

  constructor(config?: Partial<GuardrailConfig>) {
    const fullConfig: GuardrailConfig = {
      inputRules: config?.inputRules ?? [...BUILTIN_INPUT_RULES],
      outputRules: config?.outputRules ?? [...BUILTIN_OUTPUT_RULES],
      toolRules: config?.toolRules ?? [...BUILTIN_TOOL_RULES],
      defaultSeverity: config?.defaultSeverity ?? "medium",
      enabled: config?.enabled ?? true,
      inputEnabled: config?.inputEnabled ?? true,
      outputEnabled: config?.outputEnabled ?? true,
      toolEnabled: config?.toolEnabled ?? true,
    };

    this.config = fullConfig;
    this.inputGuardrail = new InputGuardrail(fullConfig.inputRules!, fullConfig.defaultSeverity);
    this.outputGuardrail = new OutputGuardrail(fullConfig.outputRules!, fullConfig.defaultSeverity);
    this.toolGuardrail = new ToolGuardrail(fullConfig.toolRules!, fullConfig.defaultSeverity);

    this.stats = {
      input:  { pass: 0, warn: 0, block: 0 },
      output: { pass: 0, warn: 0, block: 0 },
      tool:   { pass: 0, warn: 0, block: 0 },
    };
  }

  /** Validate user input before processing */
  checkInput(input: string): GuardrailResult {
    if (!this.config.enabled || !this.config.inputEnabled) {
      return { passed: true };
    }

    try {
      const result = this.inputGuardrail.check(input);
      this.recordStats("input", result);
      return result;
    } catch (error) {
      // Guardrail failure must not break the pipeline — fail open with a log
      return {
        passed: true,
        severity: "low",
        reason: `Input guardrail error: ${error instanceof Error ? error.message : String(error)}`,
        triggeredRules: [],
      };
    }
  }

  /** Validate LLM output before returning to user */
  checkOutput(output: string): GuardrailResult {
    if (!this.config.enabled || !this.config.outputEnabled) {
      return { passed: true };
    }

    try {
      const result = this.outputGuardrail.check(output);
      this.recordStats("output", result);
      return result;
    } catch (error) {
      return {
        passed: true,
        severity: "low",
        reason: `Output guardrail error: ${error instanceof Error ? error.message : String(error)}`,
        triggeredRules: [],
      };
    }
  }

  /** Validate tool calls before execution */
  checkToolCall(toolName: string, args: Record<string, unknown>): GuardrailResult {
    if (!this.config.enabled || !this.config.toolEnabled) {
      return { passed: true };
    }

    try {
      const result = this.toolGuardrail.check(toolName, args);
      this.recordStats("tool", result);
      return result;
    } catch (error) {
      return {
        passed: true,
        severity: "low",
        reason: `Tool guardrail error: ${error instanceof Error ? error.message : String(error)}`,
        triggeredRules: [],
      };
    }
  }

  /** Get cumulative statistics */
  getStats(): Readonly<GuardrailStats> {
    return this.stats;
  }

  /** Reset all statistics to zero */
  resetStats(): void {
    this.stats.input  = { pass: 0, warn: 0, block: 0 };
    this.stats.output = { pass: 0, warn: 0, block: 0 };
    this.stats.tool   = { pass: 0, warn: 0, block: 0 };
  }

  /** Current configuration (read-only snapshot) */
  getConfig(): Readonly<GuardrailConfig> {
    return this.config;
  }

  // ── Internal ──

  private recordStats(layer: "input" | "output" | "tool", result: GuardrailResult): void {
    if (!result.passed) {
      this.stats[layer].block++;
    } else if (result.severity && result.severity !== "low") {
      this.stats[layer].warn++;
    } else {
      this.stats[layer].pass++;
    }
  }
}

// ─── Utility Functions ──────────────────────────────────────────────────────

function severityRank(s: Severity): number {
  switch (s) {
    case "low":    return 0;
    case "medium": return 1;
    case "high":   return 2;
  }
}

function actionRank(a: GuardrailAction): number {
  switch (a) {
    case "log":      return 0;
    case "warn":     return 1;
    case "sanitize": return 2;
    case "block":    return 3;
  }
}
