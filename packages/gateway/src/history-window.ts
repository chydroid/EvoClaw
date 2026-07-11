/**
 * 历史窗口：按时间或数量限制存储最近的消息。
 *
 * 灵感来自 openclaw-main 的 src/channels/turn/history-window.ts。
 *
 * 职责：
 *  - 维护按时间顺序排列的近期消息列表
 *  - 自动清理超出 maxSize 或 maxAgeMs 的旧消息
 *  - 支持按发送者、按双方对话过滤查询
 *  - 用于 bot-loop-protection 检测 A→B→A→B 重复模式
 *
 * 设计：
 *  - 内部使用数组按时间顺序追加（不强制排序）
 *  - add() 自动清理超出 maxSize 的旧消息（从头部移除）
 *  - prune() 清理超过 maxAgeMs 的旧消息（按 timestamp 字段判断）
 *  - 不持久化，仅在内存中维护
 */

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** 历史窗口中的一条消息记录。 */
export interface HistoryEntry {
  /** 消息 ID（去重用） */
  messageId: string;
  /** 发送者 ID */
  senderId: string;
  /** 接收者 ID */
  recipientId: string;
  /** 消息内容（脱敏后存储） */
  content: string;
  /** 消息时间戳 */
  timestamp: Date;
  /** 渠道类型（可选） */
  channel?: string;
  /** 是否机器人发送 */
  isBot: boolean;
}

/** 历史窗口配置。 */
export interface HistoryWindowOptions {
  /** 最大条数（默认 100） */
  maxSize?: number;
  /** 最大年龄毫秒（默认 1h） */
  maxAgeMs?: number;
}

// ─── 默认值 ───────────────────────────────────────────────────────────────────

const DEFAULT_MAX_SIZE = 100;
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 小时

// ─── 主类 ─────────────────────────────────────────────────────────────────────

/**
 * 历史窗口：按时间或数量限制存储最近的消息。
 *
 * 线程安全性：单进程内同步操作，无需加锁。
 * 时间复杂度：add/prune O(n)（线性扫描过期项）；recent/recentBySender O(n)。
 */
export class HistoryWindow {
  private entries: HistoryEntry[] = [];
  private readonly maxSize: number;
  private readonly maxAgeMs: number;

  constructor(opts?: HistoryWindowOptions) {
    this.maxSize = opts?.maxSize ?? DEFAULT_MAX_SIZE;
    this.maxAgeMs = opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  /**
   * 添加新消息到窗口。
   * 自动清理超出 maxSize 或 maxAgeMs 的旧消息。
   */
  add(entry: HistoryEntry): void {
    this.entries.push(entry);
    // 超过 maxSize 时从头部批量移除最旧的（splice O(n) 优于循环 shift O(n²)）
    if (this.entries.length > this.maxSize) {
      const excess = this.entries.length - this.maxSize;
      this.entries.splice(0, excess);
    }
    // 清理超过 maxAgeMs 的旧消息
    this.prune(entry.timestamp);
  }

  /**
   * 获取最近 N 条消息（按时间倒序：索引 0 = 最新）。
   */
  recent(count: number): HistoryEntry[] {
    if (count <= 0) return [];
    return this.entries.slice(-count).reverse();
  }

  /**
   * 获取指定发送者的最近消息（按时间倒序）。
   */
  recentBySender(senderId: string, count: number): HistoryEntry[] {
    if (count <= 0) return [];
    const filtered = this.entries.filter((e) => e.senderId === senderId);
    return filtered.slice(-count).reverse();
  }

  /**
   * 获取两个发送者之间的最近消息（双向：A→B 或 B→A）。
   * 按时间倒序返回。
   */
  recentBetween(a: string, b: string, count: number): HistoryEntry[] {
    if (count <= 0) return [];
    const filtered = this.entries.filter(
      (e) =>
        (e.senderId === a && e.recipientId === b) ||
        (e.senderId === b && e.recipientId === a),
    );
    return filtered.slice(-count).reverse();
  }

  /**
   * 清理过期消息（timestamp 早于 now - maxAgeMs）。
   * 返回被清理的条数。
   */
  prune(now: Date = new Date()): number {
    const cutoffMs = now.getTime() - this.maxAgeMs;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.timestamp.getTime() >= cutoffMs);
    return before - this.entries.length;
  }

  /**
   * 当前窗口大小。
   */
  size(): number {
    return this.entries.length;
  }

  /**
   * 清空窗口。
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * 返回所有条目的快照（按时间正序：索引 0 = 最旧）。
   * 主要用于测试与调试。
   */
  snapshot(): HistoryEntry[] {
    return [...this.entries];
  }
}
