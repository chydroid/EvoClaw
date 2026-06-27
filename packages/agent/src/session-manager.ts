/**
 * SessionManager — OpenClaw-style session lifecycle management.
 *
 * Features:
 * - File-based session write locks (process-aware, catches cross-process writers)
 * - JSONL transcript persistence
 * - Session rotation / successor chaining
 * - Concurrent access protection
 * - Compaction + pruning integration
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionConfig {
  /** Root directory for session storage */
  sessionsDir: string;
  /** Default max turns before triggering auto-compaction */
  maxTurnsBeforeCompaction?: number;
  /** Write lock acquire timeout in ms */
  writeLockTimeoutMs?: number;
  /** Whether to enable successor transcripts on compaction */
  truncateAfterCompaction?: boolean;
  /** Max active transcript bytes before triggering byte guard */
  maxActiveTranscriptBytes?: number;
}

export interface SessionLock {
  sessionId: string;
  lockPath: string;
  acquiredAt: number;
  processId: number;
  reentrant: boolean;
  reentrantCount: number;
}

export interface SessionInfo {
  sessionId: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  status: "active" | "compacted" | "archived" | "error";
  predecessorSessionId?: string;
  successorSessionId?: string;
  compactionCount: number;
  tokenEstimate: number;
  preview?: string;
  customName?: string;
}

export interface SessionInsights {
  sessionId: string;
  agentId: string;
  transcriptSizeBytes: number;
  turnCount: number;
  tokenEstimate: number;
  averageTokensPerTurn: number;
  compressionRatio: number;
}

export interface GlobalSessionInsights {
  totalSessions: number;
  totalTurns: number;
  totalTokens: number;
  totalTranscriptBytes: number;
  averageCompressionRatio: number;
}

export interface SessionTurn {
  turnIndex: number;
  role: "user" | "assistant" | "tool" | "system";
  content: string | null;
  timestamp: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  toolCallId?: string;
  toolResult?: unknown;
  metadata?: Record<string, unknown>;
}

export interface SessionLoadResult {
  session: SessionInfo;
  turns: SessionTurn[];
  predecessorId?: string;
  successorId?: string;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Partial<SessionConfig> = {
  maxTurnsBeforeCompaction: 100,
  writeLockTimeoutMs: 60000,
  truncateAfterCompaction: true,
  maxActiveTranscriptBytes: 10 * 1024 * 1024, // 10 MB
};

// ─── Session Manager ──────────────────────────────────────────────────────────

export class SessionManager {
  private config: SessionConfig;
  private activeLocks = new Map<string, SessionLock>();
  private sessionCache = new Map<string, SessionInfo>();
  private pendingCompactions = new Set<string>();

  constructor(config: SessionConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Ensure sessions directory exists
    if (!fs.existsSync(this.config.sessionsDir)) {
      fs.mkdirSync(this.config.sessionsDir, { recursive: true });
    }
  }

  // ─── Session Lifecycle ────────────────────────────────────────────────────

  /** Create a new session */
  createSession(agentId: string, options?: {
    sessionId?: string;
    predecessorSessionId?: string;
  }): SessionInfo {
    const sessionId = options?.sessionId ?? this.generateSessionId();
    const now = new Date().toISOString();

    const session: SessionInfo = {
      sessionId,
      agentId,
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
      status: "active",
      predecessorSessionId: options?.predecessorSessionId,
      compactionCount: 0,
      tokenEstimate: 0,
    };

    // Create session directory
    const agentDir = this.getAgentDir(agentId);
    if (!fs.existsSync(agentDir)) {
      fs.mkdirSync(agentDir, { recursive: true });
    }

    // Create session metadata
    this.writeSessionMeta(session);

    // Create empty transcript
    const transcriptPath = this.getTranscriptPath(agentId, sessionId);
    try {
      fs.writeFileSync(transcriptPath, "", "utf-8");
    } catch (err) {
      process.stderr.write(`[SessionManager] Failed to create empty transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Cache
    this.sessionCache.set(sessionId, session);

    process.stdout.write(`[SessionManager] Created session ${sessionId} for agent "${agentId}"`);
    return session;
  }

  /** Get or create a session */
  getOrCreateSession(agentId: string, sessionId?: string): SessionInfo {
    if (sessionId) {
      const existing = this.loadSessionMeta(agentId, sessionId);
      if (existing && existing.status === "active") {
        return existing;
      }
    }
    return this.createSession(agentId, { sessionId });
  }

  /** Load session metadata */
  loadSessionMeta(agentId: string, sessionId: string): SessionInfo | null {
    // Check cache first
    const cached = this.sessionCache.get(sessionId);
    if (cached) return cached;

    const metaPath = this.getSessionMetaPath(agentId, sessionId);
    if (!fs.existsSync(metaPath)) return null;

    try {
      const data = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      this.sessionCache.set(sessionId, data);
      return data as SessionInfo;
    } catch (err) {
      // 元数据损坏时记录到 stderr，避免静默吞错
      process.stderr.write("[SessionManager] loadSessionMeta corrupt: " + err + "\n");
      return null;
    }
  }

  /** Update session metadata under a write lock. */
  updateSessionMeta(session: SessionInfo): void {
    this.withLock(session.agentId, session.sessionId, () => {
      session.updatedAt = new Date().toISOString();
      this.writeSessionMeta(session);
      this.sessionCache.set(session.sessionId, session);
    });
  }

  /** Archive a session */
  archiveSession(agentId: string, sessionId: string, reason: string): void {
    const session = this.loadSessionMeta(agentId, sessionId);
    if (!session) return;

    session.status = "archived";
    this.updateSessionMeta(session);
    process.stdout.write(`[SessionManager] Archived session ${sessionId}: ${reason}`);
  }

  /** Delete a session completely */
  deleteSession(agentId: string, sessionId: string): boolean {
    // 使用 withLock 确保删除操作与其他并发操作互斥，
    // 防止删除正在写入的会话文件导致状态不一致。
    const result = this.withLock(agentId, sessionId, () => {
      try {
        const sessionDir = path.join(this.getAgentDir(agentId), sessionId);
        if (!fs.existsSync(sessionDir)) {
          process.stderr.write(`[SessionManager] Session ${sessionId} not found for deletion`);
          return false;
        }

        // Remove session directory recursively
        this.rmdirRecursive(sessionDir);

        // Remove from cache
        this.sessionCache.delete(sessionId);

        process.stdout.write(`[SessionManager] Deleted session ${sessionId} for agent "${agentId}"`);
        return true;
      } catch (err) {
        process.stderr.write(`[SessionManager] Failed to delete session ${sessionId}:` + " " + err);
        return false;
      }
    });

    // withLock 返回 null 表示获取锁失败，此时不应继续删除
    if (result === null) {
      process.stderr.write(`[SessionManager] Could not acquire lock to delete session ${sessionId}`);
      return false;
    }

    // 锁释放后清理锁文件（withLock 已释放锁，但锁文件可能残留）
    const lockPath = path.join(this.getLockDir(), `${sessionId}.lock`);
    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // 锁文件清理失败不阻断删除
    }
    this.activeLocks.delete(sessionId);

    return result;
  }

  private rmdirRecursive(dir: string): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.rmdirRecursive(fullPath);
      } else {
        fs.unlinkSync(fullPath);
      }
    }
    fs.rmdirSync(dir);
  }

  // ─── Transcript I/O ───────────────────────────────────────────────────────

  /** Load all turns from a session transcript */
  loadTranscript(agentId: string, sessionId: string): SessionTurn[] {
    const transcriptPath = this.getTranscriptPath(agentId, sessionId);
    if (!fs.existsSync(transcriptPath)) return [];

    const turns: SessionTurn[] = [];
    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      try {
        turns.push(JSON.parse(line) as SessionTurn);
      } catch {
        // Skip malformed lines
      }
    }

    return turns;
  }

  /** Append a turn to the transcript with automatic write-lock protection. */
  appendTurn(agentId: string, sessionId: string, turn: SessionTurn): void {
    this.withLock(agentId, sessionId, () => {
      const transcriptPath = this.getTranscriptPath(agentId, sessionId);
      const line = JSON.stringify(turn) + "\n";
      fs.appendFileSync(transcriptPath, line, "utf-8");

      // Update session metadata
      const session = this.loadSessionMeta(agentId, sessionId);
      if (session) {
        session.turnCount++;
        session.tokenEstimate += this.estimateTurnTokens(turn);
        this.updateSessionMeta(session);
      }
    });
  }

  /** Load full session (metadata + turns) */
  loadSession(agentId: string, sessionId: string): SessionLoadResult | null {
    return this.withLock(agentId, sessionId, () => {
      const session = this.loadSessionMeta(agentId, sessionId);
      if (!session) return null;

      const turns = this.loadTranscript(agentId, sessionId);

      return {
        session,
        turns,
        predecessorId: session.predecessorSessionId,
        successorId: session.successorSessionId,
      };
    }) ?? null;
  }

  /** Rewrite the entire transcript (used by compaction) with write-lock protection. */
  rewriteTranscript(agentId: string, sessionId: string, turns: SessionTurn[]): void {
    this.withLock(agentId, sessionId, () => {
      const transcriptPath = this.getTranscriptPath(agentId, sessionId);
      const lines = turns.map((t) => JSON.stringify(t) + "\n").join("");
      fs.writeFileSync(transcriptPath, lines, "utf-8");

      // Update metadata
      const session = this.loadSessionMeta(agentId, sessionId);
      if (session) {
        session.turnCount = turns.length;
        session.tokenEstimate = turns.reduce((sum, t) => sum + this.estimateTurnTokens(t), 0);
        this.updateSessionMeta(session);
      }
    });
  }

  // ─── Write Locks ──────────────────────────────────────────────────────────

  /**
   * Acquire a write lock for a session. The lock is file-based and process-aware,
   * so it catches writers from other processes.
   */
  acquireLock(agentId: string, sessionId: string, options?: {
    allowReentrant?: boolean;
    timeoutMs?: number;
  }): SessionLock | null {
    const timeoutMs = options?.timeoutMs ?? this.config.writeLockTimeoutMs ?? 60000;
    const allowReentrant = options?.allowReentrant ?? false;

    // Check if already held by this process
    const existing = this.activeLocks.get(sessionId);
    if (existing) {
      if (allowReentrant) {
        existing.reentrant = true;
        existing.reentrantCount++;
        return existing;
      }
      return null; // Non-reentrant by default
    }

    const lockDir = this.getLockDir();
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }

    const lockPath = path.join(lockDir, `${sessionId}.lock`);
    const pid = process.pid;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      try {
        // Try to create lock file directly (atomic operation with wx flag)
        try {
          fs.writeFileSync(lockPath, String(pid), { flag: "wx" });
          const lock: SessionLock = {
            sessionId,
            lockPath,
            acquiredAt: Date.now(),
            processId: pid,
            reentrant: false,
            reentrantCount: 1,
          };
          this.activeLocks.set(sessionId, lock);
          return lock;
        } catch (writeErr: any) {
          if (writeErr.code !== "EEXIST") throw writeErr;
          // Lock file already exists, check for stale lock below
        }

        // Check for stale lock (process no longer exists)
        try {
          const lockPid = parseInt(fs.readFileSync(lockPath, "utf-8"), 10);
          // parseInt 返回 NaN 时（lock 文件损坏/篡改），视为 stale 让重试流程接管
          if (!Number.isFinite(lockPid) || !this.isProcessAlive(lockPid)) {
            // Stale lock — 原子地 rename 到唯一临时名后删除，避免 TOCTOU 竞态。
            // 两个进程可能同时判断 lock 为 stale，rename 是原子的，
            // 只有一个会成功，另一个会因 ENOENT 失败（被 catch 后 continue）。
            const staleTmp = `${lockPath}.${process.pid}.${Date.now()}.stale`;
            try {
              fs.renameSync(lockPath, staleTmp);
              try { fs.unlinkSync(staleTmp); } catch { /* ignore */ }
            } catch (renameErr: unknown) {
              const code = (renameErr as NodeJS.ErrnoException)?.code;
              if (code === "ENOENT") {
                // 另一个进程已经处理了 stale lock，直接重试创建
              } else {
                throw renameErr;
              }
            }
            continue;
          }
        } catch {
          // If we can't read the lock file, just remove it
          try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
          continue;
        }

        // Wait and retry
        const waitMs = Math.min(100, timeoutMs - (Date.now() - startedAt));
        this.sleepSync(waitMs);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("EEXIST") && !msg.includes("ENOENT")) {
          process.stderr.write(`[SessionManager] Lock error for ${sessionId}:` + " " + err);
        }
      }
    }

    process.stderr.write(`[SessionManager] Failed to acquire lock for ${sessionId} after ${timeoutMs}ms`);
    return null;
  }

  /** Release a write lock. Reentrant locks must be released as many times as they were acquired. */
  releaseLock(lock: SessionLock): void {
    lock.reentrantCount--;
    if (lock.reentrantCount > 0) {
      this.activeLocks.set(lock.sessionId, lock);
      return;
    }

    this.activeLocks.delete(lock.sessionId);
    try {
      if (fs.existsSync(lock.lockPath)) {
        fs.unlinkSync(lock.lockPath);
      }
    } catch (err) {
      process.stderr.write(`[SessionManager] Failed to release lock for ${lock.sessionId}:` + " " + err);
    }
  }

  /** Execute a function while holding the session write lock. Reentrant-safe. */
  withLock<T>(agentId: string, sessionId: string, fn: () => T): T | null {
    const lock = this.acquireLock(agentId, sessionId, { allowReentrant: true });
    if (!lock) {
      process.stderr.write(`[SessionManager] Could not acquire lock for ${sessionId}\n`);
      return null;
    }
    try {
      return fn();
    } finally {
      this.releaseLock(lock);
    }
  }

  /** Check if a session is currently locked */
  isLocked(sessionId: string): boolean {
    return this.activeLocks.has(sessionId);
  }

  /** Get the lock holder PID (if any) */
  getLockHolder(sessionId: string): number | null {
    const lock = this.activeLocks.get(sessionId);
    if (lock) return lock.processId;

    const lockPath = path.join(this.getLockDir(), `${sessionId}.lock`);
    if (!fs.existsSync(lockPath)) return null;

    try {
      const pid = parseInt(fs.readFileSync(lockPath, "utf-8"), 10);
      // parseInt 对损坏/篡改的 lock 文件返回 NaN，应视为无 holder（与文件不存在等价）
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  // ─── Compaction Helpers ────────────────────────────────────────────────────

  /** Check if the session transcript exceeds the byte guard limit */
  checkByteGuard(agentId: string, sessionId: string): boolean {
    if (!this.config.maxActiveTranscriptBytes) return false;
    if (!this.config.truncateAfterCompaction) return false;

    const transcriptPath = this.getTranscriptPath(agentId, sessionId);
    if (!fs.existsSync(transcriptPath)) return false;

    const stats = fs.statSync(transcriptPath);
    return stats.size > this.config.maxActiveTranscriptBytes;
  }

  /** Mark a session as compacted and create successor link */
  markCompacted(
    agentId: string,
    parentSessionId: string,
    successorSessionId: string,
    compactionSummary: string,
  ): void {
    const parent = this.loadSessionMeta(agentId, parentSessionId);
    if (parent) {
      parent.status = "compacted";
      parent.successorSessionId = successorSessionId;
      parent.compactionCount++;
      this.updateSessionMeta(parent);
    }

    // Mark the successor's predecessor
    const successor = this.loadSessionMeta(agentId, successorSessionId);
    if (successor) {
      successor.predecessorSessionId = parentSessionId;
      this.updateSessionMeta(successor);
    }

    process.stdout.write(`[SessionManager] Compaction chain: ${parentSessionId} -> ${successorSessionId}`);
  }

  // ─── List / Query ──────────────────────────────────────────────────────────

  /** List all sessions for an agent */
  listSessions(agentId: string): SessionInfo[] {
    const agentDir = this.getAgentDir(agentId);
    if (!fs.existsSync(agentDir)) return [];

    const sessions: SessionInfo[] = [];
    const entries = fs.readdirSync(agentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const session = this.loadSessionMeta(agentId, entry.name);
        if (session) {
          // Get the first message preview
          const preview = this.getFirstMessagePreview(agentId, entry.name);
          if (preview) {
            session.preview = preview;
          }
          sessions.push(session);
        }
      }
    }

    return sessions.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  /** Get the first user message preview (first 23 chars by word count) */
  private getFirstMessagePreview(agentId: string, sessionId: string): string | null {
    const turns = this.loadTranscript(agentId, sessionId);
    if (turns.length === 0) return null;

    // Find the first user message
    const firstUserTurn = turns.find((t) => t.role === "user" && t.content);
    let content: string;
    
    if (firstUserTurn && firstUserTurn.content) {
      content = String(firstUserTurn.content).trim();
    } else {
      // Fallback to first message if no user message
      const firstTurn = turns.find((t) => t.content);
      if (!firstTurn || !firstTurn.content) return null;
      content = String(firstTurn.content).trim();
    }

    // Skip if content is too long (likely a web scrape)
    if (content.length > 5000) return null;

    // Normalize whitespace: collapse multiple spaces to one, trim
    const cleanContent = content.replace(/\s+/g, " ").trim();
    
    // Check if content looks valid (at least some Chinese or English characters)
    if (!/[\u4e00-\u9fa5a-zA-Z]/.test(cleanContent) || cleanContent.length === 0) {
      return null;
    }

    // Simple implementation: return first 23 characters directly
    if (cleanContent.length <= 23) {
      return cleanContent;
    }
    return cleanContent.substring(0, 23) + "...";
  }

  /** Calculate preview length based on word count rules */
  private calculatePreviewLength(content: string, targetWordCount: number): number {
    let wordCount = 0;
    let charIndex = 0;
    let englishBuffer = 0;
    
    while (charIndex < content.length && wordCount < targetWordCount) {
      const char = content[charIndex];
      
      if (/[\u4e00-\u9fa5]/.test(char)) {
        // Chinese character = 1 word
        wordCount++;
        charIndex++;
      } else if (/[a-zA-Z]/.test(char)) {
        // English letter - 2 letters = 1 word
        englishBuffer++;
        charIndex++;
        if (englishBuffer >= 2) {
          wordCount++;
          englishBuffer = 0;
        }
      } else {
        // Other characters (numbers, symbols) - count as part of word but not as word boundary
        charIndex++;
      }
    }
    
    // If we have remaining English letters, count them as a word
    if (englishBuffer > 0 && wordCount < targetWordCount) {
      wordCount++;
    }
    
    return charIndex;
  }

  /** List all agent directories */
  listAgents(): string[] {
    if (!fs.existsSync(this.config.sessionsDir)) return [];

    const entries = fs.readdirSync(this.config.sessionsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  // ─── Insights ─────────────────────────────────────────────────────────────

  /** Get storage and compression insights for a single session. */
  getSessionInsights(agentId: string, sessionId: string): SessionInsights | null {
    const session = this.loadSessionMeta(agentId, sessionId);
    if (!session) return null;

    const transcriptPath = this.getTranscriptPath(agentId, sessionId);
    let transcriptSizeBytes = 0;
    if (fs.existsSync(transcriptPath)) {
      transcriptSizeBytes = fs.statSync(transcriptPath).size;
    }

    const turnCount = session.turnCount;
    const tokenEstimate = session.tokenEstimate;
    const averageTokensPerTurn = turnCount > 0 ? tokenEstimate / turnCount : 0;
    // Approximate bytes per token for a JSONL file; ratio > 1 means we store less
    // bytes than raw token count (compressed/efficient), ratio < 1 means verbose.
    const compressionRatio = tokenEstimate > 0 && transcriptSizeBytes > 0
      ? tokenEstimate / (transcriptSizeBytes / 4)
      : 0;

    return {
      sessionId,
      agentId,
      transcriptSizeBytes,
      turnCount,
      tokenEstimate,
      averageTokensPerTurn,
      compressionRatio,
    };
  }

  /** Aggregate insights across all agents and sessions. */
  getGlobalInsights(): GlobalSessionInsights {
    const agents = this.listAgents();
    let totalSessions = 0;
    let totalTurns = 0;
    let totalTokens = 0;
    let totalTranscriptBytes = 0;

    for (const agentId of agents) {
      for (const session of this.listSessions(agentId)) {
        totalSessions++;
        totalTurns += session.turnCount;
        totalTokens += session.tokenEstimate;
        const insights = this.getSessionInsights(agentId, session.sessionId);
        if (insights) {
          totalTranscriptBytes += insights.transcriptSizeBytes;
        }
      }
    }

    const averageCompressionRatio = totalTokens > 0 && totalTranscriptBytes > 0
      ? totalTokens / (totalTranscriptBytes / 4)
      : 0;

    return {
      totalSessions,
      totalTurns,
      totalTokens,
      totalTranscriptBytes,
      averageCompressionRatio,
    };
  }

  // ─── Internal Helpers ─────────────────────────────────────────────────────

  private getAgentDir(agentId: string): string {
    return path.join(this.config.sessionsDir, agentId);
  }

  private getTranscriptPath(agentId: string, sessionId: string): string {
    return path.join(this.getAgentDir(agentId), sessionId, "transcript.jsonl");
  }

  private getSessionMetaPath(agentId: string, sessionId: string): string {
    return path.join(this.getAgentDir(agentId), sessionId, "session.json");
  }

  private getLockDir(): string {
    return path.join(this.config.sessionsDir, ".locks");
  }

  private writeSessionMeta(session: SessionInfo): void {
    const dir = path.join(this.getAgentDir(session.agentId), session.sessionId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const metaPath = path.join(dir, "session.json");
    fs.writeFileSync(metaPath, JSON.stringify(session, null, 2), "utf-8");
  }

  private generateSessionId(): string {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString("hex");
    return `sess_${timestamp}_${random}`;
  }

  private estimateTurnTokens(turn: SessionTurn): number {
    const content = turn.content ?? "";
    // CJK characters use ~1.5 tokens each, other characters ~4 chars per token
    const cjkChars = (content.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
    const otherChars = content.length - cjkChars;
    const toolCallTokens = Math.ceil(JSON.stringify(turn.toolCalls ?? {}).length / 4);
    return Math.ceil(cjkChars * 1.5 + otherChars / 4) + toolCallTokens;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      // On Windows, process.kill with 0 just checks existence
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      // ESRCH: 进程不存在；EPERM: 进程存在但无权限（Windows 上对提权进程常见）。
      // 仅 ESRCH 才认为进程已死，EPERM 视为存活，避免误删活跃会话锁。
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EPERM") return true;
      return false;
    }
  }

  /**
   * 异步睡眠，不阻塞事件循环。优先在 async 调用方使用。
   * 注意：acquireLock/withLock 为同步签名，无法 await，仍需使用 sleepSync。
   */
  private sleepAsync(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 同步睡眠，会阻塞 Node.js 主线程。
   * 警告：仅在无法改为 async 的同步调用路径（如 acquireLock）中使用，
   * 高并发下长时间阻塞会冻结整个服务端。新增代码应优先使用 sleepAsync。
   */
  private sleepSync(ms: number): void {
    // Use Atomics.wait for non-busy synchronous sleep (Node.js only)
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
      // Fallback: busy-wait for environments where Atomics.wait is unavailable
      const end = Date.now() + ms;
      while (Date.now() < end) { /* busy-wait */ }
    }
  }
}