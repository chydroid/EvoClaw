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
    fs.writeFileSync(transcriptPath, "", "utf-8");

    // Cache
    this.sessionCache.set(sessionId, session);

    console.log(`[SessionManager] Created session ${sessionId} for agent "${agentId}"`);
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
    } catch {
      return null;
    }
  }

  /** Update session metadata */
  updateSessionMeta(session: SessionInfo): void {
    session.updatedAt = new Date().toISOString();
    this.writeSessionMeta(session);
    this.sessionCache.set(session.sessionId, session);
  }

  /** Archive a session */
  archiveSession(agentId: string, sessionId: string, reason: string): void {
    const session = this.loadSessionMeta(agentId, sessionId);
    if (!session) return;

    session.status = "archived";
    this.updateSessionMeta(session);
    console.log(`[SessionManager] Archived session ${sessionId}: ${reason}`);
  }

  /** Delete a session completely */
  deleteSession(agentId: string, sessionId: string): boolean {
    try {
      const sessionDir = path.join(this.getAgentDir(agentId), sessionId);
      if (!fs.existsSync(sessionDir)) {
        console.warn(`[SessionManager] Session ${sessionId} not found for deletion`);
        return false;
      }

      // Remove lock if exists
      const lockPath = path.join(this.getLockDir(), `${sessionId}.lock`);
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }

      // Remove session directory recursively
      this.rmdirRecursive(sessionDir);

      // Remove from cache
      this.sessionCache.delete(sessionId);
      this.activeLocks.delete(sessionId);

      console.log(`[SessionManager] Deleted session ${sessionId} for agent "${agentId}"`);
      return true;
    } catch (err) {
      console.error(`[SessionManager] Failed to delete session ${sessionId}:`, err);
      return false;
    }
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

  /** Append a turn to the transcript */
  appendTurn(agentId: string, sessionId: string, turn: SessionTurn): void {
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
  }

  /** Load full session (metadata + turns) */
  loadSession(agentId: string, sessionId: string): SessionLoadResult | null {
    const session = this.loadSessionMeta(agentId, sessionId);
    if (!session) return null;

    const turns = this.loadTranscript(agentId, sessionId);

    return {
      session,
      turns,
      predecessorId: session.predecessorSessionId,
      successorId: session.successorSessionId,
    };
  }

  /** Rewrite the entire transcript (used by compaction) */
  rewriteTranscript(agentId: string, sessionId: string, turns: SessionTurn[]): void {
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
        // Write lock file with PID if it doesn't exist
        if (!fs.existsSync(lockPath)) {
          fs.writeFileSync(lockPath, String(pid), { flag: "wx" });
          const lock: SessionLock = {
            sessionId,
            lockPath,
            acquiredAt: Date.now(),
            processId: pid,
            reentrant: false,
          };
          this.activeLocks.set(sessionId, lock);
          return lock;
        }

        // Check for stale lock (process no longer exists)
        try {
          const lockPid = parseInt(fs.readFileSync(lockPath, "utf-8"), 10);
          if (!this.isProcessAlive(lockPid)) {
            // Stale lock — remove and retry
            fs.unlinkSync(lockPath);
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
          console.error(`[SessionManager] Lock error for ${sessionId}:`, err);
        }
      }
    }

    console.warn(`[SessionManager] Failed to acquire lock for ${sessionId} after ${timeoutMs}ms`);
    return null;
  }

  /** Release a write lock */
  releaseLock(lock: SessionLock): void {
    this.activeLocks.delete(lock.sessionId);
    try {
      if (fs.existsSync(lock.lockPath)) {
        fs.unlinkSync(lock.lockPath);
      }
    } catch (err) {
      console.error(`[SessionManager] Failed to release lock for ${lock.sessionId}:`, err);
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
      return parseInt(fs.readFileSync(lockPath, "utf-8"), 10);
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

    console.log(`[SessionManager] Compaction chain: ${parentSessionId} -> ${successorSessionId}`);
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

    // Remove all whitespace
    const cleanContent = content.replace(/\s+/g, "");
    
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
    // Simple heuristic: ~4 chars per token
    let charCount = (turn.content?.length ?? 0) + JSON.stringify(turn.toolCalls ?? {}).length;
    return Math.ceil(charCount / 4);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      // On Windows, process.kill with 0 just checks existence
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private sleepSync(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Busy-wait for short sync delays (acceptable for lock contention)
    }
  }
}