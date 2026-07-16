/**
 * ACP 事件账本 — 会话事件持久化与重放。
 *
 * 对标 OpenClaw src/acp/event-ledger.ts。
 *
 * 用途：ACP `session/load` 请求需要重放历史会话更新事件，
 * 让 IDE 恢复会话上下文。本模块提供事件存储与查询接口。
 *
 * 实现：内存版本（后续可扩展为 SQLite 持久化，对标 OpenClaw 的
 * migrateFileAcpEventLedgerToSqlite）。
 */

import type { AcpSessionUpdate } from "./acp-protocol.js";

// ─── 类型 ──────────────────────────────────────────────────────────────

/** 事件账本条目 */
export interface AcpEventLedgerEntry {
  /** 序列号（单会话内递增） */
  seq: number;
  /** 时间戳 */
  at: string;
  /** ACP 会话 ID */
  sessionId: string;
  /** 会话 key（Gateway 侧映射） */
  sessionKey?: string;
  /** 运行 ID（一次 prompt 请求的唯一标识） */
  runId?: string;
  /** 会话更新事件 */
  update: AcpSessionUpdate;
}

/** 重放结果 */
export interface AcpEventLedgerReplay {
  /** 是否完整（true=所有事件都已重放，false=有截断） */
  complete: boolean;
  /** ACP 会话 ID */
  sessionId?: string;
  /** 会话 key */
  sessionKey?: string;
  /** 重放的事件列表 */
  events: AcpEventLedgerEntry[];
}

// ─── 常量 ──────────────────────────────────────────────────────────────

/** 账本版本 */
export const LEDGER_VERSION = 1;

/** 默认最大会话数 */
export const DEFAULT_MAX_SESSIONS = 200;

/** 默认每会话最大事件数 */
export const DEFAULT_MAX_EVENTS_PER_SESSION = 5000;

// ─── AcpEventLedger 接口 ──────────────────────────────────────────────

/**
 * 事件账本接口。
 *
 * 对标 OpenClaw AcpEventLedger 接口。
 * 后续可提供 SQLite 实现替换内存实现。
 */
export interface AcpEventLedger {
  /** 开启会话（分配 sessionId） */
  startSession(sessionKey?: string): string;

  /** 记录用户 prompt */
  recordUserPrompt(sessionId: string, text: string, runId?: string): void;

  /** 记录会话更新 */
  recordUpdate(sessionId: string, update: AcpSessionUpdate, runId?: string): void;

  /** 标记会话为不完整（如 Gateway 断连） */
  markIncomplete(sessionId: string): void;

  /** 按 sessionId 读取重放 */
  readReplay(sessionId: string, limit?: number): AcpEventLedgerReplay;

  /** 按 sessionKey 读取重放 */
  readReplayBySessionKey(sessionKey: string, limit?: number): AcpEventLedgerReplay;

  /** 关闭账本，释放资源 */
  close(): Promise<void>;
}

// ─── InMemoryAcpEventLedger ───────────────────────────────────────────

/**
 * 内存事件账本实现。
 *
 * 对标 OpenClaw 的 FileAcpEventLedger（后续可迁移到 SQLite）。
 * 限制：
 *   - 超过 maxSessions 时 LRU 淘汰最旧会话
 *   - 每会话超过 maxEventsPerSession 时丢弃最旧事件
 */
export class InMemoryAcpEventLedger implements AcpEventLedger {
  private sessions = new Map<string, {
    sessionKey?: string;
    seq: number;
    events: AcpEventLedgerEntry[];
    incomplete: boolean;
  }>();

  private readonly maxSessions: number;
  private readonly maxEventsPerSession: number;

  constructor(opts?: { maxSessions?: number; maxEventsPerSession?: number }) {
    this.maxSessions = opts?.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxEventsPerSession = opts?.maxEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION;
  }

  startSession(sessionKey?: string): string {
    // LRU 淘汰
    if (this.sessions.size >= this.maxSessions) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey) this.sessions.delete(oldestKey);
    }

    const sessionId = `ledger-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.sessions.set(sessionId, {
      sessionKey,
      seq: 0,
      events: [],
      incomplete: false,
    });
    return sessionId;
  }

  recordUserPrompt(sessionId: string, text: string, runId?: string): void {
    this.recordUpdate(sessionId, {
      tag: "user_prompt",
      text,
    }, runId);
  }

  recordUpdate(sessionId: string, update: AcpSessionUpdate, runId?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.seq += 1;
    const entry: AcpEventLedgerEntry = {
      seq: session.seq,
      at: new Date().toISOString(),
      sessionId,
      ...(session.sessionKey !== undefined ? { sessionKey: session.sessionKey } : {}),
      ...(runId !== undefined ? { runId } : {}),
      update,
    };

    session.events.push(entry);

    // 超限时丢弃最旧
    if (session.events.length > this.maxEventsPerSession) {
      session.events.shift();
    }
  }

  markIncomplete(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.incomplete = true;
  }

  readReplay(sessionId: string, limit?: number): AcpEventLedgerReplay {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { complete: true, events: [] };
    }

    const maxLimit = limit ?? DEFAULT_MAX_EVENTS_PER_SESSION;
    const events = session.events.slice(-maxLimit);
    return {
      complete: !session.incomplete && events.length === session.events.length,
      sessionId,
      ...(session.sessionKey !== undefined ? { sessionKey: session.sessionKey } : {}),
      events,
    };
  }

  readReplayBySessionKey(sessionKey: string, limit?: number): AcpEventLedgerReplay {
    for (const [sessionId, session] of this.sessions) {
      if (session.sessionKey === sessionKey) {
        return this.readReplay(sessionId, limit);
      }
    }
    return { complete: true, events: [] };
  }

  async close(): Promise<void> {
    this.sessions.clear();
  }

  // ─── 测试辅助 ────────────────────────────────────────────────────────

  /** 获取会话数（测试用） */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** 获取会话事件数（测试用） */
  getEventCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.events.length ?? 0;
  }
}
