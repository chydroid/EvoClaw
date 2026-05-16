export interface EvolutionCycle {
  id: string;
  status: EvolutionStatus;
  source: EvolutionSource;
  targetSkill: string | null;
  input: EvolutionInput;
  candidates: EvolutionCandidate[];
  selectedCandidate: string | null;
  evaluation: EvolutionEvaluation | null;
  startedAt: Date;
  completedAt: Date | null;
}

export type EvolutionStatus = "mining" | "analyzing" | "generating" | "evaluating" | "publishing" | "completed" | "rejected" | "failed";

export type EvolutionSource = "task_failure" | "user_feedback" | "usage_pattern" | "performance_degradation" | "manual";

export interface EvolutionInput {
  triggerEvent: string;
  context: Record<string, unknown>;
  failureLogs: string[];
  successRate: number;
  relatedSkills: string[];
}

export interface EvolutionCandidate {
  id: string;
  type: "new_skill" | "skill_update" | "code_patch" | "config_change";
  proposedChanges: ProposedChanges;
  codeArtifacts: CodeArtifact[];
  risk: EvolutionRisk;
  generatedAt: Date;
}

export interface ProposedChanges {
  skillManifest?: Partial<import("./skill").SkillManifest>;
  codeChanges: CodeChange[];
  configChanges: Record<string, unknown>;
  description: string;
}

export interface CodeChange {
  filePath: string;
  diff: string;
  language: string;
  reasoning: string;
}

export interface CodeArtifact {
  name: string;
  language: string;
  source: string;
  tests: string;
  dependencies: string[];
}

export interface EvolutionRisk {
  level: "low" | "medium" | "high" | "critical";
  factors: string[];
  mitigation: string;
}

export interface EvolutionEvaluation {
  candidateId: string;
  passed: boolean;
  score: number;
  testResults: TestSuiteResult;
  securityAudit: SecurityAuditResult;
  performanceImpact: PerformanceImpact;
  recommendation: string;
}

export interface TestSuiteResult {
  totalTests: number;
  passed: number;
  failed: number;
  coverage: number;
  failures: TestFailure[];
}

export interface TestFailure {
  testName: string;
  message: string;
  expected: string;
  actual: string;
}

export interface SecurityAuditResult {
  score: number;
  vulnerabilities: Vulnerability[];
  passed: boolean;
}

export interface Vulnerability {
  severity: "critical" | "high" | "medium" | "low" | "info";
  description: string;
  location: string;
  remediation: string;
}

export interface PerformanceImpact {
  estimatedCpuIncrease: number;
  estimatedMemoryIncrease: number;
  estimatedLatencyIncrease: number;
  acceptable: boolean;
}

export interface ReinforcementFeedback {
  cycleId: string;
  skillId: string;
  successRate: number;
  userAdoptionRate: number;
  tokenConsumption: number;
  errorRate: number;
  collectedAt: Date;
}

export interface HotReloadEvent {
  skillId: string;
  action: "install" | "update" | "remove" | "rollback";
  newVersion?: string;
  oldVersion?: string;
  strategy: "immediate" | "graceful" | "ab_test" | "canary";
}

export type LearningTrigger =
  | "command_failed"
  | "user_correction"
  | "capability_gap"
  | "api_failure"
  | "knowledge_outdated"
  | "pattern_improvement"
  | "task_failure"
  | "user_feedback";

export type LearningCategory =
  | "error_fix"
  | "correction"
  | "new_capability_needed"
  | "better_approach"
  | "external_dependency"
  | "knowledge_update"
  | "process_improvement";

export type LearningSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface LearningEntry {
  id: string;
  timestamp: Date;
  trigger: LearningTrigger;
  category: LearningCategory;
  title: string;
  context: string;
  error: string | null;
  rootCause: string | null;
  correction: string | null;
  solution: string | null;
  codeSnippet: string | null;
  source: string;
  severity: LearningSeverity;
  resolved: boolean;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolvedApproach: string | null;
  relatedEntries: string[];
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface LearningSession {
  id: string;
  taskId: string;
  taskDescription: string;
  entries: LearningEntry[];
  progressReports: ProgressReport[];
  startedAt: Date;
  completedAt: Date | null;
  status: "active" | "completed" | "failed" | "cancelled";
  summary: string | null;
}

export interface ProgressReport {
  id: string;
  sessionId: string;
  taskId: string;
  phase: string;
  step: number;
  totalSteps: number;
  progress: number;
  message: string;
  details: string | null;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
}

export interface LearningStats {
  totalEntries: number;
  resolvedEntries: number;
  unresolvedEntries: number;
  entriesByCategory: Record<LearningCategory, number>;
  entriesByTrigger: Record<LearningTrigger, number>;
  entriesBySeverity: Record<LearningSeverity, number>;
  recentEntries: LearningEntry[];
  topTags: Array<{ tag: string; count: number }>;
  resolutionRate: number;
  averageResolutionTimeMs: number;
  newThisWeek: number;
  resolvedThisWeek: number;
}