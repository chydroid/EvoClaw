export interface SkillLifecycle {
  status: SkillStatus;
  version: string;
  installDate: Date;
  lastUpdated: Date;
  healthCheck: HealthCheckResult | null;
}

export type SkillStatus = "installed" | "active" | "error" | "updating" | "uninstalling" | "disabled";

export interface HealthCheckResult {
  healthy: boolean;
  lastCheck: Date;
  errors: string[];
  missingDependencies: string[];
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
  };
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  os?: string[];
  install?: string;
  source?: string;
  build?: string;
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