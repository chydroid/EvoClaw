/**
 * Formal Verification — MITRE ATLAS security verification adapter.
 *
 * MITRE ATLAS (Adversarial Threat Landscape for Artificial-Intelligence Systems)
 * is a knowledge base of adversary tactics, techniques, and case studies for AI
 * systems. This module provides:
 *
 *  - Threat model definitions based on ATLAS taxonomy
 *  - Runtime validation of agent behavior against threat patterns
 *  - Security scoring for agent actions and outputs
 *  - Verification reports for compliance and auditing
 *  - Integration with the event ledger for audit trails
 *
 * Based on: https://atlas.mitre.org/
 */

import type { LedgerEntry, LedgerEventType } from "./event-ledger";
import { isUnsafeRegex } from "@evoclaw/security";

// ── MITRE ATLAS Taxonomy ─────────────────────────────────

/**
 * ATLAS tactic IDs mapped to descriptions.
 * Source: MITRE ATLAS v4.0.0
 */
export const ATLAS_TACTICS = {
  /** Reconnaissance — gather information about the AI system */
  TA0040: "Reconnaissance",
  /** Resource Development — acquire resources to support operations */
  TA0041: "Resource Development",
  /** Initial Access — gain initial access to the AI system */
  TA0042: "Initial Access",
  /** ML Model Access — obtain access to the ML model */
  TA0043: "ML Model Access",
  /** Execution — run adversarial code or techniques */
  TA0044: "Execution",
  /** Persistence — maintain access across restarts */
  TA0045: "Persistence",
  /** Defense Evasion — avoid detection */
  TA0046: "Defense Evasion",
  /** Discovery — learn about the AI environment */
  TA0047: "Discovery",
  /** Collection — gather AI-related information */
  TA0048: "Collection",
  /** ML Attack Staging — prepare ML-specific attacks */
  TA0049: "ML Attack Staging",
  /** Exfiltration — steal data or model artifacts */
  TA0050: "Exfiltration",
  /** Impact — manipulate, disrupt, or destroy AI systems */
  TA0051: "Impact",
} as const;

export type AtlasTacticId = keyof typeof ATLAS_TACTICS;

export interface AtlasTechnique {
  id: string;        // e.g., "T1553.002"
  name: string;      // e.g., "Poison Training Data"
  tacticId: AtlasTacticId;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  detectionPatterns: DetectionPattern[];
}

export interface DetectionPattern {
  type: "regex" | "keyword" | "behavior" | "api_call";
  pattern: string;
  description: string;
  confidence?: number; // 0-1
}

// ── Threat Definitions ────────────────────────────────────

/**
 * Pre-defined ATLAS techniques relevant to AI agent systems.
 * These are the most common threats for LLM-based agents.
 */
const AGENT_THREATS: AtlasTechnique[] = [
  // ── ML Model Access ──
  {
    id: "AML.T0043.000",
    name: "Model Inversion",
    tacticId: "TA0043",
    description: "Extract training data or model internals through crafted prompts",
    severity: "high",
    detectionPatterns: [
      { type: "keyword", pattern: "system prompt", description: "Probing for system prompt extraction" },
      { type: "keyword", pattern: "training data", description: "Requesting training data" },
      { type: "keyword", pattern: "what are your instructions", description: "Prompt extraction attempt" },
      { type: "keyword", pattern: "ignore previous", description: "Instruction override attempt" },
    ],
  },
  {
    id: "AML.T0043.001",
    name: "Model Extraction",
    tacticId: "TA0043",
    description: "Replicate model behavior through extensive querying",
    severity: "medium",
    detectionPatterns: [
      { type: "behavior", pattern: "high_query_volume", description: "Unusually high query rate" },
      { type: "keyword", pattern: "repeat what you said", description: "Output replication patterns" },
    ],
  },
  // ── Execution ──
  {
    id: "AML.T0044.000",
    name: "Prompt Injection",
    tacticId: "TA0044",
    description: "Inject malicious instructions through user input",
    severity: "critical",
    detectionPatterns: [
      { type: "regex", pattern: "(?:ignore|disregard|forget)\\s+(?:all\\s+)?(?:previous|above)", description: "Instruction override" },
      { type: "regex", pattern: "(?:you\\s+are\\s+now|you\\s+must|you\\s+should\\s+only)", description: "Role reassignment" },
      { type: "regex", pattern: "(?:(?:print|output|repeat|say)\\s+(?:the\\s+)?(?:system\\s+)?prompt)", description: "Prompt exfiltration" },
      { type: "keyword", pattern: "[INST]", description: "Llama-format injection" },
      { type: "keyword", pattern: "<|im_start|>", description: "ChatML injection delimiter" },
    ],
  },
  {
    id: "AML.T0044.001",
    name: "Indirect Prompt Injection",
    tacticId: "TA0044",
    description: "Inject instructions through external content (web pages, documents)",
    severity: "critical",
    detectionPatterns: [
      { type: "behavior", pattern: "content_reinterpretation", description: "Content storing hidden instructions" },
      { type: "keyword", pattern: "instructions for the AI", description: "Hidden AI instructions in content" },
    ],
  },
  // ── Defense Evasion ──
  {
    id: "AML.T0046.000",
    name: "Sandbox Evasion",
    tacticId: "TA0046",
    description: "Attempt to break out of execution sandbox",
    severity: "critical",
    detectionPatterns: [
      { type: "regex", pattern: "(?:chmod|sudo|su\\s|-o\\s+remount|mount\\s+-o)", description: "Privilege escalation" },
      { type: "regex", pattern: "(?:nc\\s+-[el]|socat|telnet|ncat)", description: "Reverse shell" },
      { type: "regex", pattern: "(?:/etc/(?:passwd|shadow|sudoers)|/proc/self)", description: "System file access" },
      { type: "keyword", pattern: "base64 -d", description: "Encoded payload execution" },
    ],
  },
  // ── Exfiltration ──
  {
    id: "AML.T0050.000",
    name: "Data Exfiltration via Agent",
    tacticId: "TA0050",
    description: "Use the agent to exfiltrate sensitive data",
    severity: "high",
    detectionPatterns: [
      { type: "regex", pattern: "(?:curl|wget|fetch)\\s+.*\\|\\s*(?:base64|nc|send)", description: "Piping data to external endpoint" },
      { type: "keyword", pattern: ".env", description: "Environment file access" },
      { type: "keyword", pattern: "api_key", description: "API key probing" },
      { type: "regex", pattern: "(?:aws_access_key|AWS_SECRET|GITHUB_TOKEN|NPM_TOKEN)", description: "Secret token access" },
    ],
  },
  // ── Impact ──
  {
    id: "AML.T0051.000",
    name: "Agent Manipulation",
    tacticId: "TA0051",
    description: "Cause the agent to take harmful or unauthorized actions",
    severity: "high",
    detectionPatterns: [
      { type: "regex", pattern: "(?:rm\\s+-rf|del\\s+/[fsq]|format\\s+[a-z]:)", description: "Destructive file operations" },
      { type: "regex", pattern: "(?:shutdown|reboot|halt|poweroff)", description: "System disruption" },
      { type: "keyword", pattern: "drop table", description: "Database destruction" },
    ],
  },
];

// ── Verification Types ────────────────────────────────────

export interface ThreatMatch {
  technique: AtlasTechnique;
  pattern: DetectionPattern;
  matchedText: string;
  confidence: number;
  timestamp: number;
}

export interface VerificationResult {
  /** Overall pass/fail */
  passed: boolean;
  /** Total checks performed */
  checksTotal: number;
  /** Checks that raised threats */
  threatsDetected: number;
  /** Detailed threat matches */
  matches: ThreatMatch[];
  /** Risk score (0-100) */
  riskScore: number;
  /** Recommendations for mitigation */
  recommendations: string[];
}

export interface RuntimeCheckContext {
  /** User message being processed */
  userMessage?: string;
  /** Agent's response */
  agentResponse?: string;
  /** System prompt being used */
  systemPrompt?: string;
  /** Tool calls being made */
  toolCalls?: Array<{ name: string; arguments: string }>;
  /** Command being executed (for sandbox) */
  command?: string;
  /** File paths being accessed */
  filePaths?: string[];
  /** Session context */
  sessionId?: string;
}

export interface VerificationConfig {
  /** Minimum confidence to report a match (0-1) */
  minConfidence?: number;
  /** Severity levels to check */
  severities?: Array<"low" | "medium" | "high" | "critical">;
  /** Whether to block on critical threats */
  blockOnCritical?: boolean;
  /** Whether to log all checks to the event ledger */
  auditMode?: boolean;
  /** Custom threat definitions (on top of built-in) */
  customThreats?: AtlasTechnique[];
}

// ── Verifier Implementation ──────────────────────────────

export class FormalVerifier {
  private config: Required<VerificationConfig>;
  private threats: AtlasTechnique[];
  /** 内置威胁 ID 集合。这些是源码中硬编码的受信任模式，不需要 ReDoS 检查。 */
  private builtInThreatIds: Set<string>;
  private matchHistory: ThreatMatch[] = [];

  constructor(config: VerificationConfig = {}) {
    this.config = {
      minConfidence: config.minConfidence ?? 0.6,
      severities: config.severities ?? ["high", "critical"],
      blockOnCritical: config.blockOnCritical ?? true,
      auditMode: config.auditMode ?? true,
      customThreats: config.customThreats ?? [],
    };
    this.builtInThreatIds = new Set(AGENT_THREATS.map((t) => t.id));
    this.threats = [...AGENT_THREATS, ...(config.customThreats ?? [])];
  }

  // ── Runtime Verification ────────────────────────────────

  /**
   * Run a full verification check against a runtime context.
   * Returns a VerificationResult with matches and recommendations.
   */
  verify(context: RuntimeCheckContext): VerificationResult {
    const matches: ThreatMatch[] = [];

    // Check user message
    if (context.userMessage) {
      matches.push(...this.scanText(context.userMessage, "user_message"));
    }

    // Check agent response for potential exfiltration
    if (context.agentResponse) {
      matches.push(...this.scanText(context.agentResponse, "agent_response"));
    }

    // Check system prompt tampering
    if (context.systemPrompt) {
      matches.push(...this.scanText(context.systemPrompt, "system_prompt"));
    }

    // Check tool calls for dangerous operations
    if (context.toolCalls) {
      for (const tc of context.toolCalls) {
        matches.push(...this.scanText(tc.name + " " + tc.arguments, "tool_call"));
      }
    }

    // Check commands for sandbox escape
    if (context.command) {
      matches.push(...this.scanText(context.command, "command_execution"));
    }

    // Check file paths
    if (context.filePaths) {
      for (const fp of context.filePaths) {
        matches.push(...this.scanText(fp, "file_access"));
      }
    }

    // Store matches in history
    this.matchHistory.push(...matches);

    // Calculate risk score
    const riskScore = this.calculateRiskScore(matches);
    const threatsDetected = matches.length;
    const passed = threatsDetected === 0 ||
      (!this.config.blockOnCritical || !matches.some((m) => m.technique.severity === "critical"));

    const recommendations = this.generateRecommendations(matches);

    return {
      passed,
      checksTotal: this.countChecks(context),
      threatsDetected,
      matches,
      riskScore,
      recommendations,
    };
  }

  /**
   * Quick pre-flight check for prompt injection in user messages.
   * Returns true if the message appears safe.
   */
  isSafePrompt(message: string, minConfidence?: number): boolean {
    const matches = this.scanText(message, "user_message");
    const critical = matches.filter(
      (m) =>
        m.technique.severity === "critical" &&
        m.confidence >= (minConfidence ?? this.config.minConfidence)
    );
    return critical.length === 0;
  }

  /**
   * Validate a generated response doesn't leak system info.
   */
  validateResponse(response: string): { safe: boolean; leaks: string[] } {
    const sensitivePatterns = [
      { pattern: /system prompt/i, label: "System prompt reference" },
      { pattern: /your instructions are/i, label: "Instruction reveal" },
      { pattern: /I am configured to/i, label: "Configuration leak" },
      { pattern: /my training data includes/i, label: "Training data reference" },
      { pattern: /as an AI (?:created|developed|built) by/i, label: "Origin disclosure" },
    ];

    const leaks: string[] = [];
    for (const sp of sensitivePatterns) {
      if (sp.pattern.test(response)) {
        leaks.push(sp.label);
      }
    }

    return { safe: leaks.length === 0, leaks };
  }

  // ── ATLAS Report Generation ─────────────────────────────

  /**
   * Generate a MITRE ATLAS-compatible threat report.
   */
  generateReport(): string {
    const allMatches = [...this.matchHistory];
    const tacticCounts = new Map<string, number>();
    const severityCounts = new Map<string, number>();

    for (const match of allMatches) {
      const tactic = match.technique.tacticId;
      tacticCounts.set(tactic, (tacticCounts.get(tactic) ?? 0) + 1);
      const severity = match.technique.severity;
      severityCounts.set(severity, (severityCounts.get(severity) ?? 0) + 1);
    }

    const riskScore = this.calculateRiskScore(allMatches);

    let report = "MITRE ATLAS THREAT REPORT\n";
    report += "=========================\n\n";
    report += `Generated: ${new Date().toISOString()}\n`;
    report += `Total Matches: ${allMatches.length}\n`;
    report += `Risk Score: ${riskScore}/100\n\n`;

    report += "## Tactic Summary\n";
    for (const [tacticId, count] of tacticCounts) {
      const name = ATLAS_TACTICS[tacticId as AtlasTacticId] ?? tacticId;
      report += `  ${tacticId} (${name}): ${count} matches\n`;
    }

    report += "\n## Severity Summary\n";
    for (const [severity, count] of severityCounts) {
      report += `  ${severity}: ${count} matches\n`;
    }

    if (allMatches.length > 0) {
      report += "\n## Detailed Matches\n";
      for (let i = 0; i < Math.min(allMatches.length, 20); i++) {
        const m = allMatches[i];
        report += `\n  [${i + 1}] ${m.technique.id} ${m.technique.name}\n`;
        report += `      Tactic: ${m.technique.tacticId} (${ATLAS_TACTICS[m.technique.tacticId] ?? "Unknown"})\n`;
        report += `      Severity: ${m.technique.severity}\n`;
        report += `      Confidence: ${(m.confidence * 100).toFixed(0)}%\n`;
        report += `      Pattern: ${m.pattern.description}\n`;
        report += `      Match: "${m.matchedText.slice(0, 200)}"\n`;
      }

      if (allMatches.length > 20) {
        report += `\n  ... and ${allMatches.length - 20} more matches\n`;
      }
    }

    return report;
  }

  /**
   * Export matches as a structured ledger entry for audit trails.
   */
  toLedgerEntries(sessionId: string): Array<{
    type: LedgerEventType;
    event: Record<string, unknown>;
  }> {
    return this.matchHistory
      .filter((m) => m.technique.severity === "high" || m.technique.severity === "critical")
      .map((m) => ({
        type: "security_event" as LedgerEventType,
        event: {
          sessionId,
          techniqueId: m.technique.id,
          techniqueName: m.technique.name,
          tacticId: m.technique.tacticId,
          severity: m.technique.severity,
          confidence: m.confidence,
          pattern: m.pattern.description,
          matchedText: m.matchedText.slice(0, 500),
          timestamp: m.timestamp,
        },
      }));
  }

  // ── Management ──────────────────────────────────────────

  /** Reset all match history */
  resetHistory(): void {
    this.matchHistory = [];
  }

  /** Get match history */
  getHistory(): readonly ThreatMatch[] {
    return this.matchHistory;
  }

  /** Get total matches since last reset */
  get totalMatches(): number {
    return this.matchHistory.length;
  }

  /** Add custom threat definitions */
  addThreat(threat: AtlasTechnique): void {
    this.threats.push(threat);
  }

  /** Remove custom threat definitions by ID */
  removeThreat(id: string): void {
    // Don't remove built-in threats
    if (this.builtInThreatIds.has(id)) {
      process.stderr.write(`[FormalVerifier] Cannot remove built-in threat "${id}"\n`);
      return;
    }
    this.threats = this.threats.filter((t) => t.id !== id);
  }

  /** List all active threat definitions */
  listThreats(): AtlasTechnique[] {
    return [...this.threats];
  }

  // ── Internal ────────────────────────────────────────────

  private scanText(text: string, source: string): ThreatMatch[] {
    const matches: ThreatMatch[] = [];
    const now = Date.now();

    for (const threat of this.threats) {
      // Filter by configured severity
      if (!this.config.severities.includes(threat.severity)) continue;

      // ReDoS 检查仅对用户提供的 customThreats 生效。
      // 内置 AGENT_THREATS 是源码中硬编码的受信任模式（已审计），
      // 且部分模式被 isUnsafeRegex 误报为 critical（如嵌套量词启发式
      // 对 (?:all\s+)? 等安全模式产生假阳性），因此跳过检查。
      const isBuiltIn = this.builtInThreatIds.has(threat.id);

      for (const pattern of threat.detectionPatterns) {
        let matched = false;
        let matchedText = "";

        switch (pattern.type) {
          case "regex":
            try {
              if (!isBuiltIn && isUnsafeRegex(pattern.pattern)) break;
              const regex = new RegExp(pattern.pattern, "i");
              const match = regex.exec(text);
              if (match) {
                matched = true;
                matchedText = match[0];
              }
            } catch {
              // Skip invalid regex
            }
            break;

          case "keyword":
            if (text.toLowerCase().includes(pattern.pattern.toLowerCase())) {
              matched = true;
              matchedText = pattern.pattern;
            }
            break;

          case "behavior":
            // Behavior patterns are handled externally
            break;

          case "api_call":
            // API 调用模式通过工具调用签名在外部行为分析中检测，文本扫描阶段不处理
            break;

          default:
            // 未知 pattern.type 不静默跳过，落日志便于排查配置/类型扩展遗漏
            process.stderr.write(
              `[FormalVerification] Unknown detection pattern type: ${pattern.type}\n`,
            );
            break;
        }

        if (matched) {
          const confidence = pattern.confidence ?? 0.8;

          if (confidence >= this.config.minConfidence) {
            matches.push({
              technique: threat,
              pattern,
              matchedText,
              confidence,
              timestamp: now,
            });
          }
        }
      }
    }

    return matches;
  }

  private calculateRiskScore(matches: ThreatMatch[]): number {
    if (matches.length === 0) return 0;

    const severityWeights: Record<string, number> = {
      critical: 25,
      high: 15,
      medium: 5,
      low: 1,
    };

    let totalWeight = 0;
    for (const match of matches) {
      const weight = severityWeights[match.technique.severity] ?? 5;
      totalWeight += weight * match.confidence;
    }

    // Scale to 0-100, cap at 100
    return Math.min(100, Math.round(totalWeight));
  }

  private countChecks(context: RuntimeCheckContext): number {
    let count = 0;
    if (context.userMessage) count += this.threats.length;
    if (context.agentResponse) count += this.threats.length;
    if (context.toolCalls) count += context.toolCalls.length * this.threats.length;
    if (context.command) count += this.threats.length;
    if (context.filePaths) count += context.filePaths.length * this.threats.length;
    return count;
  }

  private generateRecommendations(matches: ThreatMatch[]): string[] {
    if (matches.length === 0) {
      return ["No threats detected. Continue normal operations."];
    }

    const recs: string[] = [];
    const tacticsSeen = new Set<string>();
    const severitiesSeen = new Set<string>();

    for (const match of matches) {
      tacticsSeen.add(match.technique.tacticId);
      severitiesSeen.add(match.technique.severity);
    }

    if (tacticsSeen.has("TA0044")) {
      recs.push("Enable input sanitization filters for prompt injection detection.");
    }
    if (tacticsSeen.has("TA0046")) {
      recs.push("Review sandbox configuration: ensure --no-new-privileges and restricted capabilities.");
    }
    if (tacticsSeen.has("TA0050")) {
      recs.push("Audit file access permissions and restrict sensitive path access.");
    }
    if (tacticsSeen.has("TA0051")) {
      recs.push("Add confirmation prompts for destructive operations (rm, drop, format).");
    }
    if (tacticsSeen.has("TA0043")) {
      recs.push("Implement rate limiting to prevent model extraction via excessive querying.");
    }
    if (severitiesSeen.has("critical")) {
      recs.push("CRITICAL: Review and block the triggering requests immediately.");
    }

    return recs.length > 0 ? recs : ["Monitor threats closely and review security policies."];
  }
}