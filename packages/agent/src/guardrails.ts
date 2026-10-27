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
    // ★ 词界匹配（2026-10-16 实例任务事故）：裸子串 `rm` 会命中
    // "permission_status" / "confirm" 家族工具名 → 查审批状态的工具被误拦，
    // 模型失去审批检查通道。lookaround 保证只拦真删除类工具名
    // （file_delete / rm / truncate_file 仍命中；permission_status 放行）。
    toolPattern: /(?<![a-z0-9])(?:delete|remove|unlink|rmdir|rm|truncate|wipe|destroy)(?![a-z0-9])/i,
    argPattern: /./, // any args — the tool name itself is dangerous
    severity: "high",
    action: "block",
    description: "Tool: file deletion operation",
  },
  {
    id: "tool-shell-injection",
    toolPattern: /(?:shell|exec|command|run|bash|cmd|terminal|powershell)/i,
    // 回归（2026-10-16 会话 sess_mvasc4w8）：合法「下载+处理」链路
    // `curl -s URL -o x.json && python3 -c ...` 被 `&&\s*curl` 分支硬拦，
    // 模型被迫改走 Python 直连（撞 SSL 校验失败）浪费 4 轮。curl/wget
    // 只是下载、非破坏性，从各操作符后分支移除；破坏性/DoS 集合
    // （rm/del/format/shutdown/reboot/nc/ncat）不变，`&& rm`、`; nc` 仍拦。
    // 加固（会话审计 2026-10-17）：反引号与 `$()` 子命令分支补回
    // nc/ncat——旧正则这两分支本就漏了 nc（`$(nc …)`、`` `nc evil` ``
    // 可反弹 shell 到外部端口），一并纳入拦截。
    argPattern: /(?:;\s*(?:rm|del|format|shutdown|reboot|nc|ncat)|\|\s*(?:rm|del|format|shutdown)|&&\s*(?:rm|del|format|shutdown)|`[^`]*\b(?:rm|del|format|nc|ncat)\b[^`]*`|\$\([^)]*\b(?:rm|del|format|nc|ncat)\b[^)]*\))/i,
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
  // 回归（2026-10-16 实例任务）：旧 argPattern 含裸 `admin|root|elevated` 子串匹配，
  // 把合法 Python heredoc 里的 `root = ET.fromstring(...)`、`root.find(...)`（变量名
  // 叫 root）判成提权并 block，模型被迫改走 file_write 绕路。
  // 收窄到真实提权信号：sudo/sudoers/runas/su 调用；`admin`、`root` 仅在与
  // su 组合（su root / su -）时算信号，裸变量名不再命中。
  {
    id: "tool-privilege-sudo",
    toolPattern: /(?:shell|exec|command|run|bash|terminal)/i,
    argPattern: /sudo(?:ers)?\b|\brunas\b|\bsu\s+(?:-|root|admin)\b/i,
    severity: "high",
    action: "block",
    description: "Tool: privilege escalation (sudo/su/runas)",
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
  // 只对可能触达数据库/解释器的工具生效（file_write 等写文件工具豁免——
  // 源码/Markdown 内容不是 SQL 上下文，历史上被误拦）。
  // 2026-10-14 修复两类误伤：
  // 1. 裸 `--\s*$`（多行）会命中任何以两个以上短横线结尾的行
  //    （Python 注释分隔线 `# -----`、Markdown `---`）→ 改为 `'\s*--`
  //    （SQL 注释注入必须紧跟引号，如 `admin'--`）；
  // 2. 裸 `1\s*=\s*1` 会命中 `count1 = 1` 这类赋值语句 → 加 `\b` 词界。
  // 2026-10-16 修复第三类误伤（实例任务评测复盘）：`echo '---'`（shell 输出分隔线）
  // 让 `'\s*--` 命中——单引号后紧跟三个破折号。真注入 `admin'--` 的特征是 `--`
  // 之后**不再**是破折号/引号/单词（注释已收尾），故加负向前瞻 `(?![\-'"\w])`：
  // `---`/`'---'` 这类「破折号串/分隔线」放行，`'-- `、`'--;` 注入仍拦。
  {
    id: "tool-sql-injection",
    toolPattern: /(?:sql|query|database|\bdb\b|mysql|postgres|shell|exec|command|run|bash|terminal|execute)/i,
    argPattern: /(?:['"];?\s*(?:DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|EXEC|UNION|SELECT)\s|;\s*(?:DROP|DELETE|INSERT|UPDATE|ALTER)|\b1\s*=\s*1\b|OR\s+1\s*=\s*1|'\s+OR\s+'|'\s*--(?![\-'"\w]))/im,
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
        // BUG 8.1 fix: 重置 lastIndex 防止 g flag 累积导致状态泄漏
        rule.toolPattern.lastIndex = 0;
        if (!rule.toolPattern.test(toolName)) {
          continue;
        }

        // Check argPattern against both individual arg values and the serialized whole
        let argMatched = false;
        rule.argPattern.lastIndex = 0;
        if (rule.argPattern.test(argsString)) {
          argMatched = true;
        }
        if (!argMatched) {
          for (const value of Object.values(args)) {
            rule.argPattern.lastIndex = 0;
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
    default:       return 0;
  }
}

function actionRank(a: GuardrailAction): number {
  switch (a) {
    case "log":      return 0;
    case "warn":     return 1;
    case "sanitize": return 2;
    case "block":    return 3;
    default:         return 0;
  }
}

// ─── R1-3: 工具循环检测（借鉴 hermes-agent tool_guardrails.py） ──────────────

/**
 * 幂等工具集合。这些工具重复调用不会造成副作用，
 * 循环检测阈值相对宽松。
 */
export const IDEMPOTENT_TOOL_NAMES = new Set([
  "web_search", "web_fetch", "file_read", "file_list", "ls",
  "memory_retrieve", "memory", "skill_list", "skill_view",
  "sequential_thinking", "assess_coding_capability", "markitdown_convert",
]);

/**
 * 有副作用的工具集合。这些工具重复调用可能造成数据损坏，
 * 循环检测阈值更严格。
 */
export const MUTATING_TOOL_NAMES = new Set([
  "file_write", "file_delete", "file_move", "file_copy",
  "shell_exec", "execute_command", "run_command",
  "memory_save", "memory_store", "remember",
  "skill_manage",
  "browser_navigate", "browser_act",
]);

/**
 * 工具调用签名。用 SHA-256 hash args 做去标识比较，
 * 避免 args 中包含 timestamp 等动态字段导致签名不同。
 */
export interface ToolCallSignature {
  /** 工具名称 */
  toolName: string;
  /** args 的归一化 hash */
  argsHash: string;
}

/**
 * 工具循环检测结果。
 */
export interface ToolLoopCheckResult {
  /** 检测到的循环类型 */
  detection: "none" | "exact_failure" | "same_tool_failure" | "no_progress" | "identical_cycle" | "web_search_cap";
  /** 建议动作 */
  action: "continue" | "warn" | "halt";
  /** 人类可读的警告/阻断消息 */
  message: string;
  /** 当前计数 */
  count: number;
  /** 阈值 */
  threshold: number;
}

/**
 * 工具循环检测配置。
 *
 * 借鉴 hermes-agent ToolCallGuardrailConfig：
 *   - warnings_enabled：达到 warn 阈值时发出警告（progress 事件）
 *   - hard_stop_enabled：达到 halt 阈值时抛出 ToolLoopDetectedError
 *   - 区分 exact_failure / same_tool_failure / no_progress 三种检测
 */
export interface ToolLoopGuardrailConfig {
  /** 警告阈值 */
  warningsEnabled: boolean;
  /** 阻断阈值 */
  hardStopEnabled: boolean;
  /** 完全相同的工具调用（同 name + 同 argsHash）失败 N 次后警告 */
  exactFailureWarnAfter: number;
  /** 完全相同的工具调用失败 N 次后阻断 */
  exactFailureHaltAfter: number;
  /** 同名工具（不同 args）失败 N 次后警告 */
  sameToolFailureWarnAfter: number;
  /** 同名工具失败 N 次后阻断 */
  sameToolFailureHaltAfter: number;
  /** 无进展（工具返回相同结果）N 次后警告 */
  noProgressWarnAfter: number;
  /** 无进展 N 次后阻断 */
  noProgressHaltAfter: number;
  /** 多调用周期循环（A,B,A,B…）重复 N 个周期后警告（hermes identical-cycle，oh-my-pi#10521） */
  identicalCycleWarnAfter: number;
  /** 多调用周期循环重复 N 个周期后阻断 */
  identicalCycleHaltAfter: number;
  /** 每 turn web_search 类工具硬顶（超过即阻断；0 表示不限制） */
  maxWebSearchesPerTurn: number;
}

export const DEFAULT_TOOL_LOOP_CONFIG: ToolLoopGuardrailConfig = {
  warningsEnabled: true,
  hardStopEnabled: true,
  exactFailureWarnAfter: 2,
  exactFailureHaltAfter: 5,
  sameToolFailureWarnAfter: 3,
  sameToolFailureHaltAfter: 8,
  noProgressWarnAfter: 2,
  noProgressHaltAfter: 5,
  identicalCycleWarnAfter: 3,
  identicalCycleHaltAfter: 5,
  maxWebSearchesPerTurn: 50,
};

/**
 * 多调用周期循环检测参数（对齐 hermes STALL_GUARD 常量）：
 * - 周期最大长度 4（A,B,C,D 交替循环）；
 * - 历史窗口 64 次调用（足够容纳 5 laps × 4 周期 + 余量）；
 * - 「轮」(lap) = 一个完整周期内的全部 (工具, 结果) 都相同。
 */
const STALL_GUARD_MAX_CYCLE_PERIOD = 4;
const STALL_GUARD_CYCLE_HISTORY = 64;
/** laps 起算基线：3 个完整周期才算「重复」，容忍偶发双检。 */
const STALL_GUARD_MIN_LAPS = 3;

/**
 * 成功 mutation 工具（hermes PROGRESS_RESET_TOOL_NAMES 语义）：
 * 这些工具**成功**执行意味着世界状态已改变——「编辑→重跑」是新实验而非重放，
 * 应重置失败计数与停滞检测状态。EvoClaw 对齐 verification-stop 的变更工具口径。
 */
export const PROGRESS_RESET_TOOLS = new Set([
  "file_write", "file_delete",
  "shell_exec", "execute_code", "apply_patch",
  "document",
  "browser_act", "browser_navigate",
  // 合并后的复合工具：任一 action 成功都意味着世界状态可能已改变
  "git", "email", "scheduler", "kanban", "music", "video", "skill_manage",
]);

/** 计入每 turn 硬顶的 web 检索类工具（hermes LoopCapConfig max_web_searches 口径）。 */
const WEB_SEARCH_TOOLS = new Set(["web_search", "web_fetch"]);

/**
 * 工具循环检测器。
 *
 * 借鉴 hermes-agent agent/tool_guardrails.py：
 *   追踪每个 turn 内的工具调用历史，检测三种循环模式：
 *   1. exact_failure：完全相同的工具调用（同 name + 同 args）反复失败
 *   2. same_tool_failure：同名工具（不同 args）反复失败
 *   3. no_progress：工具反复返回相同结果（无实质进展）
 */
export class ToolCallLoopDetector {
  private config: ToolLoopGuardrailConfig;
  /** 精确签名 → 失败次数 */
  private exactFailureCounts = new Map<string, number>();
  /** 工具名 → 失败次数 */
  private sameToolFailureCounts = new Map<string, number>();
  /** 结果 hash → 连续相同次数 */
  private noProgressCounts = new Map<string, number>();
  /** 上一次结果 hash（用于检测连续相同） */
  private lastResultHash: string | null = null;
  private consecutiveSameResults = 0;
  /** 调用历史（hermes identical-cycle：(签名, 结果hash) 序列，窗口 64） */
  private callHistory: Array<{ toolName: string; argsHash: string; resultHash: string }> = [];
  /** 每 turn web_search 类工具调用计数 */
  private webSearchCount = 0;

  constructor(config: Partial<ToolLoopGuardrailConfig> = {}) {
    this.config = { ...DEFAULT_TOOL_LOOP_CONFIG, ...config };
  }

  /**
   * 计算工具调用的签名。
   * args 通过 JSON 归一化后 SHA-256 hash，去除 timestamp 等动态字段影响。
   */
  computeSignature(toolName: string, args: Record<string, unknown>): ToolCallSignature {
    // 归一化 args：排序 key + 去除动态字段
    const normalized = this.normalizeArgs(args);
    const argsStr = JSON.stringify(normalized);
    const argsHash = this.hashString(argsStr);
    return { toolName, argsHash };
  }

  /**
   * 记录一次工具调用结果，并检测循环。
   *
   * @param toolName 工具名称
   * @param args 工具参数
   * @param success 是否成功
   * @param resultContent 结果内容（用于 no_progress 检测）
   * @returns 检测结果
   */
  check(
    toolName: string,
    args: Record<string, unknown>,
    success: boolean,
    resultContent: string,
  ): ToolLoopCheckResult {
    const sig = this.computeSignature(toolName, args);
    const exactKey = `${sig.toolName}:${sig.argsHash}`;
    const resultHash = this.hashString(resultContent.slice(0, 4096));

    // ── 成功 mutation 进度重置（hermes PROGRESS_RESET_TOOL_NAMES 语义）──
    // 编辑/执行类工具成功 = 世界状态已变，「改一下再跑」是新实验而非重放，
    // 此前的失败计数与停滞状态全部作废。
    if (success && PROGRESS_RESET_TOOLS.has(toolName)) {
      this.exactFailureCounts.clear();
      this.sameToolFailureCounts.clear();
      this.consecutiveSameResults = 0;
    }

    // ── web_search 类工具每 turn 硬顶（hermes LoopCapConfig：计数不受
    //    hard_stop 开关控制；超出即阻断，防止无界检索烧满预算） ──
    if (WEB_SEARCH_TOOLS.has(toolName) && this.config.maxWebSearchesPerTurn > 0) {
      this.webSearchCount++;
      if (this.webSearchCount > this.config.maxWebSearchesPerTurn) {
        return {
          detection: "web_search_cap",
          action: "halt",
          message: `web_search 类工具本回合已调用 ${this.webSearchCount} 次，超过硬顶 ${this.config.maxWebSearchesPerTurn}。已停止，请基于已检索结果直接回答。`,
          count: this.webSearchCount,
          threshold: this.config.maxWebSearchesPerTurn,
        };
      }
    }

    // ── no_progress 检测 ──
    if (resultHash === this.lastResultHash) {
      this.consecutiveSameResults++;
    } else {
      this.consecutiveSameResults = 0;
      this.lastResultHash = resultHash;
    }

    // ── 记录调用历史（供 identical-cycle 检测，窗口 64） ──
    this.callHistory.push({ toolName: sig.toolName, argsHash: sig.argsHash, resultHash });
    if (this.callHistory.length > STALL_GUARD_CYCLE_HISTORY) this.callHistory.shift();

    if (!success) {
      // ── exact_failure 检测 ──
      const exactCount = (this.exactFailureCounts.get(exactKey) ?? 0) + 1;
      this.exactFailureCounts.set(exactKey, exactCount);

      // ── same_tool_failure 检测 ──
      const toolCount = (this.sameToolFailureCounts.get(toolName) ?? 0) + 1;
      this.sameToolFailureCounts.set(toolName, toolCount);

      // 检查 halt 阈值（优先级：exact > same_tool）
      if (this.config.hardStopEnabled) {
        if (exactCount >= this.config.exactFailureHaltAfter) {
          return {
            detection: "exact_failure",
            action: "halt",
            message: `工具 "${toolName}" 以相同参数失败 ${exactCount} 次，达到阻断阈值 ${this.config.exactFailureHaltAfter}。已停止循环。`,
            count: exactCount,
            threshold: this.config.exactFailureHaltAfter,
          };
        }
        if (toolCount >= this.config.sameToolFailureHaltAfter) {
          return {
            detection: "same_tool_failure",
            action: "halt",
            message: `工具 "${toolName}" 失败 ${toolCount} 次（不同参数），达到阻断阈值 ${this.config.sameToolFailureHaltAfter}。已停止循环。`,
            count: toolCount,
            threshold: this.config.sameToolFailureHaltAfter,
          };
        }
      }

      // 检查 warn 阈值
      if (this.config.warningsEnabled) {
        if (exactCount >= this.config.exactFailureWarnAfter) {
          return {
            detection: "exact_failure",
            action: "warn",
            message: `⚠️ 工具 "${toolName}" 以相同参数已失败 ${exactCount} 次，可能陷入循环。`,
            count: exactCount,
            threshold: this.config.exactFailureWarnAfter,
          };
        }
        if (toolCount >= this.config.sameToolFailureWarnAfter) {
          return {
            detection: "same_tool_failure",
            action: "warn",
            message: `⚠️ 工具 "${toolName}" 已失败 ${toolCount} 次（不同参数），可能需要换一种方法。`,
            count: toolCount,
            threshold: this.config.sameToolFailureWarnAfter,
          };
        }
      }
    }

    // ── no_progress 检测 ──
    if (this.consecutiveSameResults > 0 && success) {
      if (this.config.hardStopEnabled && this.consecutiveSameResults >= this.config.noProgressHaltAfter) {
        return {
          detection: "no_progress",
          action: "halt",
          message: `工具连续 ${this.consecutiveSameResults} 次返回相同结果，无实质进展。已停止循环。`,
          count: this.consecutiveSameResults,
          threshold: this.config.noProgressHaltAfter,
        };
      }
      if (this.config.warningsEnabled && this.consecutiveSameResults >= this.config.noProgressWarnAfter) {
        return {
          detection: "no_progress",
          action: "warn",
          message: `⚠️ 工具连续 ${this.consecutiveSameResults} 次返回相同结果，可能无实质进展。`,
          count: this.consecutiveSameResults,
          threshold: this.config.noProgressWarnAfter,
        };
      }
    }

    // ── identical-cycle 检测（hermes _detect_identical_cycle / oh-my-pi#10521）──
    // 交替循环 A,B,A,B,… 每次都重置「连续相同结果」计数，普通 no_progress 抓不到；
    // 这里在 (工具,argsHash,resultHash) 历史上找最小周期 2..4，尾部连续相同
    // 的完整周期数（lap）达到阈值即告警/阻断。
    const cycle = this.detectIdenticalCycle();
    if (cycle) {
      if (this.config.hardStopEnabled && cycle.laps >= this.config.identicalCycleHaltAfter) {
        return {
          detection: "identical_cycle",
          action: "halt",
          message: `工具调用呈 ${cycle.period} 步周期循环重复 ${cycle.laps} 轮且结果不变（${cycle.tail.map(t => t.toolName).join("→")}…），无实质进展。已停止循环。`,
          count: cycle.laps,
          threshold: this.config.identicalCycleHaltAfter,
        };
      }
      if (this.config.warningsEnabled && cycle.laps >= this.config.identicalCycleWarnAfter) {
        return {
          detection: "identical_cycle",
          action: "warn",
          message: `⚠️ 工具调用呈 ${cycle.period} 步周期循环重复 ${cycle.laps} 轮且结果不变，可能陷入交替循环。`,
          count: cycle.laps,
          threshold: this.config.identicalCycleWarnAfter,
        };
      }
    }

    return { detection: "none", action: "continue", message: "", count: 0, threshold: 0 };
  }

  /**
   * 检测尾部多调用周期循环（hermes _detect_identical_cycle 的 TS 移植）：
   * 最小周期 2..STALL_GUARD_MAX_CYCLE_PERIOD，尾部连续 laps 个完整周期
   * 的 (工具, argsHash, 结果hash) 逐一相同才计为一轮；
   * laps ≥ STALL_GUARD_MIN_LAPS 返回 { period, laps, tail }，否则 null。
   */
  private detectIdenticalCycle(): { period: number; laps: number; tail: Array<{ toolName: string; argsHash: string; resultHash: string }> } | null {
    const history = this.callHistory;
    for (let period = 2; period <= STALL_GUARD_MAX_CYCLE_PERIOD; period++) {
      if (history.length < period * STALL_GUARD_MIN_LAPS) continue;
      let laps = 1;
      while (true) {
        const base = history.length - period * (laps + 1);
        if (base < 0) break;
        let lapEqual = true;
        for (let i = 0; i < period; i++) {
          const a = history[base + i];
          const b = history[history.length - period + i];
          if (a.toolName !== b.toolName || a.argsHash !== b.argsHash || a.resultHash !== b.resultHash) {
            lapEqual = false;
            break;
          }
        }
        if (!lapEqual) break;
        laps++;
      }
      if (laps >= STALL_GUARD_MIN_LAPS) {
        // 周期 1（单一调用重复）由 consecutiveSameResults / no_progress 负责；
        // 此处若尾部 period 段与 period-1 段完全相同说明是更短周期的别名，跳过（继续找更小周期不会命中，
        // 因为从小到大枚举，先命中的一定是最小周期）。
        return {
          period,
          laps,
          tail: history.slice(history.length - period).map((e) => ({ ...e })),
        };
      }
    }
    return null;
  }

  /**
   * 重置所有计数器（新 turn 开始时调用）。
   */
  resetTurn(): void {
    this.exactFailureCounts.clear();
    this.sameToolFailureCounts.clear();
    this.noProgressCounts.clear();
    this.lastResultHash = null;
    this.consecutiveSameResults = 0;
    this.callHistory = [];
    this.webSearchCount = 0;
  }

  /**
   * 获取某个工具的精确失败次数。
   */
  getExactFailureCount(toolName: string, args: Record<string, unknown>): number {
    const sig = this.computeSignature(toolName, args);
    const exactKey = `${sig.toolName}:${sig.argsHash}`;
    return this.exactFailureCounts.get(exactKey) ?? 0;
  }

  /**
   * 获取某个工具名的总失败次数。
   */
  getToolFailureCount(toolName: string): number {
    return this.sameToolFailureCounts.get(toolName) ?? 0;
  }

  /**
   * 更新配置。
   */
  updateConfig(config: Partial<ToolLoopGuardrailConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** 获取当前配置 */
  getConfig(): ToolLoopGuardrailConfig {
    return { ...this.config };
  }

  // ── 内部方法 ──

  /**
   * 归一化 args：排序 key + 去除动态字段（timestamp、requestId 等）。
   */
  private normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const DYNAMIC_KEYS = new Set([
      "timestamp", "requestId", "request_id", "_ts", "nonce",
      "session_id", "sessionId", "trace_id", "traceId",
    ]);
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(args).sort()) {
      if (DYNAMIC_KEYS.has(key)) continue;
      const val = args[key];
      if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        sorted[key] = this.normalizeArgs(val as Record<string, unknown>);
      } else {
        sorted[key] = val;
      }
    }
    return sorted;
  }

  /**
   * SHA-256 hash 字符串（使用 crypto，截断到 16 字符节省内存）。
   */
  private hashString(s: string): string {
    // 延迟导入避免循环依赖
    const { createHash } = require("crypto") as typeof import("crypto");
    return createHash("sha256").update(s).digest("hex").slice(0, 16);
  }
}

/**
 * 工具循环检测阻断错误。
 * 当达到 halt 阈值时抛出，由调用方捕获并停止工具循环。
 */
export class ToolLoopDetectedError extends Error {
  public readonly detection: string;
  public readonly toolName: string;
  public readonly count: number;

  constructor(result: ToolLoopCheckResult, toolName: string) {
    super(result.message);
    this.name = "ToolLoopDetectedError";
    this.detection = result.detection;
    this.toolName = toolName;
    this.count = result.count;
  }
}
