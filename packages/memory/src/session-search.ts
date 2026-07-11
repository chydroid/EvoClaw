/**
 * SessionSearch — 会话搜索三模式（DISCOVERY / SCROLL / BROWSE）。
 *
 * 借鉴 hermes-agent 的会话搜索设计：
 *   - DISCOVERY：基于 FTS5 全文搜索定位会话，合并 lineage（parent 链），
 *               附加 ±5 消息窗口与首尾 bookend 上下文。
 *   - SCROLL：以指定 messageId 为锚点，返回该会话内的消息窗口。
 *   - BROWSE：按时间倒序列出最近会话，跳过隐藏来源（subagent/tool），
 *            将 cron/scheduler 来源的会话稳定排序压后。
 *
 * 为避免与 @evoclaw/agent 的循环依赖（agent → memory），SessionSearch 通过
 * SessionInfoProvider 接口获取会话元数据与 transcript，而非直接依赖 SessionManager。
 * 若 SessionManager 的数据结构不支持 parentSessionId 或 message window，
 * 调用方可传入 null provider，SessionSearch 将退化为纯 FTS5 搜索 + 源过滤。
 */

import { FTS5SearchEngine, type FTS5SearchResult } from "./fts5-search";

/** 单条搜索结果。 */
export interface SessionSearchResult {
  sessionId: string;
  parentSessionId?: string;
  /** 相关性分数，越高越相关（由 FTS5 bm25 rank 取反得到） */
  score: number;
  snippet: string;
  /** DISCOVERY/SCROLL 模式下的 ±N 消息窗口 */
  messageWindow?: Array<{ role: string; content: string; messageId: string }>;
  /** 会话起始 bookend（前几条消息） */
  bookendStart?: Array<{ role: string; content: string }>;
  /** 会话结尾 bookend（后几条消息） */
  bookendEnd?: Array<{ role: string; content: string }>;
  timestamp: string;
  /** 会话来源（cron/scheduler/subagent/tool 等），用于过滤和排序 */
  source?: string;
}

/**
 * 会话信息提供者接口。由调用方实现（可直接包装 SessionManager）。
 * 所有方法可选；缺失时 SessionSearch 退化为纯 FTS5 搜索。
 */
export interface SessionInfoProvider {
  /** 获取会话元数据。返回 null 表示会话不存在。 */
  getSessionInfo?(sessionId: string): SessionInfoLike | null;
  /** 加载会话 transcript（消息列表）。 */
  loadTranscript?(sessionId: string): SessionTurnLike[];
  /** 列出所有会话（BROWSE 模式使用）。 */
  listSessions?(): SessionInfoLike[];
}

/** 会话元数据（SessionInfo 的精简版，避免循环依赖）。 */
export interface SessionInfoLike {
  sessionId: string;
  /** 父会话 ID（对应 SessionInfo.predecessorSessionId） */
  parentSessionId?: string;
  /** 旧字段名，与 parentSessionId 等价 */
  predecessorSessionId?: string;
  createdAt: string;
  updatedAt?: string;
  /** 会话来源，用于过滤（cron/scheduler/subagent/tool/...） */
  source?: string;
  status?: string;
}

/** 会话消息（SessionTurn 的精简版）。 */
export interface SessionTurnLike {
  role: string;
  content: string | null;
  timestamp: string;
  turnIndex?: number;
  metadata?: Record<string, unknown>;
}

/** DISCOVERY 默认消息窗口半径 */
const DEFAULT_DISCOVERY_WINDOW = 5;
/** bookend 默认条数 */
const DEFAULT_BOOKEND_SIZE = 2;

export class SessionSearch {
  /** 稳定排序时压后的来源（cron/scheduler 触发的会话） */
  static readonly _DEMOTED_SESSION_SOURCES = ["cron", "scheduler"];
  /** 默认排除的来源（subagent/tool 内部会话） */
  static readonly _HIDDEN_SESSION_SOURCES = ["subagent", "tool"];

  private fts: FTS5SearchEngine;
  private provider: SessionInfoProvider | null;

  constructor(fts: FTS5SearchEngine, provider?: SessionInfoProvider | null) {
    this.fts = fts;
    this.provider = provider ?? null;
  }

  /**
   * DISCOVERY 模式：FTS5 搜索 + lineage 合并 + ±5 消息窗口 + bookend。
   *
   * 步骤：
   *  1. FTS5 全文搜索，取前 limit 条
   *  2. 每条结果解析为 parent session（走 parentSessionId 链到根）
   *  3. 同一 parent session 的多条命中合并，保留最高分
   *  4. 过滤掉 _HIDDEN_SESSION_SOURCES 来源的会话
   *  5. 将 _DEMOTED_SESSION_SOURCES 来源的会话稳定排序压后
   *  6. 若 provider 可用，为每条结果附加 ±5 消息窗口和首尾 bookend
   */
  async discover(query: string, limit?: number): Promise<SessionSearchResult[]> {
    const maxResults = limit ?? 10;
    const raw = this.fts.search({ query, limit: maxResults * 3 });

    // 按解析后的 parent session 分组，保留最高分
    const byParent = new Map<string, { fts: FTS5SearchResult; parent: string }>();
    for (const hit of raw) {
      const sessionId = hit.metadata.sessionId as string | undefined;
      if (!sessionId) continue;
      const parent = this._resolveToParent(sessionId);
      const existing = byParent.get(parent);
      if (!existing || hit.rank < existing.fts.rank) {
        byParent.set(parent, { fts: hit, parent });
      }
    }

    const results: SessionSearchResult[] = [];
    for (const { fts: hit, parent } of byParent.values()) {
      const info = this.getSessionInfo(parent);
      // 过滤隐藏来源
      if (info?.source && SessionSearch._HIDDEN_SESSION_SOURCES.includes(info.source)) {
        continue;
      }

      const result: SessionSearchResult = {
        sessionId: parent,
        parentSessionId: info?.parentSessionId ?? info?.predecessorSessionId,
        // bm25 rank 越低越相关，取反使越高越相关
        score: -hit.rank,
        snippet: hit.snippet,
        timestamp: (hit.metadata.createdAt as string) ?? info?.createdAt ?? new Date(0).toISOString(),
        source: info?.source,
      };

      // 附加消息窗口和 bookend（若 provider 可用）
      this.enrichWithWindow(result, hit, DEFAULT_DISCOVERY_WINDOW);

      results.push(result);
    }

    // 稳定排序：先按分数降序，再将 demoted 来源压后
    results.sort((a, b) => {
      const aDemoted = a.source != null && SessionSearch._DEMOTED_SESSION_SOURCES.includes(a.source);
      const bDemoted = b.source != null && SessionSearch._DEMOTED_SESSION_SOURCES.includes(b.source);
      if (aDemoted !== bDemoted) return aDemoted ? 1 : -1;
      return b.score - a.score;
    });

    return results.slice(0, maxResults);
  }

  /**
   * SCROLL 模式：以指定 messageId 为锚点，返回该会话内的消息窗口。
   *
   * @param sessionId 目标会话 ID
   * @param aroundMessageId 锚点消息 ID（对应 FTS5 索引的 entry id 或 transcript 中的消息）
   * @param window 锚点前后的消息数（总返回 2*window+1 条）
   */
  async scroll(
    sessionId: string,
    aroundMessageId: string,
    window: number,
  ): Promise<SessionSearchResult> {
    const info = this.getSessionInfo(sessionId);
    const transcript = this.loadTranscript(sessionId);

    const anchorIdx = this.findIndexInTranscript(transcript, aroundMessageId);
    const half = Math.max(0, window);
    const start = Math.max(0, anchorIdx - half);
    const end = Math.min(transcript.length, anchorIdx + half + 1);
    const windowTurns = transcript.slice(start, end);

    const messageWindow = windowTurns.map((t, i) => ({
      role: t.role,
      content: t.content ?? "",
      messageId: this.deriveMessageId(t, start + i),
    }));

    return {
      sessionId,
      parentSessionId: info?.parentSessionId ?? info?.predecessorSessionId,
      score: 0,
      snippet: anchorIdx >= 0 ? (transcript[anchorIdx].content ?? "") : "",
      messageWindow,
      timestamp: info?.createdAt ?? new Date(0).toISOString(),
      source: info?.source,
    };
  }

  /**
   * BROWSE 模式：按时间倒序列出最近会话。
   * 跳过 _HIDDEN_SESSION_SOURCES 来源，将 _DEMOTED_SESSION_SOURCES 压后。
   */
  async browse(limit?: number): Promise<SessionSearchResult[]> {
    if (!this.provider?.listSessions) return [];
    const maxResults = limit ?? 20;
    const sessions = this.provider.listSessions();

    const results: SessionSearchResult[] = sessions
      .filter((s) => {
        // 过滤隐藏来源
        if (s.source && SessionSearch._HIDDEN_SESSION_SOURCES.includes(s.source)) return false;
        return true;
      })
      .map((s) => ({
        sessionId: s.sessionId,
        parentSessionId: s.parentSessionId ?? s.predecessorSessionId,
        score: 0,
        snippet: "",
        timestamp: s.createdAt,
        source: s.source,
      }));

    // 稳定排序：时间倒序，demoted 压后
    results.sort((a, b) => {
      const aDemoted = a.source != null && SessionSearch._DEMOTED_SESSION_SOURCES.includes(a.source);
      const bDemoted = b.source != null && SessionSearch._DEMOTED_SESSION_SOURCES.includes(b.source);
      if (aDemoted !== bDemoted) return aDemoted ? 1 : -1;
      // 时间倒序：新的在前
      return b.timestamp.localeCompare(a.timestamp);
    });

    return results.slice(0, maxResults);
  }

  /**
   * 走 parentSessionId 链到根，返回根会话 ID。
   * 若 provider 不可用或链中存在环，返回原始 sessionId。
   */
  _resolveToParent(sessionId: string): string {
    if (!this.provider?.getSessionInfo) return sessionId;
    const visited = new Set<string>();
    let current = sessionId;
    let guard = 0;
    while (guard++ < 32) {
      if (visited.has(current)) break; // 环检测
      visited.add(current);
      const info = this.provider.getSessionInfo(current);
      if (!info) break;
      const parent = info.parentSessionId ?? info.predecessorSessionId;
      if (!parent) break;
      current = parent;
    }
    return current;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private getSessionInfo(sessionId: string): SessionInfoLike | null {
    if (!this.provider?.getSessionInfo) return null;
    return this.provider.getSessionInfo(sessionId);
  }

  private loadTranscript(sessionId: string): SessionTurnLike[] {
    if (!this.provider?.loadTranscript) return [];
    return this.provider.loadTranscript(sessionId);
  }

  /**
   * 为 discover 结果附加 ±window 消息窗口和首尾 bookend。
   */
  private enrichWithWindow(
    result: SessionSearchResult,
    hit: FTS5SearchResult,
    window: number,
  ): void {
    const sessionId = hit.metadata.sessionId as string | undefined;
    if (!sessionId) return;
    const transcript = this.loadTranscript(sessionId);
    if (transcript.length === 0) return;

    const messageId = hit.metadata.id as string | undefined;
    const anchorIdx = this.findIndexInTranscript(transcript, messageId ?? "");
    if (anchorIdx < 0) return;

    const half = Math.max(0, window);
    const start = Math.max(0, anchorIdx - half);
    const end = Math.min(transcript.length, anchorIdx + half + 1);

    result.messageWindow = transcript.slice(start, end).map((t, i) => ({
      role: t.role,
      content: t.content ?? "",
      messageId: this.deriveMessageId(t, start + i),
    }));

    // bookend：会话首尾各 DEFAULT_BOOKEND_SIZE 条
    const bookendSize = Math.min(DEFAULT_BOOKEND_SIZE, transcript.length);
    if (bookendSize > 0) {
      result.bookendStart = transcript.slice(0, bookendSize).map((t) => ({
        role: t.role,
        content: t.content ?? "",
      }));
      result.bookendEnd = transcript
        .slice(transcript.length - bookendSize)
        .map((t) => ({
          role: t.role,
          content: t.content ?? "",
        }));
    }
  }

  /**
   * 在 transcript 中查找匹配 messageId 的消息索引。
   * 查找顺序：
   *  1. turn.metadata.id / turn.metadata.messageId
   *  2. turn 内容完全匹配（FTS5 content === turn.content）
   *  3. turnIndex 数字匹配
   *  4. 回退到 0（取第一条）
   */
  private findIndexInTranscript(transcript: SessionTurnLike[], messageId: string): number {
    if (transcript.length === 0) return -1;
    if (!messageId) return 0;

    // 1. metadata.id / metadata.messageId
    for (let i = 0; i < transcript.length; i++) {
      const meta = transcript[i].metadata;
      if (!meta) continue;
      const id = meta.id ?? meta.messageId;
      if (typeof id === "string" && id === messageId) return i;
    }

    // 2. 内容完全匹配
    for (let i = 0; i < transcript.length; i++) {
      if (transcript[i].content === messageId) return i;
    }

    // 3. turnIndex 数字匹配
    const idx = Number(messageId);
    if (Number.isInteger(idx) && idx >= 0 && idx < transcript.length) {
      return idx;
    }

    // 4. 回退
    return 0;
  }

  /**
   * 推导消息 ID。优先用 metadata.id/messageId，否则用 turnIndex。
   */
  private deriveMessageId(turn: SessionTurnLike, fallbackIndex: number): string {
    const meta = turn.metadata;
    if (meta) {
      const id = meta.id ?? meta.messageId;
      if (typeof id === "string") return id;
    }
    if (typeof turn.turnIndex === "number") return String(turn.turnIndex);
    return String(fallbackIndex);
  }
}
