// ── MCP Tool Description Poisoning Scanner ──
// OpenClaw 6.6 引入: 检测MCP tool description中的prompt injection
// 防御Invariant Labs/OWASP演示的"tool description poisoning"攻击

/** MCP Tool 描述 */
export interface MCPToolDescription {
  name: string;
  description: string;
  inputSchema?: string;
  /** 元数据 (author, version, source) */
  metadata?: Record<string, string>;
}

/** 扫描结果 */
export interface PoisoningScanResult {
  safe: boolean;
  riskScore: number; // 0-100
  threats: PoisoningThreat[];
  sanitizedDescription?: string;
  recommendation: "allow" | "warn" | "block";
}

/** 检测到的威胁 */
export interface PoisoningThreat {
  type: PoisoningType;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  evidence: string;
  position?: { start: number; end: number };
}

/** 威胁类型 */
export type PoisoningType =
  | "instruction_override"   // 试图覆盖系统指令
  | "data_exfiltration"      // 试图窃取数据
  | "hidden_directive"       // 隐藏指令(用unicode/特殊字符)
  | "fake_authority"         // 伪造权威(如"系统提示")
  | "credential_harvesting"  // 试图获取凭证
  | "code_execution"         // 试图执行代码
  | "phishing_link"          // 钓鱼链接
  | "social_engineering";    // 社会工程学

/** 扫描器配置 */
export interface PoisoningScannerConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 自定义检测模式 */
  customPatterns?: Array<{
    type: PoisoningType;
    pattern: RegExp;
    severity: "low" | "medium" | "high" | "critical";
  }>;
  /** 风险评分阈值 */
  blockThreshold?: number; // 默认50（单个critical威胁即可触发block）
  warnThreshold?: number;  // 默认40
  /** 是否在sanitizedDescription中清除威胁 */
  autoSanitize?: boolean;
}

/** 预置检测模式 */
const POISONING_PATTERNS: Array<{
  type: PoisoningType;
  pattern: RegExp;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
}> = [
  // 指令覆盖
  {
    type: "instruction_override",
    pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|directives?|prompts?)/gi,
    severity: "critical",
    description: "尝试覆盖先前的指令",
  },
  {
    type: "instruction_override",
    pattern: /disregard\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?)/gi,
    severity: "critical",
    description: "尝试忽略先前的规则",
  },
  {
    type: "instruction_override",
    pattern: /forget\s+(?:everything|all|your)\s+(?:you|training|rules)/gi,
    severity: "critical",
    description: "尝试让模型忘记训练",
  },
  // 隐藏指令(unicode/零宽字符)
  {
    type: "hidden_directive",
    pattern: /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g,
    severity: "high",
    description: "包含零宽字符/双向控制符,可能隐藏指令",
  },
  // 伪造权威
  {
    type: "fake_authority",
    pattern: /\[SYSTEM\]|\[ADMIN\]|\[ROOT\]|\[INTERNAL\]|\[PRIORITY\]/gi,
    severity: "high",
    description: "伪造系统/管理员身份",
  },
  {
    type: "fake_authority",
    pattern: /system\s+prompt\s+(?:says|requires|commands?|instructs?)/gi,
    severity: "critical",
    description: "伪造系统提示要求",
  },
  // 凭证收集
  {
    type: "credential_harvesting",
    pattern: /(?:send|post|upload|exfiltrate|transmit)\s+(?:the\s+)?(?:user(?:'s)?\s+)?(?:api[_-]?key|secret|token|password|credential)/gi,
    severity: "critical",
    description: "试图收集并外传凭证",
  },
  {
    type: "credential_harvesting",
    pattern: /(?:read|fetch|obtain|get|retrieve|collect|exfiltrate)\s+(?:the\s+)?(?:user(?:'s|s)\s+)?(?:\.env|\.ssh|credentials?|id_rsa|id_ed25519|secrets?|api[_-]?keys?|passwords?)/gi,
    severity: "critical",
    description: "试图读取敏感文件或凭证",
  },
  // 数据外传
  {
    type: "data_exfiltration",
    pattern: /(?:send|post|upload)\s+(?:all\s+)?(?:the\s+)?(?:data|content|message|conversation)\s+to\s+https?:\/\//gi,
    severity: "critical",
    description: "尝试外传数据到远程URL",
  },
  {
    type: "data_exfiltration",
    pattern: /(?:forward|exfiltrate|leak)\s+(?:to|via)\s+(?:a\s+)?(?:webhook|url|server|endpoint)/gi,
    severity: "high",
    description: "尝试外传数据",
  },
  // 代码执行
  {
    type: "code_execution",
    pattern: /(?:run|execute|eval)\s+(?:the\s+following\s+)?(?:code|command|script|shell)/gi,
    severity: "medium",
    description: "建议执行代码/命令",
  },
  {
    type: "code_execution",
    pattern: /`(?:rm\s+-rf|sudo|chmod\s+777|curl\s+[^`]*\|\s*sh|wget\s+[^`]*\|\s*bash)/gi,
    severity: "critical",
    description: "包含危险命令示例",
  },
  // 钓鱼链接
  {
    type: "phishing_link",
    pattern: /https?:\/\/(?:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?\//g,
    severity: "medium",
    description: "包含IP地址直链",
  },
  {
    type: "phishing_link",
    pattern: /https?:\/\/(?:[a-z0-9-]+\.)*(?:ngrok|localtunnel|serveo|requestbin|hookbin)\.(?:io|net|com)/gi,
    severity: "high",
    description: "包含内网穿透/请求捕获服务链接",
  },
  // 社会工程学
  {
    type: "social_engineering",
    pattern: /you\s+must\s+(?:not\s+)?(?:tell|inform|warn|alert|mention)\s+(?:the\s+)?user/gi,
    severity: "high",
    description: "试图让模型对用户隐瞒信息",
  },
  {
    type: "social_engineering",
    pattern: /pretend\s+(?:to\s+be|you\s+are)\s+(?:a|an)\s+(?:helpful|harmless)/gi,
    severity: "medium",
    description: "试图让模型伪装无害",
  },
];

/** 风险评分权重 */
const SEVERITY_WEIGHTS: Record<string, number> = {
  low: 5,
  medium: 15,
  high: 30,
  critical: 50,
};

/**
 * MCPToolPoisoningScanner
 * 扫描MCP tool描述, 检测prompt injection攻击
 * 参考: OpenClaw 6.6 security boundaries
 */
export class MCPToolPoisoningScanner {
  private config: Required<PoisoningScannerConfig>;
  private patterns: typeof POISONING_PATTERNS;
  private blacklist: Array<{ id: string; pattern: string; reason: string; severity: string; createdAt: number }> = [];
  private scanAuditLog: Array<{ toolName: string; riskScore: number; recommendation: string; threats: number; timestamp: number }> = [];
  private stats = {
    scanned: 0,
    safe: 0,
    warned: 0,
    blocked: 0,
    threatsByType: new Map<string, number>(),
  };

  constructor(config: Partial<PoisoningScannerConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      customPatterns: config.customPatterns ?? [],
      blockThreshold: config.blockThreshold ?? 50,
      warnThreshold: config.warnThreshold ?? 40,
      autoSanitize: config.autoSanitize ?? false,
    };
    this.patterns = [...POISONING_PATTERNS];
    for (const p of this.config.customPatterns) {
      this.patterns.push({
        type: p.type,
        pattern: p.pattern,
        severity: p.severity,
        description: `Custom: ${p.type}`,
      });
    }
  }

  /** 扫描单个tool */
  scan(tool: MCPToolDescription): PoisoningScanResult {
    if (!this.config.enabled) {
      return { safe: true, riskScore: 0, threats: [], recommendation: "allow" };
    }
    this.stats.scanned++;
    const threats: PoisoningThreat[] = [];

    // 扫描name + description + inputSchema
    const textToScan = [
      tool.name,
      tool.description,
      tool.inputSchema ?? "",
    ].join("\n");

    for (const p of this.patterns) {
      p.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      // 关键: 防止ReDoS, 限制单pattern最多匹配次数
      let matchCount = 0;
      while ((match = p.pattern.exec(textToScan)) !== null && matchCount < 50) {
        threats.push({
          type: p.type,
          severity: p.severity,
          description: p.description,
          evidence: this.truncateEvidence(match[0]),
          position: { start: match.index, end: match.index + match[0].length },
        });
        this.stats.threatsByType.set(p.type, (this.stats.threatsByType.get(p.type) ?? 0) + 1);
        matchCount++;
        // 避免零宽字符pattern的无限循环
        if (match.index === p.pattern.lastIndex) p.pattern.lastIndex++;
      }
    }

    // 计算风险评分
    const riskScore = this.calculateRiskScore(threats);
    const safe = riskScore < this.config.warnThreshold;
    let recommendation: PoisoningScanResult["recommendation"];
    if (riskScore >= this.config.blockThreshold) {
      recommendation = "block";
      this.stats.blocked++;
    } else if (riskScore >= this.config.warnThreshold) {
      recommendation = "warn";
      this.stats.warned++;
    } else {
      recommendation = "allow";
      this.stats.safe++;
    }

    let sanitizedDescription: string | undefined;
    if (this.config.autoSanitize && threats.length > 0) {
      sanitizedDescription = this.sanitizeDescription(tool.description, threats);
    }

    // Record audit entry
    this.scanAuditLog.push({
      toolName: tool.name,
      riskScore,
      recommendation,
      threats: threats.length,
      timestamp: Date.now(),
    });
    if (this.scanAuditLog.length > 1000) {
      this.scanAuditLog.shift();
    }

    return {
      safe,
      riskScore,
      threats,
      sanitizedDescription,
      recommendation,
    };
  }

  /** 批量扫描 */
  scanBatch(tools: MCPToolDescription[]): Array<{ tool: MCPToolDescription; result: PoisoningScanResult }> {
    return tools.map((t) => ({ tool: t, result: this.scan(t) }));
  }

  /** 计算风险评分 */
  private calculateRiskScore(threats: PoisoningThreat[]): number {
    // 取威胁类型去重(同类型多实例算一次)
    const byType = new Map<string, number>();
    for (const t of threats) {
      byType.set(t.type, Math.max(byType.get(t.type) ?? 0, SEVERITY_WEIGHTS[t.severity] ?? 5));
    }
    let score = 0;
    for (const v of byType.values()) score += v;
    // 同类型多实例额外加分(最多+20)
    const extraByType = new Map<string, number>();
    for (const t of threats) {
      extraByType.set(t.type, (extraByType.get(t.type) ?? 0) + 1);
    }
    for (const count of extraByType.values()) {
      if (count > 1) score += Math.min(20, (count - 1) * 5);
    }
    return Math.min(100, score);
  }

  /** 截断证据字符串 */
  private truncateEvidence(evidence: string, max = 100): string {
    if (evidence.length <= max) return evidence;
    return evidence.slice(0, max) + "...";
  }

  /** 清理描述, 移除威胁evidence */
  private sanitizeDescription(text: string, threats: PoisoningThreat[]): string {
    let sanitized = text;
    for (const t of threats) {
      if (t.position) {
        sanitized = sanitized.slice(0, t.position.start) + "***REDACTED***" + sanitized.slice(t.position.end);
      }
    }
    // 移除零宽字符
    sanitized = sanitized.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "");
    return sanitized;
  }

  /** 获取统计 */
  getStats() {
    return {
      ...this.stats,
      threatsByType: Object.fromEntries(this.stats.threatsByType),
    };
  }

  /** 获取黑名单模式 */
  getBlacklist(): Array<{ id: string; pattern: string; reason: string; severity: string; createdAt: number }> {
    return [...this.blacklist];
  }

  /** 添加黑名单模式 */
  addBlacklistPattern(entry: { pattern: string; reason: string; severity: string }): { id: string; pattern: string; reason: string; severity: string; createdAt: number } {
    const id = `bl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record = { id, pattern: entry.pattern, reason: entry.reason, severity: entry.severity, createdAt: Date.now() };
    this.blacklist.push(record);
    return record;
  }

  /** 移除黑名单模式 */
  removeBlacklistPattern(id: string): boolean {
    const idx = this.blacklist.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.blacklist.splice(idx, 1);
    return true;
  }

  /** 获取扫描审计日志 */
  getAuditLog(limit = 100): Array<{ toolName: string; riskScore: number; recommendation: string; threats: number; timestamp: number }> {
    return this.scanAuditLog.slice(-limit);
  }
}
