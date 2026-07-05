export { SkillManager } from "./skill-manager";
export { SkillValidator } from "./skill-validator";
export { SkillHookEngine } from "./skill-hook-engine";
export { SKILLmdParser } from "./skill-md-parser";
export { SkillSandbox } from "./skill-sandbox";
export { SkillLifecycleManager } from "./skill-lifecycle";
export { SkillRegistry } from "./skill-registry";
export { SkillResolver } from "./skill-resolver";
export { AutoSkillManager } from "./auto-skill-manager";
export { SkillLearner } from "./skill-learner";
export type { LearnResult, LearnSource, ConversationEntry, SkillMetadata } from "./skill-learner";
export { SkillDispatcher } from "./skill-dispatcher";
export { TfidfMatcher } from "./tfidf-matcher";
export { SkillCircuitBreaker } from "./skill-circuit-breaker";
export type { CircuitState, CircuitStats, CircuitBreakerConfig } from "./skill-circuit-breaker";
export { SkillCapabilityEvaluator } from "./skill-capability-evaluator";
export type { CapabilityScore } from "./skill-capability-evaluator";
export { SkillCurator } from "./skill-curator";
export { SkillIndex } from "./skill-index";
export type { SkillIndexEntry, SkillSearchResult } from "./skill-index";
export type { SkillRegistryEntry, RegistrySearchQuery, RegistrySearchResult, RemoteRegistryConfig } from "./skill-registry";
export type { DependencyCheckResult, DependencyConflict, DependencySuggestion } from "./skill-resolver";
export type { HealthMonitorConfig, HealthHistory, SkillHealthReport, SkillUsageRecord } from "./skill-lifecycle";
export type { SkillMatch, AutoInstallResult, BatchInstallProgress, ProgressCallback } from "./auto-skill-manager";
export type { DispatchContext, DispatchResult, DispatchOptions } from "./skill-dispatcher";
export type { TfidfMatchResult } from "./tfidf-matcher";
export type { SkillVersion, SkillEvolutionEntry, ExtractionInput, ImprovementInput } from "./skill-curator";
export { SkillMarketplace } from "./marketplace";
export type { SkillPackage, SkillReview, SearchQuery, SearchResult, InstallResult, MarketplaceConfig } from "./marketplace";
export { SkillEcosystem } from "./skill-ecosystem";
export type { EcosystemStats, SkillRecommendation, QualityReport, SkillCategory } from "./skill-ecosystem";
export { SkillWorkshop } from "./skill-workshop";
export type { SkillProposal, SkillProposalFile, SkillWorkshopConfig } from "./skill-workshop";
export { InstallPolicyManager } from "./install-policy";
export type { InstallPolicy, InstallRule, InstallContext, InstallDecision } from "./install-policy";
export {
  writeOriginJson,
  readOriginJson,
  verifySkillOrigin,
  writeLockJson,
  readLockJson,
  verifyLockIntegrity,
  removeOriginJson,
  removeLockJson,
  hashFile,
  sha256,
  hashOriginJson,
  ORIGIN_FILENAME,
  LOCK_FILENAME,
} from "./skill-integrity";
export type {
  SkillOrigin,
  SkillLockfile,
  IntegrityVerificationResult,
} from "./skill-integrity";
export {
  getHookSourcePolicy,
  canOverrideHook,
  resolveHookEnableState,
  resolveHookEntries,
  filterEnabledHooks,
  listHookSourcePolicies,
} from "./hook-policy";
export type {
  HookSource,
  HookEntry,
  HookEnableState,
  HookEnableStateReason,
  HookSourcePolicy,
  HookResolutionCollision,
} from "./hook-policy";
export {
  collectWorkspaceSkillSymlinkEscapeFindings,
  detectSymlinkEscapeInSkill,
  isPathInside,
} from "./workspace-audit";
export type {
  WorkspaceAuditFinding,
  WorkspaceSkillScanLimits,
} from "./workspace-audit";

// 三态演化模型 + 版本血缘 DAG（借鉴 OpenSpace skill_engine）
//   EvolutionType: FIX/DERIVED/CAPTURED 三态语义化演化分类
//   LineageStore: 多父 DAG + 环检测 + 祖先/后代查询
//   .skill_id sidecar: 技能目录可移植身份
export type {
  EvolutionType,
  SkillOrigin as EvolutionSkillOrigin,
  SkillLineage,
  LineageTreeNode,
  LineageQueryResult,
  EvolutionSuggestion,
} from "./evolution-types";
export {
  requiresParent,
  supportsMultipleParents,
  shouldDeactivateParent,
  describeEvolutionType,
  describeEvolutionTypeEn,
} from "./evolution-types";
export {
  LineageStore,
  writeSkillIdSidecar,
  readSkillIdSidecar,
  ensureSkillIdSidecar,
  generateSkillId,
} from "./lineage-store";