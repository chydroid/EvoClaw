/**
 * EvoClaw WebUI — Unified API Client
 *
 * Typed fetch wrappers for all backend endpoints.
 * Every function returns a Promise with proper TypeScript types.
 */

// ═══════════════════════════════════════════════
// Base
// ═══════════════════════════════════════════════

const BASE = "";
const DEFAULT_TIMEOUT_MS = 30_000;

function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const originalSignal = init?.signal;

  if (originalSignal) {
    originalSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return fetch(input, { ...init, signal: controller.signal })
    .finally(() => clearTimeout(timeoutId));
}

async function get<T>(path: string, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  const res = await fetchWithTimeout(`${BASE}${path}`, { signal }, timeoutMs);
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ""));
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }, timeoutMs);
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ""));
  return res.json() as Promise<T>;
}

async function put<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }, timeoutMs);
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ""));
  return res.json() as Promise<T>;
}

async function del<T>(path: string, timeoutMs?: number): Promise<T> {
  const res = await fetchWithTimeout(`${BASE}${path}`, { method: "DELETE" }, timeoutMs);
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ""));
  return res.json() as Promise<T>;
}

async function getSafe<T>(path: string, fallback: T, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  try { return await get<T>(path, signal, timeoutMs); } catch { return fallback; }
}

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

// ═══════════════════════════════════════════════
// Health & System
// ═══════════════════════════════════════════════

export interface HealthInfo {
  status: string; version: string; uptime: number;
  nodeVersion: string; platform: string;
}

export interface ServiceInfo {
  name: string; version: string; status: string;
  startedAt?: string; error?: string;
}

export interface AgentStatus {
  sessionId: string; state: string; currentAction: string;
  toolCalls: Array<{ name: string; status: string }>;
  lastActivity: string; tokensUsed: number; duration: number; runId: number;
  progress?: { current: number; total: number; label: string };
}

export interface SystemStatus {
  online: boolean; uptime: number; uptimeFormatted: string;
  memory: { heapUsed: number; heapTotal: number; rss: number };
  platform: string; nodeVersion: string;
  agentStatuses: AgentStatus[]; timestamp: string;
}

export interface ProviderStatus {
  name: string; provider: string; model: string;
  status: "active" | "error" | "inactive";
  lastError?: string; lastErrorType?: string;
  successCount: number; failureCount: number;
}

export interface SessionInfo {
  id: string; messageCount: number; lastActive: string;
  compactionCount: number; tokensUsed: number;
}

export interface BootstrapFile {
  path: string; exists: boolean; size: number;
}

export const api = {
  health: () => get<HealthInfo>("/api/health"),
  status: () => get<SystemStatus>("/api/status"),
  services: () => get<ServiceInfo[]>("/api/system/services"),
  providers: () => getSafe<ProviderStatus[]>("/api/system/providers", []),
  sessions: () => getSafe<SessionInfo[]>("/api/system/sessions", []),
  bootstrapFiles: () => getSafe<BootstrapFile[]>("/api/system/bootstrap-files", []),
};

// ═══════════════════════════════════════════════
// Skills
// ═══════════════════════════════════════════════

export interface Skill {
  id: string; name: string; version: string; description: string;
  category: string;
  lifecycle: { status: string };
  stats: { invocationCount: number; successCount: number; failureCount: number };
}

export const skillsApi = {
  list: () => getSafe<Skill[]>("/api/skills", []),
};

// ═══════════════════════════════════════════════
// Voice (local speech recognition)
// ═══════════════════════════════════════════════

export interface VoiceConfigData {
  enabled: boolean;
  engine: "browser" | "vosk" | "none";
  language: string;
  continuous: boolean;
  interimResults: boolean;
  voskModelPath?: string;
  autoSubmit: boolean;
  timeoutMs: number;
}

export interface VoiceStatusData {
  enabled: boolean;
  engine: "browser" | "vosk" | "none";
  available: boolean;
  supported: boolean;
  lastError?: string;
  lastVerifiedAt?: string;
}

export interface VoiceApiResponse {
  config: VoiceConfigData;
  status: VoiceStatusData;
}

export interface VoiceVerificationResult {
  success: boolean;
  available: boolean;
  supported: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export const voiceApi = {
  get: (signal?: AbortSignal) => getSafe<VoiceApiResponse>("/api/voice", { config: {} as any, status: {} as any }, signal),
  update: (body: Partial<VoiceConfigData>) => put<{ status: VoiceStatusData }>("/api/voice", body),
  verify: () => post<VoiceVerificationResult>("/api/voice/verify"),
  toggle: (enabled: boolean) => post<{ status: VoiceStatusData }>("/api/voice/toggle", { enabled }),
  reset: () => post<{ status: VoiceStatusData }>("/api/voice/reset"),
};

// ═══════════════════════════════════════════════
// Chat & Sessions
// ═══════════════════════════════════════════════

export interface ChatResponse {
  reply: string;
  permissionRequests?: Array<{ id: string; operation: string; description: string; target: string }>;
  tokensUsed?: number; duration?: number;
}

export interface ChatSession {
  sessionId: string; agentId?: string; label?: string; preview?: string;
  createdAt?: string; updatedAt?: string;
  turnCount?: number; status?: string;
}

export interface ChatTurn {
  role: "user" | "assistant" | "system" | "tool";
  content: string; timestamp: string;
}

export const chatApi = {
  send: (message: string, sessionId: string) =>
    post<ChatResponse>("/api/chat", { message, sessionId }),
  listSessions: () => getSafe<{ sessions: ChatSession[] }>("/api/sessions", { sessions: [] }),
  getSession: (sessionId: string) =>
    get<{ turns: ChatTurn[] }>(`/api/sessions/default/${sessionId}`),
  createSession: (agentId = "default") =>
    post<{ session: ChatSession }>("/api/sessions", { agentId }),
  deleteSession: (sessionId: string) =>
    del<void>(`/api/sessions/default/${sessionId}`),
};

// ═══════════════════════════════════════════════
// Permissions
// ═══════════════════════════════════════════════

export const permissionApi = {
  approve: (requestId: string, whitelist: boolean) =>
    post<void>("/api/permission/approve", { requestId, whitelist }),
  deny: (requestId: string) =>
    post<void>("/api/permission/deny", { requestId }),
};

// ═══════════════════════════════════════════════
// Config (Avatars, etc.)
// ═══════════════════════════════════════════════

export interface AvatarConfig {
  user: string; bot: string; userNickname: string; botNickname: string;
}

export const configApi = {
  getAvatars: () => getSafe<{ avatars: AvatarConfig }>("/api/config/avatars", { avatars: {} as AvatarConfig }),
  saveAvatars: (avatars: AvatarConfig) =>
    put<void>("/api/config/avatars", { avatars }),
};

// ═══════════════════════════════════════════════
// Secrets Manager
// ═══════════════════════════════════════════════

export interface SecretEntry {
  name: string; value?: string; source: "env" | "registered";
  createdAt: string; expiresAt?: string; revoked: boolean;
  rotationVersion: number; lastRotatedAt?: string;
}

export interface SecretAuditLog {
  secretName: string; operation: string; accessedBy: string;
  timestamp: string; success: boolean;
}

export const secretsApi = {
  list: () => getSafe<{ secrets: SecretEntry[] }>("/api/secrets", { secrets: [] }),
  register: (name: string, value: string, ttlMs?: number) =>
    post<SecretEntry>("/api/secrets", { name, value, ttlMs }),
  get: (name: string, requester?: string) =>
    post<{ value: string }>(`/api/secrets/${encodeURIComponent(name)}/get`, { requester }),
  rotate: (name: string) =>
    post<SecretEntry>(`/api/secrets/${encodeURIComponent(name)}/rotate`),
  revoke: (name: string) =>
    post<void>(`/api/secrets/${encodeURIComponent(name)}/revoke`),
  delete: (name: string) =>
    del<void>(`/api/secrets/${encodeURIComponent(name)}`),
  auditLogs: (name?: string) =>
    getSafe<{ logs: SecretAuditLog[] }>(`/api/secrets/audit${name ? `?name=${encodeURIComponent(name)}` : ""}`, { logs: [] }),
  generateApiKey: (prefix?: string) =>
    post<{ apiKey: string; name: string }>("/api/secrets/generate-apikey", { prefix }),
};

// ═══════════════════════════════════════════════
// Dead Letter Queue
// ═══════════════════════════════════════════════

export interface DeadLetter {
  id: string; type: string; payload: unknown;
  reason: string; attempts: number; maxAttempts: number;
  enqueuedAt: string; lastAttemptAt?: string;
  status: "pending" | "retrying" | "dead";
}

export const dlqApi = {
  list: (opts?: { status?: string; type?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.type) params.set("type", opts.type);
    if (opts?.limit) params.set("limit", String(opts.limit));
    return getSafe<{ messages: DeadLetter[]; total: number }>(
      `/api/dlq${params.toString() ? `?${params}` : ""}`,
      { messages: [], total: 0 },
    );
  },
  retry: (id: string) => post<void>(`/api/dlq/${encodeURIComponent(id)}/retry`),
  retryAll: () => post<{ retried: number }>("/api/dlq/retry-all"),
  delete: (id: string) => del<void>(`/api/dlq/${encodeURIComponent(id)}`),
  purge: () => del<{ deleted: number }>("/api/dlq/purge"),
};

// ═══════════════════════════════════════════════
// Config RPC
// ═══════════════════════════════════════════════

export const configRpcApi = {
  get: (dotPath: string) =>
    get<{ path: string; value: unknown }>(`/api/config-rpc/${encodeURIComponent(dotPath)}`),
  set: (dotPath: string, value: unknown) =>
    post<{ path: string; value: unknown }>(`/api/config-rpc/${encodeURIComponent(dotPath)}`, { value }),
  list: (prefix?: string) =>
    getSafe<{ entries: Array<{ path: string; value: unknown; source: string }> }>(
      `/api/config-rpc${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`,
      { entries: [] },
    ),
  watch: (dotPath: string) =>
    post<{ subscriptionId: string }>(`/api/config-rpc/${encodeURIComponent(dotPath)}/watch`),
  batchGet: (paths: string[]) =>
    post<{ results: Array<{ path: string; value: unknown }> }>("/api/config-rpc/batch", { paths }),
};

// ═══════════════════════════════════════════════
// Session Retention
// ═══════════════════════════════════════════════

export interface RetentionPolicy {
  maxAgeDays: number; maxInactiveDays: number;
  maxSessions: number; maxMessagesPerSession: number;
  enabled: boolean;
}

export interface RetentionStats {
  totalSessions: number; expiredSessions: number;
  cleanedUp: number; lastRun: string;
}

export const retentionApi = {
  getPolicy: () => get<{ policy: RetentionPolicy }>("/api/retention/policy"),
  updatePolicy: (policy: Partial<RetentionPolicy>) =>
    put<{ policy: RetentionPolicy }>("/api/retention/policy", { policy }),
  getStats: () => getSafe<RetentionStats>("/api/retention/stats", {
    totalSessions: 0, expiredSessions: 0, cleanedUp: 0, lastRun: "",
  }),
  runNow: () => post<{ cleaned: number }>("/api/retention/run"),
};

// ═══════════════════════════════════════════════
// Feature Flags
// ═══════════════════════════════════════════════

export interface FeatureFlag {
  key: string; name: string; description: string;
  enabled: boolean; defaultValue: boolean; value?: boolean;
  rolloutPercent?: number;
  environments?: string[];
  owner?: string;
  conditions?: Array<{ type: string; config: unknown }>;
  updatedAt: string;
}

export const featureFlagsApi = {
  list: () => getSafe<{ flags: FeatureFlag[] }>("/api/feature-flags", { flags: [] }),
  get: (key: string) => get<FeatureFlag>(`/api/feature-flags/${encodeURIComponent(key)}`),
  set: (key: string, enabled: boolean) =>
    post<FeatureFlag>(`/api/feature-flags/${encodeURIComponent(key)}`, { enabled }),
  evaluate: (key: string, context?: Record<string, unknown>) =>
    post<{ enabled: boolean; reason: string }>(`/api/feature-flags/${encodeURIComponent(key)}/evaluate`, { context }),
};

// ═══════════════════════════════════════════════
// Config Migration
// ═══════════════════════════════════════════════

export interface MigrationRecord {
  id: string; fromVersion: string; toVersion: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: string; completedAt?: string; error?: string;
  changes: Array<{ path: string; from: unknown; to: unknown }>;
}

export const migrationApi = {
  list: () => getSafe<{ migrations: MigrationRecord[] }>("/api/config/migrations", { migrations: [] }),
  run: (migrationId: string) =>
    post<MigrationRecord>(`/api/config/migrations/${encodeURIComponent(migrationId)}/run`),
  rollback: (migrationId: string) =>
    post<MigrationRecord>(`/api/config/migrations/${encodeURIComponent(migrationId)}/rollback`),
  status: () => get<{ currentVersion: string; pendingCount: number; lastMigration?: MigrationRecord }>("/api/config/migration-status"),
};

// ═══════════════════════════════════════════════
// Config Doctor
// ═══════════════════════════════════════════════

export interface ConfigIssue {
  severity: "error" | "warning" | "info";
  path: string; message: string;
  suggestion?: string; currentValue?: unknown;
}

export const configDoctorApi = {
  diagnose: () => get<{ issues: ConfigIssue[]; healthy: boolean }>("/api/config/doctor"),
  fix: (issuePath: string, value: unknown) =>
    post<{ fixed: boolean }>(`/api/config/doctor/fix`, { path: issuePath, value }),
  fixAll: () => post<{ fixed: number; remaining: number }>("/api/config/doctor/fix-all"),
};

// ═══════════════════════════════════════════════
// Config LKG (Last Known Good)
// ═══════════════════════════════════════════════

export interface LKGSnapshot {
  id: string; version: string; timestamp: string;
  configCount: number; sha256: string;
}

export const configLkgApi = {
  list: () => getSafe<{ snapshots: LKGSnapshot[] }>("/api/config/lkg", { snapshots: [] }),
  create: (label?: string) =>
    post<LKGSnapshot>("/api/config/lkg", { label }),
  restore: (snapshotId: string) =>
    post<{ restored: number }>(`/api/config/lkg/${encodeURIComponent(snapshotId)}/restore`),
  delete: (snapshotId: string) =>
    del<void>(`/api/config/lkg/${encodeURIComponent(snapshotId)}`),
  compare: (id1: string, id2: string) =>
    get<{ diff: Array<{ path: string; from: unknown; to: unknown }> }>(
      `/api/config/lkg/compare?id1=${encodeURIComponent(id1)}&id2=${encodeURIComponent(id2)}`,
    ),
};

// ═══════════════════════════════════════════════
// Reply Reference
// ═══════════════════════════════════════════════

export interface ReplyRef {
  id: string; parentId?: string; rootId: string;
  author: string; content: string; timestamp: string;
  channelId: string; threadId?: string;
}

export const replyRefApi = {
  list: (opts?: { channelId?: string; rootId?: string }) => {
    const params = new URLSearchParams();
    if (opts?.channelId) params.set("channelId", opts.channelId);
    if (opts?.rootId) params.set("rootId", opts.rootId);
    return getSafe<{ refs: ReplyRef[] }>(
      `/api/reply-refs${params.toString() ? `?${params}` : ""}`,
      { refs: [] },
    );
  },
  getTree: (rootId: string) =>
    get<{ tree: { nodes: Record<string, ReplyRef>; edges: Array<{ from: string; to: string }> } }>(
      `/api/reply-refs/${encodeURIComponent(rootId)}/tree`,
    ),
  getChain: (rootId: string) =>
    get<{ chain: ReplyRef[] }>(`/api/reply-refs/${encodeURIComponent(rootId)}/chain`),
};

// ═══════════════════════════════════════════════
// Message Templates
// ═══════════════════════════════════════════════

export interface MessageTemplate {
  id: string; name: string; description: string;
  template: string; variables: string[];
  category: string; createdAt: string; updatedAt: string;
}

export const templatesApi = {
  list: () => getSafe<{ templates: MessageTemplate[] }>("/api/message-templates", { templates: [] }),
  get: (id: string) => get<MessageTemplate>(`/api/message-templates/${encodeURIComponent(id)}`),
  create: (tpl: Omit<MessageTemplate, "id" | "createdAt" | "updatedAt">) =>
    post<MessageTemplate>("/api/message-templates", tpl),
  update: (id: string, tpl: Partial<MessageTemplate>) =>
    put<MessageTemplate>(`/api/message-templates/${encodeURIComponent(id)}`, tpl),
  delete: (id: string) => del<void>(`/api/message-templates/${encodeURIComponent(id)}`),
  render: (id: string, variables: Record<string, string>) =>
    post<{ rendered: string }>(`/api/message-templates/${encodeURIComponent(id)}/render`, { variables }),
};

// ═══════════════════════════════════════════════
// Health Aggregator
// ═══════════════════════════════════════════════

export interface ComponentHealth {
  name: string; status: "healthy" | "degraded" | "unhealthy" | "unknown";
  latencyMs: number; lastCheck: string; message?: string;
  details?: Record<string, unknown>;
}

export const healthApi = {
  full: () => get<{ overall: string; components: ComponentHealth[]; timestamp: string }>("/api/health/full"),
  component: (name: string) =>
    get<ComponentHealth>(`/api/health/component/${encodeURIComponent(name)}`),
  check: (name: string) =>
    post<ComponentHealth>(`/api/health/component/${encodeURIComponent(name)}/check`),
};

// ═══════════════════════════════════════════════
// Onboarding Wizard
// ═══════════════════════════════════════════════

export interface OnboardingStep {
  id: string; title: string; description: string;
  status: "pending" | "completed" | "skipped";
  required: boolean;
}

export const onboardingApi = {
  status: () => get<{ completed: boolean; currentStep: string; steps: OnboardingStep[] }>("/api/onboarding/status"),
  completeStep: (stepId: string) =>
    post<{ steps: OnboardingStep[] }>(`/api/onboarding/step/${encodeURIComponent(stepId)}/complete`),
  skipStep: (stepId: string) =>
    post<{ steps: OnboardingStep[] }>(`/api/onboarding/step/${encodeURIComponent(stepId)}/skip`),
  reset: () => post<void>("/api/onboarding/reset"),
};