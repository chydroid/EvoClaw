import {
  ServiceRegistry,
  EventBus,
  type AuditRecord,
  type AuditEventType,
  type SecuritySeverity,
} from "@evoclaw/core";
import { v4 } from "uuid";

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

export class AuditCenter {
  private records: AuditRecord[] = [];
  private alerts: AuditAlert[] = [];
  private rules: AuditRule[] = [];
  private maxRecords = 10000;
  private maxAlerts = 1000;
  private alertThrottles = new Map<string, number>();

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
    const record: AuditRecord = {
      ...entry,
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

  clearRecords(): void {
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

  async healthCheck(): Promise<boolean> {
    return true;
  }
}