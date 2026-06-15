// ── Session Undo Manager ──
// Hermes 0.16 引入: /undo 撤回最近N轮
// 在EvoClaw中实现: 允许用户撤销最近N条消息及其agent响应

/** undo 单元 */
export interface UndoUnit {
  id: string;
  sessionId: string;
  /** 涉及的turn IDs (user + assistant) */
  turnIds: string[];
  /** 撤销的内容快照 */
  snapshot: {
    /** undo前的最后状态 */
    lastUserMessage?: string;
    lastAssistantMessage?: string;
    /** 撤销前context window快照 */
    contextSnapshot?: string;
  };
  /** undo 触发时间 */
  createdAt: number;
  /** 撤销理由 */
  reason?: string;
  /** 是否已撤销 */
  reverted: boolean;
  /** 撤销时间 */
  revertedAt?: number;
}

export interface SessionUndoConfig {
  /** 最多保留多少个undo单元 */
  maxUndoPerSession?: number;
  /** 最多撤销多少轮 */
  maxTurnsPerUndo?: number;
  /** undo 快照保留时间(ms) */
  retentionMs?: number;
  /** 撤销回调 - 实际清除/恢复消息 */
  onUndo?: (sessionId: string, turnIds: string[]) => Promise<void> | void;
}

/**
 * SessionUndoManager
 * 核心: 每次用户提交+agent回复后, 记录一个undo单元
 * /undo 命令: 弹出最近N个undo单元, 触发回滚
 */
export class SessionUndoManager {
  private undoStacks = new Map<string, UndoUnit[]>();
  private config: Required<SessionUndoConfig>;
  private counter = 0;
  private stats = {
    pushes: 0,
    undos: 0,
    failed: 0,
    evictions: 0,
  };

  constructor(config: Partial<SessionUndoConfig> = {}) {
    this.config = {
      maxUndoPerSession: config.maxUndoPerSession ?? 10,
      maxTurnsPerUndo: config.maxTurnsPerUndo ?? 5,
      retentionMs: config.retentionMs ?? 24 * 60 * 60 * 1000,
      onUndo: config.onUndo ?? (() => {}),
    };
  }

  /** 记录一个可undo的单元 */
  push(info: {
    sessionId: string;
    turnIds: string[];
    lastUserMessage?: string;
    lastAssistantMessage?: string;
    contextSnapshot?: string;
    reason?: string;
  }): UndoUnit {
    const stack = this.undoStacks.get(info.sessionId) ?? [];
    const unit: UndoUnit = {
      id: `undo-${++this.counter}-${Date.now()}`,
      sessionId: info.sessionId,
      turnIds: info.turnIds.slice(0, this.config.maxTurnsPerUndo),
      snapshot: {
        lastUserMessage: info.lastUserMessage,
        lastAssistantMessage: info.lastAssistantMessage,
        contextSnapshot: info.contextSnapshot,
      },
      createdAt: Date.now(),
      reason: info.reason,
      reverted: false,
    };
    stack.push(unit);
    // 限制大小
    while (stack.length > this.config.maxUndoPerSession) {
      stack.shift();
      this.stats.evictions++;
    }
    this.undoStacks.set(info.sessionId, stack);
    this.stats.pushes++;
    return unit;
  }

  /**
   * 撤销最近N个单元
   * @returns 被撤销的单元列表
   */
  async undo(sessionId: string, count = 1): Promise<UndoUnit[]> {
    const stack = this.undoStacks.get(sessionId) ?? [];
    if (stack.length === 0) return [];
    const toRevert = stack.splice(-count);
    const reverted: UndoUnit[] = [];
    const allTurnIds: string[] = [];
    for (const unit of toRevert) {
      unit.reverted = true;
      unit.revertedAt = Date.now();
      reverted.push(unit);
      allTurnIds.push(...unit.turnIds);
    }
    try {
      await this.config.onUndo(sessionId, allTurnIds);
      this.stats.undos++;
    } catch (err) {
      this.stats.failed++;
      throw err;
    }
    return reverted;
  }

  /** 获取session的undo历史 */
  getHistory(sessionId: string, includeReverted = false): UndoUnit[] {
    const stack = this.undoStacks.get(sessionId) ?? [];
    return includeReverted ? stack : stack.filter((u) => !u.reverted);
  }

  /** 清理过期unit */
  cleanup(): void {
    const cutoff = Date.now() - this.config.retentionMs;
    for (const [sessionId, stack] of this.undoStacks.entries()) {
      const filtered = stack.filter((u) => u.createdAt > cutoff);
      if (filtered.length !== stack.length) {
        this.stats.evictions += stack.length - filtered.length;
        this.undoStacks.set(sessionId, filtered);
      }
    }
  }

  /** 统计 */
  getStats() {
    return {
      ...this.stats,
      sessionCount: this.undoStacks.size,
      totalUnits: Array.from(this.undoStacks.values()).reduce((s, st) => s + st.length, 0),
    };
  }
}
