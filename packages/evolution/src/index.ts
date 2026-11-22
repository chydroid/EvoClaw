export { EvolutionEngine } from "./evolution-engine";
export { EvolutionApplier } from "./evolution-applier";
export type { ApplyResult } from "./evolution-applier";
export { RequirementMiner } from "./requirement-miner";
export { EvolutionProposer } from "./evolution-proposer";
export { EvolutionEvaluator } from "./evolution-evaluator";
export { HotReloadManager } from "./hot-reload-manager";
export { GeneticEvolutionEngine } from "./genetic-engine";
export { ExperienceAnalyzer } from "./experience-analyzer";
export { ReinforcementFeedbackSystem } from "./reinforcement-feedback";
export { LearningJournal } from "./learning-journal";
export type { JournalConfig } from "./learning-journal";
export { ProgressReporter } from "./progress-reporter";
export type { ProgressPhase } from "./progress-reporter";
export type { FitnessScore, MutationStrategy } from "./genetic-engine";
export type { ExperiencePattern, ExperienceAnalysis, ExperienceRecommendation, SimilarityScore, CrossDomainInsight } from "./experience-analyzer";
export type { RewardSignal, AdaptiveWeights, FeedbackSummary } from "./reinforcement-feedback";
export { ConstraintGate } from "./constraint-gate";
export type { ConstraintGateConfig, GateResult } from "./constraint-gate";
export { ExternalReflector } from "./external-reflector";
export type { ReflectionResult, ExecutionTrace } from "./external-reflector";
export { LLMReflector } from "./llm-reflector";
export { EvolutionThreshold } from "./evolution-threshold";
export type { EvolutionThresholdConfig, ThresholdCheckResult } from "./evolution-threshold";
export { SemanticEmbedder } from "./semantic-embedder";
export type { SemanticEmbedderConfig } from "./semantic-embedder";
export { SandboxExecutor } from "./sandbox-executor";
export type { SandboxConfig, SandboxResult } from "./sandbox-executor";
export { ExperienceDistiller } from "./experience-distiller";
export type { DistilledStrategy, DistillerConfig } from "./experience-distiller";
export { SkillAutoGenerator } from "./skill-auto-generator";
export type { EvolutionResult, GeneratedSkill } from "./skill-auto-generator";
export { EvolutionABTest } from "./evolution-ab-test";
export type { TestStatus } from "./evolution-ab-test";
// 三触发器演化系统（post-analysis / tool-degradation / metric-monitor）。
// 2026-11-16 重新接线：源码此前被当作死代码删除，现恢复并挂到运行时监控循环。
export { EvolutionTriggers } from "./evolution-triggers";
export type { EvolutionTriggerConfig, LlmConfirmationFn, SkillMetrics } from "./evolution-triggers";

// OpenSpace 对齐闭环（Recording → Analyzer → QualityStore → Evolver → Coordinator）
export { ExecutionAnalyzer } from "./execution-analyzer";
export type {
  AnalyzerCompleteFn,
  AnalyzerSkillRef,
  AnalyzeExecutionInput,
  ExecutionAnalyzerConfig,
} from "./execution-analyzer";
export { SkillQualityStore } from "./skill-quality-store";
export type {
  SkillJudgmentRecord,
  SkillQualityEntry,
  SkillQualityStoreOptions,
  SkillQualityStoreStats,
} from "./skill-quality-store";
export { SkillEvolver } from "./skill-evolver";
export type {
  EvolveContext,
  EvolvedSkill,
  EvolverSkill,
  EvolverSkillManager,
  SkillEvolverOptions,
} from "./skill-evolver";
export { EvolutionCoordinator, EVOLUTION_ANALYSIS_EVENT, suggestionKey } from "./evolution-coordinator";
export type {
  CoordinatorStats,
  CoordinatorToolQuality,
  EvolutionCoordinatorConfig,
  EvolutionCoordinatorDeps,
} from "./evolution-coordinator";