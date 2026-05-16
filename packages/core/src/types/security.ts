export interface SecurityPolicy {
  name: string;
  rules: SecurityRule[];
  defaultAction: "allow" | "deny";
  priority: number;
}

export type AuditEventType = "authentication" | "authorization" | "operation" | "data_access" | "configuration" | "skill_execution" | "evolution" | "system";

export type SecuritySeverity = "info" | "low" | "warning" | "high" | "error" | "critical";

export interface AuditRecord {
  eventType: AuditEventType;
  severity: SecuritySeverity;
  userId: string;
  source: string;
  description: string;
  metadata: Record<string, unknown>;
  timestamp: Date;
}

export interface SecurityRule {
  id: string;
  type: "access" | "rate_limit" | "execution" | "network" | "file_system";
  condition: SecurityCondition;
  action: "allow" | "deny" | "audit";
  description: string;
}

export interface SecurityCondition {
  field: string;
  operator: "equals" | "contains" | "matches" | "in" | "gt" | "lt" | "exists";
  value: unknown;
}

export interface AuditLog {
  id: string;
  timestamp: Date;
  actor: string;
  action: string;
  resource: string;
  result: "success" | "failure" | "blocked";
  details: Record<string, unknown>;
  traceId: string;
  ipAddress: string;
  userAgent: string;
}

export interface AuditOptions {
  hashChain: boolean;
  immutable: boolean;
  retentionPeriod: number;
}

export interface AnomalyDetection {
  id: string;
  type: string;
  severity: "info" | "warning" | "critical";
  source: string;
  description: string;
  detectedAt: Date;
  indicators: AnomalyIndicator[];
  suggestedAction: string;
  autoResolved: boolean;
}

export interface AnomalyIndicator {
  metric: string;
  expectedValue: number;
  actualValue: number;
  deviation: number;
  threshold: number;
}

export interface RateLimiter {
  consume(key: string, points?: number): Promise<RateLimitResult>;
  get(key: string): Promise<RateLimitStatus>;
  reset(key: string): Promise<void>;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfter: number;
}

export interface RateLimitStatus {
  total: number;
  remaining: number;
  resetAt: Date;
}

export interface SandboxConfig {
  maxExecutionTime: number;
  maxMemoryMB: number;
  allowNetwork: boolean;
  allowFileSystem: boolean;
  allowedHosts: string[];
  allowedPaths: string[];
  environment: Record<string, string>;
}

export interface SandboxResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
  duration: number;
  resourceUsage: {
    cpuTime: number;
    peakMemoryMB: number;
  };
}

export interface PrivacyConfig {
  enableDifferentialPrivacy: boolean;
  epsilon: number;
  delta: number;
  enableHomomorphicEncryption: boolean;
  enableFederatedLearning: boolean;
  dataRetentionDays: number;
  anonymizeFields: string[];
}