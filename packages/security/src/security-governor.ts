import {
  ServiceRegistry,
  EventBus,
  SystemEvents,
  type SecurityPolicy,
  type SandboxConfig,
  type SandboxResult,
  type PrivacyConfig,
} from "@evoclaw/core";
import { AuditLogger } from "./audit-logger";
import { RateLimiterService } from "./rate-limiter";
import { AnomalyDetector } from "./anomaly-detector";

export class SecurityGovernor {
  private policies: SecurityPolicy[] = [];
  private auditLogger: AuditLogger;
  private rateLimiter: RateLimiterService;
  private anomalyDetector: AnomalyDetector;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.auditLogger = new AuditLogger(registry, eventBus);
    this.rateLimiter = new RateLimiterService(registry, eventBus);
    this.anomalyDetector = new AnomalyDetector(registry, eventBus);

    registry.registerService("securityGovernor", this);

    this.loadDefaultPolicies();
    eventBus.subscribe("security.alert", async (event) => {
      await this.auditLogger.log({
        timestamp: new Date(),
        actor: event.source,
        action: "security_alert",
        resource: event.type,
        result: "blocked",
        details: event.data as Record<string, unknown>,
        traceId: event.id,
        ipAddress: "system",
        userAgent: "evoclaw",
      });
    });
  }

  private loadDefaultPolicies(): void {
    this.policies = [
      {
        name: "default-deny",
        rules: [
          {
            id: "allow-internal",
            type: "access",
            condition: { field: "source", operator: "equals", value: "internal" },
            action: "allow",
            description: "Allow internal service communication",
          },
          {
            id: "block-exec-unknown",
            type: "execution",
            condition: { field: "trusted", operator: "equals", value: false },
            action: "deny",
            description: "Block execution of untrusted code",
          },
        ],
        defaultAction: "deny",
        priority: 100,
      },
      {
        name: "rate-limit",
        rules: [
          {
            id: "global-rate-limit",
            type: "rate_limit",
            condition: { field: "requestCount", operator: "gt", value: 1000 },
            action: "deny",
            description: "Global rate limit exceeded",
          },
        ],
        defaultAction: "allow",
        priority: 50,
      },
    ];
  }

  evaluatePolicy(context: Record<string, unknown>): "allow" | "deny" {
    for (const policy of this.policies.sort((a, b) => b.priority - a.priority)) {
      for (const rule of policy.rules) {
        const fieldValue = context[rule.condition.field];
        if (this.matchCondition(rule.condition, fieldValue)) {
          return rule.action === "allow" ? "allow" : "deny";
        }
      }
      return policy.defaultAction;
    }
    return "allow";
  }

  private matchCondition(
    condition: { operator: string; value: unknown },
    actual: unknown
  ): boolean {
    switch (condition.operator) {
      case "equals":
        return actual === condition.value;
      case "contains":
        return typeof actual === "string" && actual.includes(String(condition.value));
      case "gt":
        return Number(actual) > Number(condition.value);
      case "lt":
        return Number(actual) < Number(condition.value);
      case "in":
        return Array.isArray(condition.value) && condition.value.includes(actual);
      case "exists":
        return actual !== undefined && actual !== null;
      default:
        return false;
    }
  }

  getAuditLogger(): AuditLogger {
    return this.auditLogger;
  }

  getRateLimiter(): RateLimiterService {
    return this.rateLimiter;
  }

  getDefaultSandboxConfig(): SandboxConfig {
    return {
      maxExecutionTime: 30000,
      maxMemoryMB: 128,
      allowNetwork: false,
      allowFileSystem: true,
      allowedHosts: [],
      allowedPaths: [],
      environment: {},
    };
  }

  getDefaultPrivacyConfig(): PrivacyConfig {
    return {
      enableDifferentialPrivacy: false,
      epsilon: 1.0,
      delta: 1e-5,
      enableHomomorphicEncryption: false,
      enableFederatedLearning: false,
      dataRetentionDays: 90,
      anonymizeFields: ["email", "phone", "ipAddress"],
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}