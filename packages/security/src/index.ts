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