export interface SkillLifecycle {
  status: SkillStatus;
  version: string;
  installDate: Date;
  lastUpdated: Date;
  healthCheck: HealthCheckResult | null;
}

export type SkillStatus = "draft" | "active" | "stale" | "archived" | "error" | "updating" | "uninstalling" | "disabled";

export interface HealthCheckResult {
  healthy: boolean;
  lastCheck: Date;
  errors: string[];
  missingDependencies: string[];
}

export interface SkillUsageRecord {
  skillId: string;
  lastUsedAt: Date;
  useCount: number;
  successCount: number;
  failureCount: number;
  lastFailureAt: Date | null;
  lastFailureReason: string | null;
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  homepage?: string;
  repository?: string;
  keywords: string[];
  category: SkillCategory;
  icon?: string;
  requires: SkillDependency[];
  provides: SkillCapability[];
  triggers: SkillTrigger[];
  entryPoint: string;
  sandboxPolicy: SandboxPolicy;
}

export type SkillCategory = "automation" | "integration" | "analysis" | "generation" | "utility" | "custom";

export interface SkillDependency {
  name: string;
  version: string;
  optional: boolean;
}

export interface SkillCapability {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface SkillTrigger {
  type: "keyword" | "intent" | "schedule" | "event" | "webhook";
  pattern: string;
  description: string;
}

export interface SandboxPolicy {
  allowNetwork: boolean;
  allowFileSystem: boolean;
  allowSubprocess: boolean;
  maxExecutionTime: number;
  maxMemoryMB: number;
  allowedHosts: string[];
  allowedPaths: string[];
}

export interface SkillI18n {
  description_zh?: string;
  instructions_zh?: string;
  examples_zh?: string[];
  translatedAt?: string;
}

export type SkillConfigStatus = "configured" | "partial" | "unconfigured";

export interface Skill extends SkillManifest {
  id: string;
  installPath: string;
  lifecycle: SkillLifecycle;
  config: Record<string, unknown>;
  stats: SkillStats;
  body: SkillBody;
  i18n?: SkillI18n;
  openclawMeta?: OpenClawSkillMeta;
  configStatus?: SkillConfigStatus;
  latestVersion?: string;
  updateAvailable?: boolean;
}

export interface SkillBody {
  instructions: string;
  scripts: Record<string, string>;
  examples: string[];
  hooks: SkillHooks;
}

export interface SkillStats {
  invocationCount: number;
  successCount: number;
  failureCount: number;
  averageDuration: number;
  lastInvocation: Date | null;
  userRating: number;
}

export interface SkillExecutionResult {
  skillId: string;
  success: boolean;
  output: unknown;
  errors: string[];
  duration: number;
  resourceUsage: ResourceUsage;
}

export interface ResourceUsage {
  cpuTime: number;
  peakMemoryMB: number;
  networkBytes: number;
}

export interface SKILLmdMeta {
  name: string;
  version: string;
  description: string;
  author: string;
  category?: SkillCategory;
  keywords?: string[];
  license?: string;
  triggers: SkillTrigger[];
  requires: SkillDependency[];
  config: Record<string, unknown>;
  homepage?: string;
  emoji?: string;
  os?: string[];
  metadata?: OpenClawMetadata;
  // OpenClaw compatibility fields
  allowedTools?: string[];
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  commandDispatch?: string;
  commandTool?: string;
  commandArgMode?: string;
}

export interface OpenClawMetadata {
  openclaw?: OpenClawSkillMeta;
  clawdbot?: OpenClawSkillMeta;
  clawdis?: OpenClawSkillMeta;
}

export interface OpenClawSkillMeta {
  requires?: {
    env?: string[];
    bins?: string[];
    anyBins?: string[];
    config?: string[];
  };
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  os?: string[];
  install?: string | SkillInstallSpec[];
  source?: string;
  build?: string;
  skillKey?: string;
  always?: boolean;
}

export interface SkillInstallSpec {
  id: string;
  kind: "brew" | "node" | "go" | "uv" | "download" | "apt" | "pip";
  label?: string;
  bins?: string[];
  os?: string[];
  formula?: string;
  package?: string;
  module?: string;
  url?: string;
  archive?: string;
  extract?: boolean;
  stripComponents?: number;
  targetDir?: string;
}

export interface SKILLmdDocument {
  meta: SKILLmdMeta;
  instructions: string;
  scripts: Record<string, string>;
  examples: string[];
  hooks: SkillHooks;
}

export interface SkillHooks {
  onInstall?: string;
  onUninstall?: string;
  onActivate?: string;
  onDeactivate?: string;
  onBeforeExecute?: string;
  onAfterExecute?: string;
  onError?: string;
}

/** Skill loading priority (higher number = higher priority, matching OpenClaw's 6-level system) */
export interface SkillLoadConfig {
  /** Skill directories in priority order (highest first) */
  searchPaths: string[];
  /** Per-agent skill allowlist. Empty array = no skills. Undefined = all skills allowed */
  agentAllowlists?: Record<string, string[]>;
  /** Default allowlist for agents not in agentAllowlists */
  defaultAllowlist?: string[];
}

export interface SecurityScanResult {
  safe: boolean;
  riskLevel: "low" | "medium" | "high" | "critical";
  findings: SecurityFinding[];
}

export interface SecurityFinding {
  type:
    | "injection"
    | "exfiltration"
    | "privilege_escalation"
    | "supply_chain"
    | "suspicious_pattern"
    | "obfuscation"
    | "sandbox_escape"
    | "prompt_injection";
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  location: string;
  recommendation: string;
}