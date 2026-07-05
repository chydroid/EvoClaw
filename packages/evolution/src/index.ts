export { EvolutionEngine } from "./evolution-engine";
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

// EvolutionTriggers — 三触发器演化系统（借鉴 OpenSpace skill_engine/evolver.py）
//   1. post-analysis: LLM 分析后接受 EvolutionSuggestion
//   2. tool-degradation: 工具成功率跌破阈值时触发（联动 ToolQualityManager）
//   3. metric-monitor: 技能应用 ≥5 次但完成率 < 0.35 时触发
//   关键：必须 LLM 二次确认才执行，防循环机制
export { EvolutionTriggers } from "./evolution-triggers";
export type {
  EvolutionTriggerConfig,
  LlmConfirmationFn,
  SkillMetrics,
} from "./evolution-triggers";