/**
 * 消息回合护栏：限制单回合消息数量与回合速率。
 *
 * 灵感来自 openclaw-main 的 src/channels/turn/message-turn-guardrails.ts。
 *
 * 检测维度：
 *  1. 单回合消息数超过阈值（maxMessagesPerTurn）
 *  2. 回合速率超过阈值（每分钟 N 个回合，maxTurnsPerMinute）
 *  3. 长时间持续回合（无中断的对话，maxTurnDurationMs）
 *  4. 异常长的单条消息（疑似输出失控，maxMessageLength）
 *
 * 触发动作（按规则独立返回）：
 *  - allow：通过
 *  - warn：达到阈值比例 warnThresholdRatio 时警告
 *  - throttle：达到上限建议节流
 *  - block：超过上限强制阻断
 *
 * 使用方式：
 *  - 回合开始时调用 startTurn(turnId, participantIds)
 *  - 每条消息调用 evaluate(msg) 返回 GuardrailResult[]（可能为空数组）
 *  - 回合结束调用 endTurn(turnId)
 */

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** 护栏动作。 */
export type GuardrailAction = "allow" | "warn" | "throttle" | "block";

/** 单条护栏触发结果。 */
export interface GuardrailResult {
  /** 触发的动作 */
  action: GuardrailAction;
  /** 触发的规则名 */
  rule: string;
  /** 原因说明 */
  reason: string;
  /** 当前实际值 */
  current: number;
  /** 配置阈值 */
  threshold: number;
}

/** 护栏配置。 */
export interface TurnGuardrailsConfig {
  /** 单回合最大消息数（默认 20） */
  maxMessagesPerTurn: number;
  /** 每分钟最大回合数（默认 10） */
  maxTurnsPerMinute: number;
  /** 单回合最长持续时间毫秒（默认 5 分钟） */
  maxTurnDurationMs: number;
  /** 单条消息最大长度（默认 4000 字符） */
  maxMessageLength: number;
  /** 警告阈值比例（默认 0.8，达到 80% 时 warn） */
  warnThresholdRatio: number;
}

/** 默认配置。 */
export const DEFAULT_TURN_GUARDRAILS_CONFIG: TurnGuardrailsConfig = {
  maxMessagesPerTurn: 20,
  maxTurnsPerMinute: 10,
  maxTurnDurationMs: 5 * 60 * 1000,
  maxMessageLength: 4000,
  warnThresholdRatio: 0.8,
};

/** 回合上下文（运行时跟踪状态）。 */
export interface TurnContext {
  /** 回合 ID */
  turnId: string;
  /** 回合开始时间 */
  startedAt: Date;
  /** 最后一条消息时间 */
  lastMessageAt: Date;
  /** 消息计数 */
  messageCount: number;
  /** 累计字符数 */
  totalChars: number;
  /** 参与者 ID 列表 */
  participantIds: string[];
  /** 是否已结束 */
  ended: boolean;
}

/** evaluate 输入。 */
export interface GuardrailMessage {
  /** 回合 ID */
  turnId: string;
  /** 发送者 ID */
  senderId: string;
  /** 消息内容 */
  content: string;
  /** 时间戳（默认 now） */
  timestamp?: Date;
}

// ─── 主类 ─────────────────────────────────────────────────────────────────────

/**
 * MessageTurnGuardrails：单回合消息与回合速率护栏。
 *
 * 线程安全性：单进程同步操作。
 * 内存增长控制：turns map 需调用 prune() 或 endTurn() 清理。
 */
export class MessageTurnGuardrails {
  private readonly config: TurnGuardrailsConfig;
  private readonly turns = new Map<string, TurnContext>();
  /** 每个 senderId 对应的回合开始时间戳列表（用于速率限制） */
  private readonly turnEvents = new Map<string, Date[]>();

  constructor(config?: Partial<TurnGuardrailsConfig>) {
    this.config = { ...DEFAULT_TURN_GUARDRAILS_CONFIG, ...config };
  }

  /**
   * 评估单条消息是否触发护栏。
   * 返回所有触发的护栏列表（按检查顺序，可能为空数组）。
   */
  evaluate(msg: GuardrailMessage): GuardrailResult[] {
    const now = msg.timestamp ?? new Date();
    const ctx = this.getOrCreateTurn(msg.turnId, [msg.senderId], now);
    if (ctx.ended) {
      // 已结束的回合仍允许评估，但产生一条 warn 提醒
      return [
        {
          action: "warn",
          rule: "turn-ended",
          reason: `turn ${msg.turnId} already ended, message received after endTurn`,
          current: ctx.messageCount,
          threshold: 0,
        },
      ];
    }

    const results: GuardrailResult[] = [];

    // 1. 检查消息长度
    const length = msg.content.length;
    if (length > this.config.maxMessageLength) {
      results.push({
        action: "block",
        rule: "max-message-length",
        reason: `message length ${length} exceeds max ${this.config.maxMessageLength}`,
        current: length,
        threshold: this.config.maxMessageLength,
      });
    } else if (
      length >=
      Math.floor(this.config.maxMessageLength * this.config.warnThresholdRatio)
    ) {
      results.push({
        action: "warn",
        rule: "max-message-length",
        reason: `message length ${length} approaches max ${this.config.maxMessageLength}`,
        current: length,
        threshold: this.config.maxMessageLength,
      });
    }

    // 2. 更新回合上下文（消息计数 + 字符数 + 最后消息时间）
    ctx.messageCount += 1;
    ctx.lastMessageAt = now;
    ctx.totalChars += length;
    if (!ctx.participantIds.includes(msg.senderId)) {
      ctx.participantIds.push(msg.senderId);
    }

    // 3. 检查单回合消息数
    const count = ctx.messageCount;
    if (count > this.config.maxMessagesPerTurn) {
      results.push({
        action: "block",
        rule: "max-messages-per-turn",
        reason: `turn ${msg.turnId} message count ${count} exceeds max ${this.config.maxMessagesPerTurn}`,
        current: count,
        threshold: this.config.maxMessagesPerTurn,
      });
    } else if (
      count >=
      Math.floor(this.config.maxMessagesPerTurn * this.config.warnThresholdRatio)
    ) {
      results.push({
        action: "warn",
        rule: "max-messages-per-turn",
        reason: `turn ${msg.turnId} message count ${count} approaches max ${this.config.maxMessagesPerTurn}`,
        current: count,
        threshold: this.config.maxMessagesPerTurn,
      });
    }

    // 4. 检查回合持续时间
    const durationMs = now.getTime() - ctx.startedAt.getTime();
    if (durationMs > this.config.maxTurnDurationMs) {
      results.push({
        action: "block",
        rule: "max-turn-duration",
        reason: `turn ${msg.turnId} duration ${durationMs}ms exceeds max ${this.config.maxTurnDurationMs}ms`,
        current: durationMs,
        threshold: this.config.maxTurnDurationMs,
      });
    } else if (
      durationMs >=
      Math.floor(this.config.maxTurnDurationMs * this.config.warnThresholdRatio)
    ) {
      results.push({
        action: "warn",
        rule: "max-turn-duration",
        reason: `turn ${msg.turnId} duration ${durationMs}ms approaches max ${this.config.maxTurnDurationMs}ms`,
        current: durationMs,
        threshold: this.config.maxTurnDurationMs,
      });
    }

    // 5. 检查回合速率（针对 senderId，1 分钟窗口）
    const turnsLastMin = this.countTurnsInWindow(msg.senderId, now, 60_000);
    if (turnsLastMin > this.config.maxTurnsPerMinute) {
      results.push({
        action: "block",
        rule: "max-turns-per-minute",
        reason: `sender ${msg.senderId} started ${turnsLastMin} turns in last 60s, exceeds max ${this.config.maxTurnsPerMinute}`,
        current: turnsLastMin,
        threshold: this.config.maxTurnsPerMinute,
      });
    } else if (
      turnsLastMin >=
      Math.floor(this.config.maxTurnsPerMinute * this.config.warnThresholdRatio)
    ) {
      results.push({
        action: "warn",
        rule: "max-turns-per-minute",
        reason: `sender ${msg.senderId} turn rate ${turnsLastMin}/min approaches max ${this.config.maxTurnsPerMinute}`,
        current: turnsLastMin,
        threshold: this.config.maxTurnsPerMinute,
      });
    }

    return results;
  }

  /**
   * 开始新回合。返回新建或已存在的 TurnContext。
   * 若已存在则覆盖参与者列表。
   */
  startTurn(turnId: string, participantIds: string[], startedAt?: Date): TurnContext {
    const now = startedAt ?? new Date();
    const existing = this.turns.get(turnId);
    if (existing && !existing.ended) {
      // 已存在未结束回合：刷新参与者
      for (const p of participantIds) {
        if (!existing.participantIds.includes(p)) {
          existing.participantIds.push(p);
        }
      }
      return existing;
    }
    const ctx: TurnContext = {
      turnId,
      startedAt: now,
      lastMessageAt: now,
      messageCount: 0,
      totalChars: 0,
      participantIds: [...participantIds],
      ended: false,
    };
    this.turns.set(turnId, ctx);
    // 记录到各参与者的 turn 事件
    for (const p of participantIds) {
      const list = this.turnEvents.get(p) ?? [];
      list.push(now);
      this.turnEvents.set(p, list);
    }
    return ctx;
  }

  /**
   * 结束回合。标记 ended=true 但保留上下文供查询。
   */
  endTurn(turnId: string, _endedAt?: Date): void {
    const ctx = this.turns.get(turnId);
    if (!ctx) return;
    ctx.ended = true;
  }

  /**
   * 获取回合上下文。
   */
  getTurn(turnId: string): TurnContext | undefined {
    return this.turns.get(turnId);
  }

  /**
   * 清理过期回合数据（startedAt 早于 olderThanMs）。
   * 同时清理 turnEvents 中过期项。返回清理回合数。
   */
  prune(olderThanMs: number, now: Date = new Date()): number {
    const cutoff = now.getTime() - olderThanMs;
    let removed = 0;
    for (const [id, ctx] of this.turns.entries()) {
      if (ctx.startedAt.getTime() < cutoff) {
        this.turns.delete(id);
        removed++;
      }
    }
    // 清理 turnEvents 中过期项
    for (const [senderId, list] of this.turnEvents.entries()) {
      const filtered = list.filter((d) => d.getTime() >= cutoff);
      if (filtered.length === 0) {
        this.turnEvents.delete(senderId);
      } else if (filtered.length !== list.length) {
        this.turnEvents.set(senderId, filtered);
      }
    }
    return removed;
  }

  /** 获取配置（用于测试与诊断）。 */
  getConfig(): TurnGuardrailsConfig {
    return { ...this.config };
  }

  // ─── 内部方法 ───────────────────────────────────────────────────────────────

  /** 获取或创建回合上下文（若不存在则自动 startTurn）。 */
  private getOrCreateTurn(
    turnId: string,
    participantIds: string[],
    now: Date,
  ): TurnContext {
    const existing = this.turns.get(turnId);
    if (existing) return existing;
    return this.startTurn(turnId, participantIds, now);
  }

  /** 统计指定 senderId 在过去 windowMs 内的回合开始次数。 */
  private countTurnsInWindow(senderId: string, now: Date, windowMs: number): number {
    const list = this.turnEvents.get(senderId);
    if (!list || list.length === 0) return 0;
    const cutoff = now.getTime() - windowMs;
    return list.filter((d) => d.getTime() >= cutoff).length;
  }
}
