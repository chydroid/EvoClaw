/**
 * 会话窗口化 + 长期记忆归档（Session Window & Archive）
 *
 * 背景：「不限时长的任务」真正的天花板不是超时，而是 LLM 的最大上下文长度。
 * 历史全量塞进 prompt 迟早会撑爆 context window（ContextEngine 只能
 * 按 token 预算**静默丢弃**更早的历史，丢弃即永久丢失）。
 *
 * 方案（用户建议）：活动会话只保留最近 N 轮（默认 10 轮），更早的轮次
 * 归档到长期记忆，需要时按 sessionId + 语义检索再读回。这样：
 *   - 活动上下文恒定，不会随任务时长线性膨胀；
 *   - 旧内容不丢失，长期记忆成为可检索的「历史层」；
 *   - 跨天/跨重启的长任务可以只带最近 10 轮继续跑，需要时再回忆。
 *
 * 关键设计：用一个持久化的「已归档游标」避免重复归档。
 * transcript 是仅追加的，所以游标单调递增；每条历史最多只归档一次。
 */

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync } from "@evoclaw/core";
import type { MemoryEntry, MemorySearchQuery, MemorySearchResult } from "@evoclaw/core";

/** 默认活动窗口轮次（1 轮 = 1 条 user 消息及其后的 assistant/tool 消息） */
export const DEFAULT_WINDOW_ROUNDS = 10;

/** 归档条目的 tag，便于按会话检索 */
export const ARCHIVE_TAG = "session_archive";

/** 单条归档的 TTL：90 天 */
const ARCHIVE_TTL = 90 * 24 * 3600 * 1000;

export interface LongTermLike {
  store(entry: MemoryEntry): Promise<MemoryEntry>;
  search(query: MemorySearchQuery): Promise<MemorySearchResult[]>;
}

export interface WindowResult {
  /** 保留窗口的起始下标；entries[0..keepFrom-1] 进入归档 */
  keepFrom: number;
  /** 本次实际新归档的条数 */
  newlyArchived: number;
  /** 命中的已归档游标（用于诊断） */
  alreadyArchived: number;
}

/**
 * 计算保留窗口的起始下标。
 *
 * 从后往前数 user 消息，第 `rounds` 条 user 消息所在下标即为保留起点；
 * 这样能完整保留最近 N 轮及其中的 tool_calls / tool 结果，不会在轮次中间
 * 切断。若 user 消息不足 rounds 条，则全部保留（keepFrom = 0）。
 */
export function computeKeepFromIndex(roles: readonly string[], rounds: number): number {
  if (rounds <= 0) return 0;
  let userCount = 0;
  for (let i = roles.length - 1; i >= 0; i--) {
    if (roles[i] === "user") {
      userCount++;
      if (userCount === rounds) return i;
    }
  }
  return 0;
}

/** 最小可用的历史条目（避免直接依赖 SessionManager 造成循环依赖） */
export interface ArchiveTurn {
  role: string;
  content: string | null;
  timestamp?: string;
}

export class SessionArchiveStore {
  private readonly markerDir: string;

  constructor(dataDir: string) {
    this.markerDir = path.join(dataDir, "session-archive");
  }

  private markerPath(sessionId: string): string {
    // sessionId 可能含路径分隔符等非法文件名字符：全部替换为 "_"，
    // 再追加原始 id 的短哈希，既杜绝目录穿越，又避免
    // "a.b" 与 "a_b" 这类清洗后碰撞。
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    let hash = 0;
    for (let i = 0; i < sessionId.length; i++) {
      hash = (hash * 31 + sessionId.charCodeAt(i)) | 0;
    }
    const suffix = (hash >>> 0).toString(36);
    return path.join(this.markerDir, `${safe}-${suffix}.json`);
  }

  /** 读取「已归档到第几条」游标；不存在或损坏时返回 0 */
  readArchivedCount(sessionId: string): number {
    try {
      const p = this.markerPath(sessionId);
      if (!fs.existsSync(p)) return 0;
      const raw = fs.readFileSync(p, "utf-8");
      const n = Number(JSON.parse(raw).archivedCount);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch {
      return 0;
    }
  }

  private writeArchivedCount(sessionId: string, count: number): void {
    try {
      fs.mkdirSync(this.markerDir, { recursive: true });
      atomicWriteFileSync(
        this.markerPath(sessionId),
        JSON.stringify({ sessionId, archivedCount: count, updatedAt: new Date().toISOString() }, null, 2)
      );
    } catch (err) {
      process.stderr.write(
        `[SessionArchive] Failed to persist archive cursor: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  /**
   * 把超出活动窗口的历史轮次写入长期记忆，并返回窗口切分结果。
   *
   * 幂等：已归档过的下标不会重复写入。永不抛出——归档失败不应阻断会话加载。
   */
  async archiveOlderTurns(
    sessionId: string,
    turns: readonly ArchiveTurn[],
    longTerm: LongTermLike | undefined,
    rounds: number = DEFAULT_WINDOW_ROUNDS
  ): Promise<WindowResult> {
    try {
      const keepFrom = computeKeepFromIndex(turns.map((t) => t.role), rounds);
      // transcript 若被重写/压缩导致长度变化，用 Math.min 夹住游标，避免越界
      const alreadyArchived = Math.min(this.readArchivedCount(sessionId), keepFrom);

      if (keepFrom <= alreadyArchived || !longTerm) {
        return { keepFrom, newlyArchived: 0, alreadyArchived };
      }

      const pending = turns.slice(alreadyArchived, keepFrom);
      let written = 0;
      for (const turn of pending) {
        const content = (turn.content || "").trim();
        if (!content) continue;
        const entry: MemoryEntry = {
          id: "",
          type: "conversation",
          content: `[${turn.role}] ${content.slice(0, 2000)}`,
          embedding: null,
          metadata: {
            source: "session_window_archive",
            sessionId,
            userId: "default",
            tags: [ARCHIVE_TAG, `role_${turn.role}`],
            importance: 0.3,
            associations: [],
            entities: [],
          },
          ttl: ARCHIVE_TTL,
          createdAt: turn.timestamp ? new Date(turn.timestamp) : new Date(),
          accessedAt: new Date(),
        };
        try {
          await longTerm.store(entry);
          written++;
        } catch (err) {
          // 单条失败不阻断：仍然推进游标会导致内容永久丢失，故此处不推进，
          // 保持"至少写入成功部分"，下次加载会重试未成功的部分。
          process.stderr.write(
            `[SessionArchive] store failed for session "${sessionId}": ${err instanceof Error ? err.message : String(err)}\n`
          );
          break;
        }
      }

      const newCursor = alreadyArchived + written;
      if (newCursor > alreadyArchived) {
        this.writeArchivedCount(sessionId, newCursor);
      }

      return { keepFrom, newlyArchived: written, alreadyArchived };
    } catch (err) {
      process.stderr.write(
        `[SessionArchive] archive failed for session "${sessionId}": ${err instanceof Error ? err.message : String(err)}\n`
      );
      return { keepFrom: 0, newlyArchived: 0, alreadyArchived: 0 };
    }
  }

  /**
   * 按需读回：本会话已归档的历史中，与当前 query 最相关的前 N 条。
   * 用于「需要时再读」——把归档层重新注入 system prompt。
   */
  async recallArchived(
    longTerm: LongTermLike | undefined,
    sessionId: string,
    query: string,
    limit = 5
  ): Promise<MemorySearchResult[]> {
    if (!longTerm || !query) return [];
    try {
      const results = await longTerm.search({ query, tags: [ARCHIVE_TAG], limit });
      // 检索实现对 tags 的支持程度不一，这里再做一次会话级过滤兜底
      return results.filter((r) => {
        const sid = r.entry?.metadata?.sessionId;
        return !sid || sid === sessionId;
      });
    } catch {
      return [];
    }
  }
}
