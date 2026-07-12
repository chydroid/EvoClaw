export { SkillManager } from "./skill-manager";
export type { OptionalSkillInfo, StartupWarning, StartupWarningCategory, StartupWarningSolution, StartupReport } from "./skill-manager";
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
export { SkillIndex } from "./skill-index";
export type { SkillIndexEntry, SkillSearchResult } from "./skill-index";
export type { SkillRegistryEntry, RegistrySearchQuery, RegistrySearchResult, RemoteRegistryConfig } from "./skill-registry";
export type { DependencyCheckResult, DependencyConflict, DependencySuggestion } from "./skill-resolver";
export type { HealthMonitorConfig, HealthHistory, SkillHealthReport, SkillUsageRecord } from "./skill-lifecycle";
export type { SkillMatch, AutoInstallResult, BatchInstallProgress, ProgressCallback } from "./auto-skill-manager";
export type { DispatchContext, DispatchResult, DispatchOptions } from "./skill-dispatcher";
export type { TfidfMatchResult } from "./tfidf-matcher";
// SkillCurator：技能生命周期管理器（使用跟踪、自动归档、进化记录、恢复）
//   - SkillUsageStats / EvolutionRecord：使用统计与进化记录的持久化结构
//   - 借鉴 hermes-agent Curator 设计，TypeScript 实现
//   - 永不删除技能，仅归档到 data/skills-archive/（遵循 AGENTS.md "Never delete; archive"）
//   - Pinned 技能豁免自动归档；CrossProcessLock + atomicWriteFile 保护并发
export * from "./skill-curator";
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
//   双向映射 + 派生率属性 + suggestions_by_type（v0.69.3 增强）
export type {
  EvolutionType,
  SkillOrigin as EvolutionSkillOrigin,
  SkillLineage,
  LineageTreeNode,
  LineageQueryResult,
  EvolutionSuggestion,
  ExecutionAnalysis,
} from "./evolution-types";
export {
  requiresParent,
  supportsMultipleParents,
  shouldDeactivateParent,
  describeEvolutionType,
  describeEvolutionTypeEn,
  toSkillOrigin,
  fromSkillOrigin,
  SkillMetricsRecord,
  suggestionsByType,
  MAX_RECENT_ANALYSES,
  MAX_RECENT_SUGGESTIONS,
} from "./evolution-types";
export {
  LineageStore,
  writeSkillIdSidecar,
  readSkillIdSidecar,
  ensureSkillIdSidecar,
  generateSkillId,
} from "./lineage-store";

// PatchApplier — 技能内容补丁应用器（借鉴 OpenSpace patch.py）
//   4 pass seek_sequence + 块锚定匹配 + 类似行建议 + 两阶段原子应用
export {
  seekSequence,
  blockAnchorMatch,
  findSimilarLines,
  isPathSafe,
  applyPatch,
  applySearchReplaceBlocks,
  PatchError,
} from "./patch-applier";
export type {
  SearchReplaceBlock,
  PatchHunk,
  PatchResult,
} from "./patch-applier";

// SkillIdCorrector — LLM 幻觉 skill_id 自适应纠错（借鉴 OpenSpace analyzer.py）
//   候选数驱动阈值 + 歧义保护
export {
  correctSkillId,
  correctSkillIds,
  extractNamePrefix,
} from "./skill-id-corrector";
export type {
  SkillIdCandidate,
  CorrectionResult,
} from "./skill-id-corrector";

// SkillNameSanitizer — 技能名规范化（借鉴 OpenSpace evolver.py）
//   lowercase + 折叠 + 单词边界截断 + 派生名生成
export {
  sanitizeSkillName,
  isSanitizedName,
  deriveSkillName,
} from "./skill-name-sanitizer";

// SkillContentUtils — 技能内容工具函数（借鉴 OpenSpace skill_utils.py）
//   两级安全规则 + YAML 自动引号 + CHANGE_SUMMARY 提取 + 非阻塞验证
export {
  checkSafety,
  isSkillSafe,
  needsYamlQuote,
  yamlQuote,
  setFrontmatterField,
  extractChangeSummary,
  validateSkillDir,
} from "./skill-content-utils";
export type {
  SafetyLevel,
  SafetyCheckResult,
  ValidationResult,
} from "./skill-content-utils";

// EmbeddingCache — 内容寻址 embedding 缓存（借鉴 OpenSpace skill_ranker.py）
//   sha256 内容寻址 + 自动失效 + 主动清理 + 缓存版本 pinning
export {
  EmbeddingCache,
  textHash,
  buildCacheKey,
} from "./embedding-cache";
export type {
  CacheEntry,
  EmbeddingCacheOptions,
} from "./embedding-cache";