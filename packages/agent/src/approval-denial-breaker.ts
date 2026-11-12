/**
 * Approval Denial Breaker — 审批连续拒绝熔断（P3，对标 hermes `approval.py:62-116`）。
 *
 * 不变式：
 * - 按**会话**统计「连续拒绝」；阈值默认 3，`<=0` 关闭（不统计、不熔断）。
 * - 任意一次批准（或用户 chat 明确同意）即清零；超时不算拒绝。
 * - 熔断只影响「是否再生成审批请求」，提示只进 tool-result/事件文本，
 *   不改 system prompt / 工具 schema / history（prompt 缓存优先）。
 * - 上限 256 会话，LRU 淘汰；30 分钟空闲 TTL 自动过期。
 */

export interface DenialBreakerConfig {
  /** 连续拒绝阈值；<=0 关闭熔断统计 */
  threshold: number;
  /** 空闲多久后丢弃会话状态（默认 30 分钟） */
  idleTtlMs: number;
  /** 最多跟踪多少个会话（LRU，默认 256） */
  maxSessions: number;
}

export interface DenialBreakerState {
  consecutive: number;
  lastDeniedAt: number;
  /** 达到阈值的时间戳；存在即表示已熔断 */
  trippedAt?: number;
  /** 最近一次拒绝的 requestId（事件 + 决策回调会重复投递，据此去重） */
  lastRequestId?: string;
}

export interface DenialBreakerSnapshotEntry extends DenialBreakerState {
  sessionId: string;
}

const DEFAULT_CONFIG: DenialBreakerConfig = {
  threshold: 3,
  idleTtlMs: 30 * 60 * 1000,
  maxSessions: 256,
};

/** 从环境变量解析配置（非法值回落默认；threshold 允许 0 表示关闭） */
export function resolveDenialBreakerConfig(env: NodeJS.ProcessEnv = process.env): DenialBreakerConfig {
  const rawThreshold = Number.parseInt(env.EVOCLAW_APPROVAL_DENIAL_THRESHOLD ?? "", 10);
  const rawIdle = Number.parseInt(env.EVOCLAW_APPROVAL_DENIAL_IDLE_MS ?? "", 10);
  return {
    threshold: Number.isFinite(rawThreshold) ? rawThreshold : DEFAULT_CONFIG.threshold,
    idleTtlMs: Number.isFinite(rawIdle) && rawIdle > 0 ? rawIdle : DEFAULT_CONFIG.idleTtlMs,
    maxSessions: DEFAULT_CONFIG.maxSessions,
  };
}

export class ApprovalDenialBreaker {
  private states = new Map<string, DenialBreakerState>();
  private readonly config: DenialBreakerConfig;

  constructor(config: Partial<DenialBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Map 的插入顺序即「最后使用顺序」：每次访问都 delete+set 做 LRU 提升
  }

  getConfig(): Readonly<DenialBreakerConfig> {
    return this.config;
  }

  get enabled(): boolean {
    return this.config.threshold > 0;
  }

  /** 记录一次拒绝；返回该会话最新状态 */
  recordDenial(sessionId: string, requestId?: string): DenialBreakerState {
    const empty: DenialBreakerState = { consecutive: 0, lastDeniedAt: Date.now() };
    if (!sessionId || !this.enabled) return empty;

    const existing = this.touch(sessionId);
    // 去重：同一次拒绝可能同时经「决策回调 + permission.denied 事件」到达
    if (existing && requestId !== undefined && existing.lastRequestId === requestId) {
      return { ...existing };
    }

    const state: DenialBreakerState = existing ?? { consecutive: 0, lastDeniedAt: Date.now() };
    state.consecutive += 1;
    state.lastDeniedAt = Date.now();
    if (requestId !== undefined) state.lastRequestId = requestId;
    if (state.consecutive >= this.config.threshold && state.trippedAt === undefined) {
      state.trippedAt = state.lastDeniedAt;
    }
    this.states.delete(sessionId);
    this.states.set(sessionId, state);
    this.evictOverflow();
    return { ...state };
  }

  /** 任意一次批准/用户明确同意 → 清零该会话 */
  recordApproval(sessionId: string): void {
    if (!sessionId) return;
    this.states.delete(sessionId);
  }

  /** 是否已熔断（已过期/未触发的会话返回 false） */
  isTripped(sessionId: string): boolean {
    const state = this.touch(sessionId);
    return state?.trippedAt !== undefined;
  }

  getState(sessionId: string): DenialBreakerState | undefined {
    const state = this.touch(sessionId);
    return state ? { ...state } : undefined;
  }

  /** 重置单个会话或全部；返回被清理的条目数 */
  reset(sessionId?: string): number {
    if (sessionId) {
      return this.states.delete(sessionId) ? 1 : 0;
    }
    const count = this.states.size;
    this.states.clear();
    return count;
  }

  /** 可观测快照（按最近拒绝时间倒序） */
  snapshot(): DenialBreakerSnapshotEntry[] {
    this.pruneExpired();
    return Array.from(this.states.entries())
      .map(([sessionId, state]) => ({ sessionId, ...state }))
      .sort((a, b) => b.lastDeniedAt - a.lastDeniedAt);
  }

  /** 读取并做 TTL 检查 + LRU 提升 */
  private touch(sessionId: string): DenialBreakerState | undefined {
    const state = this.states.get(sessionId);
    if (!state) return undefined;
    if (Date.now() - state.lastDeniedAt > this.config.idleTtlMs) {
      this.states.delete(sessionId);
      return undefined;
    }
    // LRU 提升
    this.states.delete(sessionId);
    this.states.set(sessionId, state);
    return state;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [sessionId, state] of this.states) {
      if (now - state.lastDeniedAt > this.config.idleTtlMs) {
        this.states.delete(sessionId);
      }
    }
  }

  private evictOverflow(): void {
    while (this.states.size > this.config.maxSessions) {
      const oldest = this.states.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.states.delete(oldest);
    }
  }
}
