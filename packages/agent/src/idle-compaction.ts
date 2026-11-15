/**
 * Idle-Triggered Compaction — 空闲触发压缩（对标 hermes-agent
 * `agent/turn_context.py:519 _should_idle_compact` +
 * `agent/turn_context_compaction.py:144 _idle_compaction`）。
 *
 * 不变式（只移植不变量，不搬架构）：
 * - **opt-in**：`idleAfterSeconds <= 0` 关闭；默认 0，不改变既有行为。
 * - **触发条件三合一**：会话开关打开 且 墙钟空闲 ≥ 阈值 且 当前 token > 有效 floor，
 *   且不在压缩失败冷却期（对齐 hermes `_should_idle_compact`）。
 * - **floor 防反复压缩（#97239）**：`effectiveFloor = max(floorTokens,
 *   lastCompactionTokens + floorTokens)`。`lastCompactionTokens` 是上一次压缩**实际产出**
 *   的粗略 token（而非理论 target）——真实压缩几乎达不到理论 target（系统提示、工具
 *   schema、受保护的头/尾都不可压缩），若只用理论值，一个压到 floor 以上的长会话会在
 *   **每次空闲恢复**都重跑一遍无进展的全量摘要，慢路由上静默阻塞 prompt 数分钟。
 *   抬高 floor 后，transcript 必须先新增「一个 floor 的量」才会再次压缩。
 * - **默认关闭、可回滚**：所有接线在 `idleAfterSeconds <= 0` 时零成本降级。
 * - **不改 prompt 缓存前缀**：压缩是 AGENTS.md 允许的缓存例外，且仅替换会话历史。
 */

/** 理论压缩目标 = 压缩阈值 × 该比例（对齐 hermes `summary_target_ratio` 默认 0.20）。 */
export const IDLE_SUMMARY_TARGET_RATIO = 0.2;

/** 每个会话的压缩状态上限（LRU，防无限增长）。 */
const MAX_TRACKED_SESSIONS = 256;

export interface IdleCompactInput {
  /** 会话级压缩开关（autoCompactionEnabled） */
  enabled: boolean;
  /** 空闲阈值秒数；<=0 关闭 */
  idleAfterSeconds: number;
  /** 距离上次活动的墙钟秒数 */
  idleGapSeconds: number;
  /** 当前请求 token 估算（系统提示 + 历史） */
  tokens: number;
  /** 理论 floor（compactionTokenThreshold × IDLE_SUMMARY_TARGET_RATIO） */
  floorTokens: number;
  /** 是否处于压缩失败冷却 / 反抖动期内 */
  cooldownActive: boolean;
  /** 上一次压缩实际产出的粗略 token；0/未定义表示还没压缩过 */
  lastCompactionTokens?: number;
}

/**
 * 纯谓词：是否应触发空闲压缩。
 *
 * 对齐 hermes `_should_idle_compact` 的判定顺序与语义：
 *   1. 关闭 / 阈值 <= 0 / 空闲不足 / 冷却期 → 否
 *   2. 有效 floor = max(floor, lastCompactionTokens + floor)
 *   3. tokens > 有效 floor → 是
 */
export function shouldIdleCompact(input: IdleCompactInput): boolean {
  const {
    enabled, idleAfterSeconds, idleGapSeconds, tokens, floorTokens,
    cooldownActive, lastCompactionTokens,
  } = input;
  if (!enabled || idleAfterSeconds <= 0 || idleGapSeconds < idleAfterSeconds || cooldownActive) {
    return false;
  }
  let effectiveFloor = floorTokens;
  if (typeof lastCompactionTokens === "number" && lastCompactionTokens > 0) {
    effectiveFloor = Math.max(effectiveFloor, lastCompactionTokens + floorTokens);
  }
  return tokens > effectiveFloor;
}

/** 计算理论 floor（对齐 hermes `threshold_tokens × summary_target_ratio`）。 */
export function idleFloorTokens(thresholdTokens: number, ratio: number = IDLE_SUMMARY_TARGET_RATIO): number {
  if (!Number.isFinite(thresholdTokens) || thresholdTokens <= 0) return 0;
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : IDLE_SUMMARY_TARGET_RATIO;
  return Math.floor(thresholdTokens * safeRatio);
}

interface SessionIdleState {
  /** 上次活动时间戳（ms） */
  lastActivityAt: number;
  /** 上次压缩实际产出的粗略 token；0 表示还没压缩过 */
  lastCompactionTokens: number;
}

/**
 * 会话级空闲状态追踪器（LRU 上限，不按空闲时间淘汰——长空闲正是我们要检测的对象）。
 *
 * 用法：
 * - 每轮结束（turn 完成）调用 `touch(sessionId)` 记录活动时间；
 * - 每轮开始调用 `getIdleGapSeconds(sessionId)` 读取距上次活动的空闲秒数；
 * - 压缩成功后调用 `recordCompaction(sessionId, producedTokens)` 抬高下次的 floor。
 */
export class IdleCompactionTracker {
  private states = new Map<string, SessionIdleState>();
  private readonly maxSessions: number;

  constructor(maxSessions: number = MAX_TRACKED_SESSIONS) {
    this.maxSessions = Number.isFinite(maxSessions) && maxSessions > 0 ? maxSessions : MAX_TRACKED_SESSIONS;
  }

  /** 记录一次活动（LRU 提升）。 */
  touch(sessionId: string, now: number = Date.now()): void {
    if (!sessionId) return;
    const existing = this.states.get(sessionId);
    const next: SessionIdleState = {
      lastActivityAt: now,
      lastCompactionTokens: existing?.lastCompactionTokens ?? 0,
    };
    this.states.delete(sessionId);
    this.states.set(sessionId, next);
    this.evictIfNeeded();
  }

  /**
   * 距上次活动的空闲秒数；从未记录过（首轮）返回 null，
   * 调用方据此跳过空闲触发（对齐 hermes `_last_activity_ts` 初始为 now → gap≈0）。
   */
  getIdleGapSeconds(sessionId: string, now: number = Date.now()): number | null {
    const state = this.states.get(sessionId);
    if (!state) return null;
    return Math.max(0, (now - state.lastActivityAt) / 1000);
  }

  /** 记录一次压缩实际产出的粗略 token，并刷新活动时间。 */
  recordCompaction(sessionId: string, producedTokens: number, now: number = Date.now()): void {
    if (!sessionId) return;
    const safeProduced = Number.isFinite(producedTokens) && producedTokens > 0 ? producedTokens : 0;
    const existing = this.states.get(sessionId);
    const next: SessionIdleState = {
      lastActivityAt: now,
      lastCompactionTokens: safeProduced,
    };
    this.states.delete(sessionId);
    this.states.set(sessionId, next);
    this.evictIfNeeded();
  }

  /** 上次压缩产出的粗略 token；未压缩过返回 0。 */
  getLastCompactionTokens(sessionId: string): number {
    return this.states.get(sessionId)?.lastCompactionTokens ?? 0;
  }

  /** 清除某会话状态（测试 / 会话重置用）。 */
  reset(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /** 当前跟踪的会话数（测试用）。 */
  size(): number {
    return this.states.size;
  }

  private evictIfNeeded(): void {
    while (this.states.size > this.maxSessions) {
      const oldestKey = this.states.keys().next().value;
      if (oldestKey === undefined) break;
      this.states.delete(oldestKey);
    }
  }
}
