/**
 * Session State Manager — 多轮状态持久化
 *
 * 借鉴 Claude Agent SDK 的 Sessions 机制：
 *   - continue: 接续上一轮对话继续执行
 *   - resume: 恢复历史会话的完整上下文（重放消息历史）
 *   - fork: 从某个时间点分叉，继承上下文到新的分支
 *
 * 参考: https://code.claude.com/docs/en/agent-sdk/sessions
 */

// ── Types ──

export interface SessionMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
  timestamp: number;
}

export interface SessionState {
  /** Unique session identifier (UUID) */
  sessionId: string;
  /** Parent session in fork chains */
  parentSessionId?: string;
  /** Full message history */
  messages: SessionMessage[];
  /** User's original intent / task description */
  intent: string;
  /** Current task progress (0-1) */
  progress: number;
  /** Pending sub-tasks */
  pendingTasks: string[];
  /** Completed sub-tasks with results */
  completedTasks: Map<string, string>;
  /** Key decisions made during the session */
  decisions: string[];
  /** Files created/modified during the session */
  touchedFiles: Set<string>;
  /** Errors encountered and resolved */
  errorLog: Array<{ error: string; resolved: boolean }>;
  /** Session creation timestamp */
  createdAt: number;
  /** Last activity timestamp */
  lastUpdatedAt: number;
  /** Model used for this session */
  model: string;
  /** Total tokens consumed */
  totalTokens: number;
  /** Custom metadata */
  meta: Record<string, unknown>;
}

export interface SessionStore {
  /** Save session state to persistent storage */
  save(session: SessionState): Promise<void>;
  /** Load session state by ID */
  load(sessionId: string): Promise<SessionState | null>;
  /** List all available sessions */
  list(filter?: { intent?: string; since?: number }): Promise<SessionState[]>;
  /** Delete a session */
  delete(sessionId: string): Promise<void>;
}

export interface SessionFork {
  /** Original session ID */
  sourceSessionId: string;
  /** Fork name / label */
  label: string;
  /** Message index to fork from (undefined = latest) */
  forkAtMessageIndex?: number;
}

// ── In-Memory Session Store ──

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionState>();

  async save(session: SessionState): Promise<void> {
    session.lastUpdatedAt = Date.now();
    this.sessions.set(session.sessionId, structuredClone(session));
  }

  async load(sessionId: string): Promise<SessionState | null> {
    const s = this.sessions.get(sessionId);
    return s ? structuredClone(s) : null;
  }

  async list(filter?: { intent?: string; since?: number }): Promise<SessionState[]> {
    let results = Array.from(this.sessions.values());
    if (filter?.intent) {
      const q = filter.intent.toLowerCase();
      results = results.filter((s) => s.intent.toLowerCase().includes(q));
    }
    if (filter?.since !== undefined) {
      results = results.filter((s) => s.createdAt >= filter.since!);
    }
    return results.map((s) => structuredClone(s)).sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

// ── Factory ──

/** Create a new session state */
export function createSessionState(
  intent: string,
  options: {
    model?: string;
    parentSessionId?: string;
    messages?: SessionMessage[];
  } = {},
): SessionState {
  const now = Date.now();
  return {
    sessionId: crypto.randomUUID(),
    parentSessionId: options.parentSessionId,
    messages: options.messages ?? [],
    intent,
    progress: 0,
    pendingTasks: [],
    completedTasks: new Map(),
    decisions: [],
    touchedFiles: new Set(),
    errorLog: [],
    createdAt: now,
    lastUpdatedAt: now,
    model: options.model ?? "unknown",
    totalTokens: 0,
    meta: {},
  };
}

// ── Session Operations (Inspired by Claude SDK: continue / resume / fork) ──

/**
 * Continue a session — append a new user message and return the updated state.
 * (Claude SDK: session.continue() — the default mode)
 */
export async function continueSession(
  store: SessionStore,
  sessionId: string,
  userMessage: SessionMessage,
): Promise<SessionState | null> {
  const session = await store.load(sessionId);
  if (!session) return null;

  session.messages.push(userMessage);
  session.lastUpdatedAt = Date.now();
  await store.save(session);
  return session;
}

/**
 * Resume a session — restore full context including all messages, decisions, errors.
 * (Claude SDK: resume=session_id — replays entire history)
 */
export async function resumeSession(
  store: SessionStore,
  sessionId: string,
): Promise<{
  session: SessionState;
  resumeContext: string;
} | null> {
  const session = await store.load(sessionId);
  if (!session) return null;

  // Build a compact resume context string for the LLM
  const parts: string[] = [
    `[Resuming session ${sessionId}]`,
    `Original intent: ${session.intent}`,
    `Progress: ${Math.round(session.progress * 100)}%`,
  ];

  if (session.decisions.length > 0) {
    parts.push(`Key decisions: ${session.decisions.join("; ")}`);
  }
  if (session.touchedFiles.size > 0) {
    parts.push(`Files touched: ${Array.from(session.touchedFiles).join(", ")}`);
  }
  if (session.completedTasks.size > 0) {
    parts.push("Completed: " + Array.from(session.completedTasks.entries()).map(([k]) => k).join(", "));
  }
  if (session.pendingTasks.length > 0) {
    parts.push(`Pending: ${session.pendingTasks.join(", ")}`);
  }
  if (session.errorLog.length > 0) {
    const unresolved = session.errorLog.filter((e) => !e.resolved);
    if (unresolved.length > 0) {
      parts.push(`⚠ Unresolved errors: ${unresolved.map((e) => e.error).join("; ")}`);
    }
  }

  return { session, resumeContext: parts.join("\n") };
}

/**
 * Fork a session — create a new branch from a checkpoint in the original.
 * (Claude SDK: forkSession: true — creates an independent branch)
 */
export async function forkSession(
  store: SessionStore,
  fork: SessionFork,
  storeForked?: SessionStore,
): Promise<SessionState | null> {
  const source = await store.load(fork.sourceSessionId);
  if (!source) return null;

  const forkIndex = fork.forkAtMessageIndex ?? source.messages.length;
  const forkedMessages = source.messages.slice(0, forkIndex);

  const targetStore = storeForked ?? store;
  const newSession = createSessionState(source.intent, {
    model: source.model,
    parentSessionId: source.sessionId,
    messages: forkedMessages,
  });
  newSession.decisions = [...source.decisions];
  newSession.touchedFiles = new Set(source.touchedFiles);
  // 深拷贝 source.meta，避免 fork 与源会话共享嵌套对象引用
  // 使用 structuredClone（Node 20+ 原生支持），避免 JSON 方式遇到循环引用时崩溃
  newSession.meta = {
    ...structuredClone(source.meta),
    forkLabel: fork.label,
    forkSourceId: source.sessionId,
    forkIndex,
  };

  await targetStore.save(newSession);
  return newSession;
}