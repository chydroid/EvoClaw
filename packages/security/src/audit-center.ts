import {
  ServiceRegistry,
  EventBus,
  type AuditRecord,
  type AuditEventType,
  type SecuritySeverity,
} from "@evoclaw/core";
import { v4 } from "uuid";
import { auditConfig, type ConfigAuditInput } from "./audit-config";
import { auditChannels, type ChannelAuditInput } from "./audit-channel";
import { auditToolPolicy, type ToolPolicyAuditInput } from "./audit-tool-policy";
import { auditTrustModel, type TrustModelAuditInput } from "./audit-trust-model";
import {
  auditGatewayExposure,
  type GatewayExposureAuditInput,
} from "./audit-gateway-exposure";
import { TranscriptRedactor } from "./transcript-redactor";

export interface AuditQuery {
  startTime?: Date;
  endTime?: Date;
  eventTypes?: AuditEventType[];
  severities?: SecuritySeverity[];
  userId?: string;
  source?: string;
  keywords?: string[];
  limit?: number;
  offset?: number;
}

export interface AuditStatistics {
  totalEvents: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  bySource: Record<string, number>;
  byHour: number[];
  topUsers: Array<{ userId: string; count: number }>;
  topEvents: Array<{ eventType: string; count: number }>;
  timeRange: { earliest: Date; latest: Date };
}

export interface AuditAlert {
  id: string;
  rule: string;
  severity: SecuritySeverity;
  description: string;
  triggeredAt: Date;
  relatedRecords: string[];
  acknowledged: boolean;
}

export interface AuditRule {
  name: string;
  description: string;
  condition: (events: AuditRecord[]) => boolean;
  severity: SecuritySeverity;
  cooldownMs: number;
  windowMs?: number;
}

// ═══════════════════════════════════════════════════════════
// 综合审计：合并 5 个专项 audit 模块的发现并按 severity 排序
// ═══════════════════════════════════════════════════════════

export type ComprehensiveAuditModule =
  | "config"
  | "channel"
  | "tool-policy"
  | "trust-model"
  | "gateway";

export type ComprehensiveAuditSeverity = "info" | "warning" | "error";

export interface ComprehensiveAuditFinding {
  module: ComprehensiveAuditModule;
  severity: ComprehensiveAuditSeverity;
  rule: string;
  message: string;
  suggestion?: string;
  /** 配置路径（config 模块） */
  path?: string;
  /** 渠道标识（channel 模块） */
  channelId?: string;
  channelType?: string;
  /** agent 标识（tool-policy 模块） */
  agentId?: string;
  /** 实体标识（trust-model 模块） */
  entityId?: string;
  entityType?: "skill" | "agent";
}

export interface ComprehensiveAuditInput {
  config?: ConfigAuditInput;
  channels?: ChannelAuditInput;
  toolPolicies?: ToolPolicyAuditInput;
  trustModel?: TrustModelAuditInput;
  gateway?: GatewayExposureAuditInput;
}

export interface ComprehensiveAuditSummary {
  total: number;
  bySeverity: Record<ComprehensiveAuditSeverity, number>;
  byModule: Record<ComprehensiveAuditModule, number>;
}

export interface ComprehensiveAuditResult {
  findings: ComprehensiveAuditFinding[];
  summary: ComprehensiveAuditSummary;
}

// severity 排序权重：error > warning > info
const SEVERITY_ORDER: Record<ComprehensiveAuditSeverity, number> = {
  error: 3,
  warning: 2,
  info: 1,
};

export class AuditCenter {
  private records: AuditRecord[] = [];
  private alerts: AuditAlert[] = [];
  private rules: AuditRule[] = [];
  private maxRecords = 10000;
  private maxAlerts = 1000;
  private alertThrottles = new Map<string, number>();
  /** 脱敏器：审计记录入库前自动遮蔽 API key/token/邮箱等敏感信息，
   *  防止审计日志本身成为敏感数据泄漏源。 */
  private redactor = new TranscriptRedactor();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    registry.registerService("auditCenter", this);

    this.registerDefaultRules();

    this.eventBus.subscribe("security.audit", async (event) => {
      if (event.data && typeof event.data === "object") {
        this.record(event.data as unknown as AuditRecord);
      }
    });

    this.eventBus.subscribe("system.*", async (event) => {
      this.recordSystemEvent(event.type, event.data as Record<string, unknown> | undefined, event.source);
    });
  }

  record(entry: Omit<AuditRecord, "timestamp">): void {
    // 脱敏：对 description 和 metadata 中的字符串值进行敏感信息遮蔽，
    // 防止 API key、token、邮箱等写入审计日志后被二次泄漏。
    const redactedDescription = this.redactor.redact(entry.description || "").text;
    const redactedMetadata = this.redactor.redactObject(entry.metadata || {});

    const record: AuditRecord = {
      ...entry,
      description: redactedDescription,
      metadata: redactedMetadata as Record<string, unknown>,
      timestamp: new Date(),
    };

    this.records.push(record);

    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }

    this.evaluateRules(record);
  }

  private recordSystemEvent(
    eventType: string,
    data?: Record<string, unknown>,
    source?: string
  ): void {
    let auditType: AuditEventType = "operation";
    let severity: SecuritySeverity = "info";

    if (eventType.includes("error") || eventType.includes("fail")) {
      severity = "error";
    } else if (eventType.includes("warning")) {
      severity = "warning";
    }

    if (eventType.includes("skill")) auditType = "skill_execution";
    else if (eventType.includes("evolution")) auditType = "evolution";
    else if (eventType.includes("auth")) auditType = "authentication";
    else if (eventType.includes("memory")) auditType = "data_access";

    this.record({
      eventType: auditType,
      severity,
      userId: "system",
      source: source || "system",
      description: eventType,
      metadata: data || {},
    });
  }

  query(query: AuditQuery = {}): { records: AuditRecord[]; total: number } {
    let filtered = [...this.records];

    if (query.startTime) {
      filtered = filtered.filter((r) => r.timestamp >= query.startTime!);
    }
    if (query.endTime) {
      filtered = filtered.filter((r) => r.timestamp <= query.endTime!);
    }
    if (query.eventTypes?.length) {
      filtered = filtered.filter((r) => query.eventTypes!.includes(r.eventType));
    }
    if (query.severities?.length) {
      filtered = filtered.filter((r) => query.severities!.includes(r.severity));
    }
    if (query.userId) {
      filtered = filtered.filter((r) => r.userId === query.userId);
    }
    if (query.source) {
      filtered = filtered.filter((r) => r.source === query.source);
    }
    if (query.keywords?.length) {
      filtered = filtered.filter(
        (r) => query.keywords!.some((kw) =>
          r.description.toLowerCase().includes(kw.toLowerCase())
        )
      );
    }

    filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const total = filtered.length;
    const offset = query.offset || 0;
    const limit = query.limit || 50;

    return {
      records: filtered.slice(offset, offset + limit),
      total,
    };
  }

  getStatistics(): AuditStatistics {
    const records = this.records;
    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const byHour: number[] = new Array(24).fill(0);
    const userCounts = new Map<string, number>();
    const eventCounts = new Map<string, number>();

    let earliest = new Date();
    let latest = new Date(0);

    for (const record of records) {
      byType[record.eventType] = (byType[record.eventType] || 0) + 1;
      bySeverity[record.severity] = (bySeverity[record.severity] || 0) + 1;
      bySource[record.source] = (bySource[record.source] || 0) + 1;
      byHour[record.timestamp.getHours()]++;

      userCounts.set(record.userId, (userCounts.get(record.userId) || 0) + 1);
      eventCounts.set(record.eventType, (eventCounts.get(record.eventType) || 0) + 1);

      if (record.timestamp < earliest) earliest = record.timestamp;
      if (record.timestamp > latest) latest = record.timestamp;
    }

    const topUsers = Array.from(userCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([userId, count]) => ({ userId, count }));

    const topEvents = Array.from(eventCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([eventType, count]) => ({ eventType, count }));

    return {
      totalEvents: records.length,
      byType,
      bySeverity,
      bySource,
      byHour,
      topUsers,
      topEvents,
      timeRange: { earliest, latest },
    };
  }

  getAlerts(acknowledged?: boolean): AuditAlert[] {
    if (acknowledged === undefined) return [...this.alerts];
    return this.alerts.filter((a) => a.acknowledged === acknowledged);
  }

  acknowledgeAlert(alertId: string): boolean {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      return true;
    }
    return false;
  }

  addRule(rule: AuditRule): void {
    this.rules.push(rule);
  }

  removeRule(name: string): void {
    this.rules = this.rules.filter((r) => r.name !== name);
  }

  getRules(): AuditRule[] {
    return [...this.rules];
  }

  /**
   * 清空审计记录。需要管理员鉴权：调用方必须提供包含 "admin" 角色的 caller，
   * 否则拒绝执行。清空操作会记录警告日志，防止审计日志被无声抹除。
   */
  clearRecords(caller?: { userId?: string; roles?: string[] }): void {
    const userId = caller?.userId ?? "unknown";
    const roles = caller?.roles ?? [];
    if (!roles.includes("admin")) {
      process.stderr.write(
        `[AuditCenter] clearRecords DENIED for caller=${userId} roles=${JSON.stringify(roles)}\n`
      );
      throw new Error(
        `Access denied: clearing audit records requires admin role (caller: ${userId})`,
      );
    }
    process.stderr.write(
      `[AuditCenter] clearRecords by admin=${userId}, clearing ${this.records.length} records\n`
    );
    this.records = [];
  }

  private registerDefaultRules(): void {
    this.rules = [
      {
        name: "brute_force_detect",
        description: "Detect potential brute force attacks",
        condition: (events) => {
          const recent = events
            .filter((e) => e.eventType === "authentication" && e.severity === "error")
            .filter((e) => Date.now() - e.timestamp.getTime() < 60000);
          return recent.length >= 5;
        },
        severity: "critical",
        cooldownMs: 300000,
      },
      {
        name: "excessive_errors",
        description: "Detect unusual error spikes",
        condition: (events) => {
          const recent = events
            .filter((e) => e.severity === "error")
            .filter((e) => Date.now() - e.timestamp.getTime() < 60000);
          return recent.length >= 10;
        },
        severity: "warning",
        cooldownMs: 120000,
      },
      {
        name: "unauthorized_skill_access",
        description: "Detect unauthorized skill execution attempts",
        condition: (events) => {
          return events.some(
            (e) =>
              e.eventType === "skill_execution" &&
              e.severity === "error" &&
              e.description.includes("denied")
          );
        },
        severity: "high",
        cooldownMs: 60000,
      },
    ];
  }

  private evaluateRules(record: AuditRecord): void {
    for (const rule of this.rules) {
      const lastAlert = this.alertThrottles.get(rule.name);
      if (lastAlert && Date.now() - lastAlert < rule.cooldownMs) continue;

      const windowMs = rule.windowMs ?? rule.cooldownMs ?? 60000;
      const relevantEvents = this.records.filter(
        (r) => Date.now() - r.timestamp.getTime() < windowMs
      );

      if (rule.condition(relevantEvents)) {
        const alert: AuditAlert = {
          id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          rule: rule.name,
          severity: rule.severity,
          description: rule.description,
          triggeredAt: new Date(),
          relatedRecords: [record.timestamp.toISOString()],
          acknowledged: false,
        };

        this.alerts.push(alert);
        if (this.alerts.length > this.maxAlerts) {
          this.alerts = this.alerts.slice(-this.maxAlerts);
        }
        this.alertThrottles.set(rule.name, Date.now());

        this.eventBus?.publish(
          "security.alert_triggered",
          { alert },
          "audit-center"
        ).catch((err) => process.stderr.write('[AuditCenter] event publish failed: ' + err + '\n'));
      }
    }
  }

  /**
   * 综合审计：依次调用 5 个专项 audit 模块（config/channel/toolPolicy/trustModel/gateway），
   * 合并所有发现并按 severity 降序排序（error > warning > info）。
   * 仅审计 input 中显式提供的模块；未提供的模块跳过。
   */
  runComprehensiveAudit(input: ComprehensiveAuditInput): ComprehensiveAuditResult {
    const findings: ComprehensiveAuditFinding[] = [];

    if (input.config) {
      for (const f of auditConfig(input.config)) {
        findings.push({
          module: "config",
          severity: f.severity,
          rule: f.rule,
          message: f.message,
          suggestion: f.suggestion,
          path: f.path,
        });
      }
    }

    if (input.channels) {
      for (const f of auditChannels(input.channels)) {
        findings.push({
          module: "channel",
          severity: f.severity,
          rule: f.rule,
          message: f.message,
          suggestion: f.suggestion,
          channelId: f.channelId,
          channelType: f.channelType,
        });
      }
    }

    if (input.toolPolicies) {
      for (const f of auditToolPolicy(input.toolPolicies)) {
        findings.push({
          module: "tool-policy",
          severity: f.severity,
          rule: f.rule,
          message: f.message,
          suggestion: f.suggestion,
          agentId: f.agentId,
        });
      }
    }

    if (input.trustModel) {
      for (const f of auditTrustModel(input.trustModel)) {
        findings.push({
          module: "trust-model",
          severity: f.severity,
          rule: f.rule,
          message: f.message,
          suggestion: f.suggestion,
          entityId: f.entityId,
          entityType: f.entityType,
        });
      }
    }

    if (input.gateway) {
      for (const f of auditGatewayExposure(input.gateway)) {
        findings.push({
          module: "gateway",
          severity: f.severity,
          rule: f.rule,
          message: f.message,
          suggestion: f.suggestion,
        });
      }
    }

    // 按 severity 降序排序（error 优先），同 severity 保持稳定顺序
    findings.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);

    const summary: ComprehensiveAuditSummary = {
      total: findings.length,
      bySeverity: { error: 0, warning: 0, info: 0 },
      byModule: {
        config: 0,
        channel: 0,
        "tool-policy": 0,
        "trust-model": 0,
        gateway: 0,
      },
    };
    for (const f of findings) {
      summary.bySeverity[f.severity]++;
      summary.byModule[f.module]++;
    }

    return { findings, summary };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}