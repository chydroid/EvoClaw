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
    // 转发外部 signal 的 abort；在 fetch 完成后移除监听器，避免累积
    const onAbort = () => controller.abort();
    originalSignal.addEventListener("abort", onAbort, { once: true });
    return fetch(input, { ...init, signal: controller.signal })
      .finally(() => {
        clearTimeout(timeoutId);
        originalSignal.removeEventListener("abort", onAbort);
      });
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

async function patch<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }, timeoutMs);
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
// Session Management（会话管理）
// ═══════════════════════════════════════════════

/** /api/sessions 返回的会话列表项 */
export interface ChatSessionListItem {
  sessionId: string;
  agentId: string;
  status: string;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
  customName?: string;
  preview?: string;
}

/** /api/sessions 返回的完整响应 */
export interface SessionListResponse {
  success: boolean;
  sessions: ChatSessionListItem[];
}

/** /api/sessions POST 创建会话返回 */
export interface SessionCreateResponse {
  success: boolean;
  session?: ChatSessionListItem;
  sessionId?: string;
}

export const sessionsApi = {
  /** 列出所有会话 */
  list: () => getSafe<SessionListResponse>("/api/sessions", { success: false, sessions: [] }),
  /** 创建新会话 */
  create: (agentId: string = "default", title?: string) =>
    post<SessionCreateResponse>("/api/sessions", { agentId, ...(title ? { title } : {}) }),
  /** 获取单个会话详情 */
  get: (agentId: string, sessionId: string) =>
    get<{ success: boolean; session: ChatSessionListItem }>(`/api/sessions/${agentId}/${sessionId}`),
  /** 重命名会话（更新 customName） */
  rename: (agentId: string, sessionId: string, customName: string) =>
    patch<{ success: boolean; session: ChatSessionListItem }>(
      `/api/sessions/${agentId}/${sessionId}`,
      { customName },
    ),
  /** 删除会话 */
  delete: (agentId: string, sessionId: string) =>
    del<{ success: boolean; message: string }>(`/api/sessions/${agentId}/${sessionId}`),
};

// ═══════════════════════════════════════════════
// Workboard（看板任务）
// ═══════════════════════════════════════════════

export type WorkboardStatus = "backlog" | "todo" | "in_progress" | "review" | "done";
export type WorkboardPriority = "low" | "medium" | "high" | "critical";

export interface WorkboardTask {
  id: string;
  title: string;
  description?: string;
  status: WorkboardStatus;
  priority: WorkboardPriority;
  tags: string[];
  assignee?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkboardResponse {
  tasks: Record<WorkboardStatus, WorkboardTask[]>;
  stats: {
    totalTasks: number;
    byStatus: Partial<Record<WorkboardStatus, number>>;
    byAssignee: Record<string, number>;
    totalRuns: number;
    activeRuns: number;
  };
}

export const workboardApi = {
  /** 获取看板（按状态分组） */
  list: () => getSafe<WorkboardResponse>("/api/workboard", { tasks: {} as Record<WorkboardStatus, WorkboardTask[]>, stats: { totalTasks: 0, byStatus: {}, byAssignee: {}, totalRuns: 0, activeRuns: 0 } }),
  /** 创建看板任务 */
  create: (task: { title: string; description?: string; priority: WorkboardPriority; tags?: string[]; status?: WorkboardStatus; assignee?: string }) =>
    post<{ success: boolean; id: string; task?: WorkboardTask }>("/api/workboard/tasks", task),
  /** 更新任务状态 */
  updateStatus: (taskId: string, status: WorkboardStatus) =>
    post<{ success: boolean }>(`/api/workboard/tasks/${taskId}/status`, { status }),
  /** 更新任务详情 */
  update: (taskId: string, updates: Partial<WorkboardTask>) =>
    put<{ success: boolean }>(`/api/workboard/tasks/${taskId}`, updates),
  /** 删除任务 */
  delete: (taskId: string) =>
    del<{ success: boolean }>(`/api/workboard/tasks/${taskId}`),
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

// ═══════════════════════════════════════════════
// Incoming Webhooks（Incoming Webhook 端点管理）
// ═══════════════════════════════════════════════

export interface WebhookEndpoint {
  id: string;
  path: string;
  method: "POST" | "GET";
  authToken?: string;
  action: string;
  description?: string;
  enabled: boolean;
  createdAt: string;
  lastTriggeredAt?: string;
  triggerCount: number;
}

export interface WebhookEventLog {
  id: string;
  endpointId: string;
  endpointPath: string;
  action: string;
  timestamp: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  statusCode: number;
  error?: string;
}

export interface WebhookTestResult {
  success: boolean;
  statusCode: number;
  response?: unknown;
  eventLog?: WebhookEventLog;
}

export interface WebhookCreateInput {
  id: string;
  path: string;
  method: "POST" | "GET";
  authToken?: string;
  action: string;
  description?: string;
  enabled: boolean;
}

export type WebhookUpdateInput = Partial<Omit<WebhookCreateInput, "id">>;

export const webhooksApi = {
  /** 列出所有 webhook 端点 */
  list: () => getSafe<{ success: boolean; endpoints: WebhookEndpoint[] }>("/api/webhooks", { success: false, endpoints: [] }),
  /** 获取端点详情 */
  get: (id: string) => get<{ success: boolean; endpoint: WebhookEndpoint }>(`/api/webhooks/${encodeURIComponent(id)}`),
  /** 注册新端点 */
  create: (input: WebhookCreateInput) => post<{ success: boolean; endpoint: WebhookEndpoint }>("/api/webhooks", input),
  /** 更新端点 */
  update: (id: string, input: WebhookUpdateInput) =>
    put<{ success: boolean; endpoint: WebhookEndpoint }>(`/api/webhooks/${encodeURIComponent(id)}`, input),
  /** 删除端点 */
  delete: (id: string) => del<{ success: boolean }>(`/api/webhooks/${encodeURIComponent(id)}`),
  /** 测试端点 */
  test: (id: string, testPayload?: unknown) =>
    post<WebhookTestResult>(`/api/webhooks/${encodeURIComponent(id)}/test`, { testPayload }),
  /** 获取事件日志（后端尚未暴露时优雅降级） */
  eventLogs: (signal?: AbortSignal) =>
    getSafe<{ success: boolean; logs: WebhookEventLog[] }>("/api/webhooks/events", { success: false, logs: [] }, signal),
};

// ═══════════════════════════════════════════════
// Tracing（OTel Span 收集器）
// ═══════════════════════════════════════════════

export interface TracingSpan {
  spanId: string;
  traceId: string;
  name: string;
  kind: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status?: string;
  attributes?: Record<string, unknown>;
  parentSpanId?: string;
}

export interface TracingStats {
  totalSpans: number;
  recentSpans: TracingSpan[];
}

export const tracingApi = {
  /** 获取最近的 spans，支持过滤 */
  spans: (opts?: { sessionId?: string; limit?: number; nameContains?: string; traceId?: string; sinceMs?: number }, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (opts?.sessionId) params.set("sessionId", opts.sessionId);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.nameContains) params.set("nameContains", opts.nameContains);
    if (opts?.traceId) params.set("traceId", opts.traceId);
    if (opts?.sinceMs) params.set("sinceMs", String(opts.sinceMs));
    return getSafe<{ spans: TracingSpan[]; count: number; total: number }>(
      `/api/tracing/spans${params.toString() ? `?${params}` : ""}`,
      { spans: [], count: 0, total: 0 },
      signal,
    );
  },
  /** 获取指定 trace 的所有 spans */
  trace: (traceId: string) =>
    getSafe<{ traceId: string; spans: TracingSpan[]; count: number }>(
      `/api/tracing/traces/${encodeURIComponent(traceId)}`,
      { traceId, spans: [], count: 0 },
    ),
  /** 获取诊断统计 */
  stats: () => getSafe<TracingStats>("/api/tracing/stats", { totalSpans: 0, recentSpans: [] }),
  /** 清空 span 缓冲区 */
  clear: () => del<{ cleared: number }>("/api/tracing/spans"),
};

// ═══════════════════════════════════════════════
// System Audit & Failover（系统审计与故障转移）
// ═══════════════════════════════════════════════

export interface AuditAlert {
  id?: string;
  severity?: string;
  message?: string;
  timestamp?: string;
  acknowledged?: boolean;
  [key: string]: unknown;
}

export interface AuditResponse {
  stats: Record<string, unknown>;
  alerts: AuditAlert[];
}

export interface FailoverProviderHealth {
  id?: string;
  name?: string;
  enabled?: boolean;
  circuitState?: string;
  successRateEma?: number;
  dynamicPriority?: number;
  currentKeyIndex?: number;
  [key: string]: unknown;
}

export interface FailoverStatus {
  status: "active" | "unavailable" | string;
  message?: string;
  summary?: Record<string, unknown>;
  providers?: FailoverProviderHealth[];
}

export const systemApi = {
  /** 获取审计中心统计与告警 */
  audit: () => getSafe<AuditResponse>("/api/system/audit", { stats: {}, alerts: [] }),
  /** 获取故障转移状态 */
  failoverStatus: () => getSafe<FailoverStatus>("/api/system/failover/status", { status: "unavailable" }),
  /** 重置故障转移熔断器（不传 providerId 则重置全部） */
  resetFailover: (providerId?: string) =>
    post<{ status: string; message: string }>("/api/system/failover/reset", providerId ? { providerId } : {}),
};

// ═══════════════════════════════════════════════
// Skills Integrity & Translate（技能完整性与翻译）
// ═══════════════════════════════════════════════

export interface SkillIntegrityResult {
  skillId: string;
  skillName: string;
  result: {
    ok: boolean;
    missingOrigin: boolean;
    missingFiles: string[];
    mismatchedFiles: unknown[];
    lockMismatches: string[];
    errors: string[];
  };
}

export interface SkillIntegrityVerifyResponse {
  success: boolean;
  summary: { total: number; ok: number; missingOrigin: number; failed: number };
  results: SkillIntegrityResult[];
}

export interface LockVerifyResult {
  ok: boolean;
  missingOrigin: boolean;
  missingFiles: string[];
  mismatchedFiles: unknown[];
  lockMismatches: string[];
  errors: string[];
}

export interface SkillTranslateResult {
  success: boolean;
  checked?: number;
  translated?: number;
  i18n?: Record<string, unknown>;
}

export const skillsIntegrityApi = {
  /** 校验所有已安装技能的完整性 */
  verifyAll: () => getSafe<SkillIntegrityVerifyResponse>("/api/skills/integrity/verify", { success: false, summary: { total: 0, ok: 0, missingOrigin: 0, failed: 0 }, results: [] }),
  /** 校验单个技能的完整性 */
  verifyOne: (skillId: string) =>
    getSafe<{ success: boolean; result: LockVerifyResult | null }>(
      `/api/skills/integrity/verify/${encodeURIComponent(skillId)}`,
      { success: false, result: null },
    ),
  /** 刷新 lock.json */
  refreshLock: (skillsRoot?: string) =>
    post<{ success: boolean; skillsRoot: string }>("/api/skills/integrity/refresh-lock", skillsRoot ? { skillsRoot } : {}),
  /** 校验 lock.json */
  verifyLock: (skillsRoot?: string) => {
    const qs = skillsRoot ? `?skillsRoot=${encodeURIComponent(skillsRoot)}` : "";
    return getSafe<{ success: boolean; result: LockVerifyResult }>(
      `/api/skills/integrity/verify-lock${qs}`,
      { success: false, result: { ok: false, missingOrigin: false, missingFiles: [], mismatchedFiles: [], lockMismatches: [], errors: [] } },
    );
  },
  /** 翻译所有已安装技能（批量） */
  translateAll: () => post<SkillTranslateResult>("/api/skills/translate"),
  /** 翻译单个技能 */
  translateOne: (skillId: string) =>
    post<SkillTranslateResult>(`/api/skills/${encodeURIComponent(skillId)}/translate`),
};

// ═══════════════════════════════════════════════
// Agent Heartbeat（Agent 心跳）
// ═══════════════════════════════════════════════

export interface HeartbeatStatus {
  enabled: boolean;
  active: boolean;
  state: "idle" | "busy" | string;
  intervalMs: number;
  lastFireTime: string | null;
  nextFireTime: string | null;
  activeConversations: number;
}

export interface HeartbeatConfigResponse {
  success: boolean;
  enabled: boolean;
  active: boolean;
  intervalMs: number;
  nextFireTime: string | null;
}

export const heartbeatApi = {
  /** 获取心跳状态 */
  status: () => getSafe<HeartbeatStatus>("/api/agent/heartbeat-status", {
    enabled: false, active: false, state: "idle", intervalMs: 0,
    lastFireTime: null, nextFireTime: null, activeConversations: 0,
  }),
  /** 更新心跳配置 */
  configure: (config: { intervalMs?: number; enabled?: boolean }) =>
    post<HeartbeatConfigResponse>("/api/agent/heartbeat/config", config),
};

// ═══════════════════════════════════════════════
// Evolution Learning（进化学习记录写入）
// ═══════════════════════════════════════════════

export interface LearningRecordResult {
  status: string;
  message: string;
}

export const learningApi = {
  /** 记录用户纠正 */
  correction: (body: {
    title?: string; context?: string; originalError?: string;
    correction?: string; preferredApproach?: string;
    source?: string; tags?: string[]; triggerEvolution?: boolean;
  }) => post<LearningRecordResult>("/api/evolution/learning/correction", body),
  /** 记录能力缺口 */
  gap: (body: {
    capability?: string; title?: string; context?: string;
    suggestedSolution?: string; source?: string;
    tags?: string[]; triggerEvolution?: boolean;
  }) => post<LearningRecordResult>("/api/evolution/learning/gap", body),
  /** 记录外部失败 */
  failure: (body: {
    service?: string; endpoint?: string; error?: string;
    context?: string; rootCause?: string; fallback?: string;
    fallbackCode?: string; source?: string; severity?: string;
    tags?: string[]; triggerEvolution?: boolean;
  }) => post<LearningRecordResult>("/api/evolution/learning/failure", body),
  /** 记录知识改进 */
  improvement: (body: {
    title?: string; description?: string; context?: string;
    isOutdated?: boolean; newApproach?: string;
    recommendedAction?: string; improvedCode?: string;
    source?: string; tags?: string[]; triggerEvolution?: boolean;
  }) => post<LearningRecordResult>("/api/evolution/learning/improvement", body),
};

// ═══════════════════════════════════════════════
// Compactions（任意会话的压缩链）
// ═══════════════════════════════════════════════

export const compactionsApi = {
  /** 获取指定会话的压缩链 */
  get: (sessionId: string) =>
    getSafe<{ compactions: unknown[] }>(
      `/api/compactions/${encodeURIComponent(sessionId)}`,
      { compactions: [] },
    ),
};

// ═══════════════════════════════════════════════
// MoA (Mixture-of-Agents) 多模型推理
// ═══════════════════════════════════════════════

export interface MoaModelRef {
  provider: string;
  model: string;
  weight?: number;
}

export interface MoaConfigView {
  proposers: MoaModelRef[];
  aggregator?: MoaModelRef;
  verifier?: MoaModelRef;
  synthesizer: MoaModelRef;
  aggregationStrategy?: string;
  verificationEnabled?: boolean;
}

export interface MoaProposalView {
  model: string;
  content: string;
  latency: number;
  tokens: number;
  success: boolean;
  error?: string;
}

export interface MoaRunResult {
  prompt: string;
  proposals: MoaProposalView[];
  aggregation: { strategy: string; aggregatedContent: string };
  verification?: { passed: boolean; conflicts: unknown[] };
  finalAnswer: string;
  stats: { totalLatencyMs: number; totalTokens: number; totalCost: number };
}

export interface MoaStatsView {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  totalLatencyMs: number;
  totalTokens: number;
  totalCost: number;
  averageLatencyMs: number;
}

export interface MoaStatusResponse {
  config: MoaConfigView | null;
  stats: MoaStatsView;
  available: boolean;
}

export interface MoaHistoryResponse {
  history: MoaRunResult[];
  total: number;
}

export const moaApi = {
  status: () => getSafe<MoaStatusResponse>("/api/moa/status", {
    config: null, stats: {
      totalRuns: 0, successfulRuns: 0, failedRuns: 0,
      totalLatencyMs: 0, totalTokens: 0, totalCost: 0, averageLatencyMs: 0,
    }, available: false,
  }),
  run: (prompt: string, context?: unknown) =>
    post<MoaRunResult>("/api/moa/run", { prompt, ...(context !== undefined ? { context } : {}) }),
  history: () => getSafe<MoaHistoryResponse>("/api/moa/history", { history: [], total: 0 }),
};

// ═══════════════════════════════════════════════
// A2A (Agent-to-Agent) 协议
// ═══════════════════════════════════════════════

export interface A2ACapability {
  id: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: A2ACapability[];
  authentication?: { type: string };
}

export interface A2ARemoteAgent {
  id: string;
  name?: string;
  description?: string;
  url: string;
  capabilities?: string[];
  version?: string;
  lastSeen?: string;
}

export interface A2ATaskRequest {
  taskId?: string;
  agentId?: string;
  prompt: string;
  context?: Record<string, unknown>;
}

export interface A2ATaskResult {
  taskId: string;
  status: string;
  result?: unknown;
  error?: string;
}

export const a2aApi = {
  card: () => getSafe<A2AAgentCard | null>("/a2a/card", null),
  agents: () => getSafe<{ agents: A2ARemoteAgent[] }>("/a2a/agents", { agents: [] }),
  sendTask: (task: A2ATaskRequest) =>
    post<A2ATaskResult>("/a2a/task", task),
};

// ═══════════════════════════════════════════════
// ACP (Agent Client Protocol) IDE 集成
// ═══════════════════════════════════════════════

export interface AcpAgentInfo {
  id: string;
  name?: string;
  description?: string;
  capabilities?: string[];
  connected?: boolean;
  connectedAt?: string;
  frontend?: string;
  type?: string;
}

export const acpApi = {
  agents: () => getSafe<AcpAgentInfo[]>("/api/acp/agents", []),
};

// ═══════════════════════════════════════════════
// Kanban 多 Agent 工作队列
// ═══════════════════════════════════════════════

export type KanbanTaskStatus =
  | "pending" | "ready" | "claimed" | "in_progress"
  | "review" | "done" | "blocked" | "failed";

export type KanbanTaskPriority = "high" | "medium" | "low";

export interface KanbanTask {
  id: string;
  boardId: string;
  title: string;
  description: string;
  status: KanbanTaskStatus;
  priority: KanbanTaskPriority;
  assignedAgent: string | null;
  dependencies: string[];
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  result: unknown;
  error: string | null;
  tenant: string | null;
}

export interface KanbanBoardInfo {
  boardId: string;
  tenant?: string | null;
  totalTasks?: number;
  byStatus?: Partial<Record<KanbanTaskStatus, number>>;
}

export interface KanbanBoardStats {
  total: number;
  byStatus: Partial<Record<KanbanTaskStatus, number>>;
  byPriority: { high: number; medium: number; low: number };
}

export const kanbanApi = {
  listBoards: () => getSafe<{ boards: KanbanBoardInfo[] }>("/api/kanban/boards", { boards: [] }),
  createBoard: (boardId: string, tenant?: string) =>
    post<{ success: boolean; boardId: string }>("/api/kanban/boards", { boardId, ...(tenant ? { tenant } : {}) }),
  listTasks: (boardId: string) =>
    getSafe<{ tasks: KanbanTask[] }>(`/api/kanban/boards/${encodeURIComponent(boardId)}/tasks`, { tasks: [] }),
  addTask: (boardId: string, task: {
    title: string; description?: string; priority?: KanbanTaskPriority;
    dependencies?: string[]; tenant?: string;
  }) => post<KanbanTask>(`/api/kanban/boards/${encodeURIComponent(boardId)}/tasks`, task),
  claimTask: (taskId: string, agentId: string) =>
    post<KanbanTask>(`/api/kanban/tasks/${encodeURIComponent(taskId)}/claim`, { agentId }),
  completeTask: (taskId: string, result?: unknown) =>
    post<KanbanTask>(`/api/kanban/tasks/${encodeURIComponent(taskId)}/complete`, { result }),
  stats: (boardId: string) =>
    getSafe<KanbanBoardStats>(`/api/kanban/boards/${encodeURIComponent(boardId)}/stats`, {
      total: 0, byStatus: {}, byPriority: { high: 0, medium: 0, low: 0 },
    }),
};

// ═══════════════════════════════════════════════
// Computer Use 桌面控制
// ═══════════════════════════════════════════════

export interface ComputerUseStatus {
  isAvailable: boolean;
  backend?: string;
  screenSize?: { width: number; height: number };
}

export interface ScreenshotResult {
  image: string;
  width: number;
  height: number;
  takenAt: string;
}

export interface ComputerUseOpResult {
  success: boolean;
  message?: string;
  timestamp: string;
}

export const computerUseApi = {
  status: () => getSafe<ComputerUseStatus>("/api/computer-use/status", { isAvailable: false }),
  screenshot: () => post<ScreenshotResult>("/api/computer-use/screenshot"),
  mouseClick: (x: number, y: number, button?: "left" | "right" | "middle", doubleClick?: boolean) =>
    post<ComputerUseOpResult>("/api/computer-use/mouse-click", { x, y, button: button || "left", doubleClick: doubleClick || false }),
  keyType: (text: string) =>
    post<ComputerUseOpResult>("/api/computer-use/key-type", { text }),
  keyPress: (keys: string[]) =>
    post<ComputerUseOpResult>("/api/computer-use/key-press", { keys }),
};

// ═══════════════════════════════════════════════
// Tool Search 工具搜索
// ═══════════════════════════════════════════════

export interface ToolSearchResultItem {
  name: string;
  score: number;
  matchedTerms: string[];
  reason: string;
}

export interface IndexedTool {
  name: string;
  description: string;
  category?: string;
  alwaysVisible?: boolean;
}

export interface ToolSearchStats {
  totalTools: number;
  activated: boolean;
  mode: string;
  visibleTools: number;
  deferrableTools: number;
}

export const toolSearchApi = {
  stats: () => getSafe<ToolSearchStats>("/api/tool-search/stats", {
    totalTools: 0, activated: false, mode: "auto", visibleTools: 0, deferrableTools: 0,
  }),
  search: (query: string, maxResults?: number) =>
    post<{ results: ToolSearchResultItem[] }>("/api/tool-search/search", { query, ...(maxResults !== undefined ? { maxResults } : {}) }),
  tools: () => getSafe<{ tools: IndexedTool[] }>("/api/tool-search/tools", { tools: [] }),
};