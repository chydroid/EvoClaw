export { SecurityGovernor } from "./security-governor";
export { AuditLogger } from "./audit-logger";
export { AuditCenter } from "./audit-center";
export { RateLimiterService } from "./rate-limiter";
export { AnomalyDetector } from "./anomaly-detector";
export { RBACManager } from "./rbac-manager";
export { TenantManager } from "./tenant-manager";
export { SelfHealingManager } from "./self-healing";
export { PermissionManager } from "./permission-manager";
export { ErrorRecoveryManager } from "./error-recovery-manager";
export { ToolPolicyManager, DEFAULT_MAIN_POLICY, DEFAULT_SANDBOX_POLICY, DEFAULT_GROUP_POLICY } from "./tool-policy-manager";
export type { ToolPolicyRule, ToolPolicyCondition, ToolPolicyConfig, ToolAccessRequest, ToolAccessDecision, AgentToolPolicy } from "./tool-policy-manager";
export { DMPairingManager } from "./dm-pairing-manager";
export type { DMPolicy, PairingRequest, DMPolicyConfig, DMCheckResult } from "./dm-pairing-manager";
export { DevicePairingManager } from "./device-pairing-manager";
export type { DeviceIdentity, PairingSession, DevicePairingConfig } from "./device-pairing-manager";
export type { Role, RBACUser, ApiKeyInfo, Permission, AccessRequest } from "./rbac-manager";
export type { AuditQuery, AuditStatistics, AuditAlert, AuditRule } from "./audit-center";
export type { Tenant, TenantConfig, TenantQuota, TenantStats } from "./tenant-manager";
export type { HealingAction, HealingRule, ServiceHealth, HealingActionType, HealingStrategy } from "./self-healing";
export type { PermissionRequest, PermissionRule, WhitelistEntry } from "./permission-manager";
export type { ErrorRecord, RetryConfig, RecoveryAction } from "./error-recovery-manager";
export { PermissionRelay } from "./permission-relay";
export type { PermissionDecision, PermissionRelayConfig } from "./permission-relay";
export { ContentGuard } from "./content-guard";
export type { ContentCheckResult, SafetyLevel, PIIMatch, ContentGuardConfig } from "./content-guard";
export { SSRFProtection, isPrivateIP, isMetadataEndpoint } from "./ssrf-protection";
export type { SSRFConfig, SSRFCheckResult } from "./ssrf-protection";
export { NetPolicy } from "./net-policy";
export type { NetPolicyConfig, NetPolicyResult } from "./net-policy";
export { SecurityMiddleware } from "./security-middleware";
export type { SecurityMiddlewareConfig, SecurityScanResult } from "./security-middleware";

export { SecretManager } from "./secret-manager";
export type { SecretEntry, SecretAccessLog, SecretRotationResult, SecretManagerConfig, SecretQuery, SecretScope, SecretProvider } from "./secret-manager";

// v0.35: 安全策略与防御层
export { InstallPolicyManager, DEFAULT_INSTALL_POLICY } from "./install-policy";
export type {
  InstallPolicy,
  InstallRequest,
  InstallSource,
  PolicyAction,
  PolicyEvaluation,
  InstallAuditEntry,
  InstallPolicyConfig,
  PermissionScope,
  RiskLevel,
  PolicyRuleType,
} from "./install-policy";
export { ApprovalTimeoutManager } from "./approval-timeout-manager";
export type {
  ApprovalRequest,
  ApprovalDecision,
  ApprovalStatus,
  ApprovalTimeoutConfig,
} from "./approval-timeout-manager";
export { TranscriptRedactor } from "./transcript-redactor";
export type {
  RedactionResult,
  RedactorConfig,
  RedactionPattern,
  CustomRedaction,
} from "./transcript-redactor";
export { MCPToolPoisoningScanner } from "./mcp-poisoning-scanner";
export type {
  MCPToolDescription,
  PoisoningScanResult,
  PoisoningThreat,
  PoisoningType,
  PoisoningScannerConfig,
} from "./mcp-poisoning-scanner";

// Tool Guardrails — 幂等/变异工具分类与护栏
export { ToolGuardrails, IDEMPOTENT_TOOL_NAMES, MUTATING_TOOL_NAMES, isIdempotent, isMutating, computeArgsHash, evaluateToolCall, DEFAULT_GUARDRAIL_CONFIG } from "./tool-guardrails";
export type { ToolGuardrailAction, ToolCallSignature, ToolGuardrailConfig, ToolGuardrailDecision } from "./tool-guardrails";

// Path Security — 路径遍历防护
export { validateWithinDir, safeJoin, hasTraversalComponent, hasNullByte, sanitizePath, isSymlinkSync } from "./path-security";

// Command Guard — 命令安全护栏（Hardline 阻止 + 命令归一化 + 环境变量黑名单）
export {
  stripAnsi,
  normalizeCommand,
  checkHardline,
  checkDangerous,
  checkAllCommandGuards,
  HARDLINE_PATTERNS,
  DANGEROUS_PATTERNS,
  ENV_VAR_NAME_DENYLIST,
  isEnvVarDenied,
  filterDeniedEnvVars,
  INVISIBLE_CHARS,
  detectInvisibleChars,
  isDestructiveCommand,
} from "./command-guard";
export type {
  HardlinePattern,
  HardlineCheckResult,
  DangerousPattern,
  DangerousCheckResult,
  CommandGuardAction,
  CommandGuardResult,
} from "./command-guard";

// File Safety — 文件写入/读取安全护栏（敏感文件保护）
export {
  checkWriteSafety,
  checkReadSafety,
  checkFileSafety,
} from "./file-safety";
export type { FileSafetyResult } from "./file-safety";

// MCP Config Security — MCP 服务器配置安全检查
export { validateMCPServerConfig } from "./mcp-config-security";
export type { MCPServerSecurityResult, MCPSecurityThreat } from "./mcp-config-security";

// Redact — 全栈密钥脱敏（对标 Hermes agent/redact.py）
export { redactSensitiveText, maskSecret, containsSecret, redactObject, redactingFormatter, redactUrlCredentials, redactEnvValue } from "./redact";
export type { SecretKind, RedactResult } from "./redact";

// WriteApproval — 写审批门 + pending store（对标 Hermes tools/write_approval.py）
export { WriteApprovalGate, createDefaultWriteGate } from "./write-approval";
export type { GateDecisionType, GateDecision, WriteApprovalConfig, ApprovalResult } from "./write-approval";

// Exec Approvals — 命令执行安全审批链路（决策/策略/白名单/自动审查）
export { ExecApprovalPolicy, DEFAULT_DANGEROUS_RULES, minimatchLike } from "./exec-approval";
export type {
  ExecApprovalAction,
  ExecRiskLevel,
  ExecApprovalRequest,
  ExecApprovalDecision,
  ExecApprovalRule,
  ExecRulePatternType,
} from "./exec-approval";
export { ExecSafeBinNormalizer, ExecSafeBinPolicy } from "./exec-safe-bin";
export { ExecAllowlist } from "./exec-allowlist";
export type { AllowlistEntry } from "./exec-allowlist";
export { ExecAutoReviewer } from "./exec-auto-reviewer";
export type { ExecReviewFinding } from "./exec-auto-reviewer";

// Audit Matrix — audit-* 审计矩阵扩展（对齐 openclaw-main audit-* 11 专项模块）
export { auditConfig } from "./audit-config";
export type {
  ConfigAuditInput,
  ConfigAuditFinding,
  ConfigAuditSeverity,
} from "./audit-config";
export { auditChannels } from "./audit-channel";
export type {
  ChannelAuditInput,
  ChannelAuditChannel,
  ChannelAuditFinding,
  ChannelAuditSeverity,
} from "./audit-channel";
export { auditToolPolicy } from "./audit-tool-policy";
export type {
  ToolPolicyAuditInput,
  ToolPolicyEntry,
  ToolPolicyAuditCondition,
  ToolPolicyAuditFinding,
  ToolPolicyAuditSeverity,
} from "./audit-tool-policy";
export { auditTrustModel } from "./audit-trust-model";
export type {
  TrustLevel,
  TrustModelAuditInput,
  TrustModelSkill,
  TrustModelAgent,
  TrustModelSkillPermissions,
  TrustModelAuditFinding,
  TrustModelAuditSeverity,
} from "./audit-trust-model";
export { auditGatewayExposure } from "./audit-gateway-exposure";
export type {
  GatewayExposureAuditInput,
  GatewayExposureChannel,
  GatewayExposureAuditFinding,
  GatewayExposureAuditSeverity,
} from "./audit-gateway-exposure";
// 综合审计入口（AuditCenter.runComprehensiveAudit 的输入/输出类型）
export type {
  ComprehensiveAuditInput,
  ComprehensiveAuditResult,
  ComprehensiveAuditFinding,
  ComprehensiveAuditSeverity,
  ComprehensiveAuditModule,
  ComprehensiveAuditSummary,
} from "./audit-center";

// Secrets 子系统 — 防 timing attack / ReDoS 防护 / 危险配置标记 / 明文密钥扫描
export { secretEqual, secretEqualBuffer, safeEqualSecret, safeEqualSecretBuffer } from "./secret-equal";
export {
  checkRegexSafety,
  safeRegExp,
  isUnsafeRegex,
} from "./safe-regex";
export type { RegexSafetyResult, RegexRisk } from "./safe-regex";
export {
  DANGEROUS_CONFIG_FLAGS,
  scanDangerousConfigFlags,
  getDangerousFlag,
  registerDangerousFlag,
  clearCustomDangerousFlags,
} from "./dangerous-config-flags";
export type {
  DangerousConfigFlag,
  ConfigFlagSeverity,
  ConfigEnvironment,
  ConfigFlagFinding,
} from "./dangerous-config-flags";
export {
  DEFAULT_SECRET_RULES,
  scanSecrets,
  hasPlaintextSecrets,
  redactValue,
  getDefaultSecretRules,
} from "./secret-scan";
export type { SecretScanFinding, SecretScanRule } from "./secret-scan";

// F13: SkillScanner — 技能威胁正则库 + AST 审计 + 结构检查（对标 Hermes tools/threat_patterns.py + skills_guard.py + skills_ast_audit.py）
// NOTE: skill-scanner 也导出 INVISIBLE_CHARS / detectInvisibleChars / TrustLevel，但与
// command-guard / install-policy 同名冲突。需要这些符号的调用方应直接从 "./skill-scanner" 导入。
export {
  scanForThreats,
  astScanContent,
  checkSkillStructure,
  scanSkill,
  evaluateTrustPolicy,
} from "./skill-scanner";
export type {
  ThreatScope,
  ThreatKind,
  ThreatPattern,
  ThreatFinding,
  SkillScanResult,
  StructuralIssue,
  TrustLevel as SkillTrustLevel,
  TrustPolicy as SkillTrustPolicy,
} from "./skill-scanner";

// Advisory Catalog — 已知安全公告目录 + 受影响包检测
export { ADVISORIES, detectCompromised } from "./advisory-catalog";
export type { Advisory, AdvisorySeverity } from "./advisory-catalog";

// Startup Security Audit — 启动时安全审计（root 检测 / gateway 暴露 / Docker 环境）
export { runStartupSecurityAudit, resetAuditSentinel } from "./startup-security-audit";
export type {
  SecurityWarning,
  SecurityWarningSeverity,
  StartupAuditOptions,
} from "./startup-security-audit";