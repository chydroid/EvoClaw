/**
 * restart-sentinel.ts — Gateway 重启授权哨兵
 *
 * 对齐 openclaw-main 的 src/infra/restart.ts 中的 SIGUSR1 授权机制。
 *
 * 设计意图：
 * - 防止外部 / 未授权信号触发非预期重启
 * - 仅当业务层显式调用 authorize() 后，信号处理器才允许重启
 * - 授权具有时效性（默认 5s 内有效），过期自动失效
 * - 支持 force 策略开关：允许 / 禁止外部信号
 * - 提供 cycle token 机制，防止同一次重启被消费多次
 *
 * 注意：EvoClaw 在 Windows 上不使用真实 SIGUSR1（Node.js 不支持），
 * 而是用此 sentinel + supervisor handoff 组合实现等效语义。
 */

const DEFAULT_AUTH_GRACE_MS = 5000;
const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * 重启授权状态。
 */
export interface SentinelState {
  authorizedCount: number;
  authorizedUntil: number;
  externalAllowed: boolean;
  cycleToken: number;
  consumedToken: number;
  lastEmitAt: number;
  emittedReason: string | undefined;
}

/**
 * 重启哨兵 — 单例模式，全局唯一。
 *
 * 状态全部存储在闭包中，外部仅能通过方法访问。
 */
export class RestartSentinel {
  private authorizedCount = 0;
  private authorizedUntil = 0;
  private externalAllowed = false;
  private cycleToken = 0;
  private consumedToken = 0;
  // -1 表示从未 emit 过；避免与 now=0 时误判为"刚 emit"
  private lastEmitAt = -1;
  private emittedReason: string | undefined;

  private readonly authGraceMs: number;
  private readonly cooldownMs: number;
  private readonly nowFn: () => number;

  constructor(opts?: { authGraceMs?: number; cooldownMs?: number; nowFn?: () => number }) {
    this.authGraceMs = opts?.authGraceMs ?? DEFAULT_AUTH_GRACE_MS;
    this.cooldownMs = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.nowFn = opts?.nowFn ?? (() => Date.now());
  }

  /**
   * 设置外部信号策略：是否允许外部信号触发重启。
   */
  setExternalPolicy(allowExternal: boolean): void {
    this.externalAllowed = allowExternal;
  }

  isExternallyAllowed(): boolean {
    return this.externalAllowed;
  }

  /**
   * 授权一次重启。授权有效期 = delayMs + authGraceMs。
   */
  authorize(delayMs = 0): void {
    const delay = Math.max(0, Math.floor(delayMs));
    const expiresAt = this.nowFn() + delay + this.authGraceMs;
    this.authorizedCount += 1;
    if (expiresAt > this.authorizedUntil) {
      this.authorizedUntil = expiresAt;
    }
  }

  /**
   * 消费一次授权。返回 true 表示有效授权被消费。
   * 过期授权自动重置为 0。
   */
  consumeAuthorization(): boolean {
    this.resetIfExpired();
    if (this.authorizedCount <= 0) {
      return false;
    }
    this.authorizedCount -= 1;
    if (this.authorizedCount <= 0) {
      this.authorizedUntil = 0;
    }
    return true;
  }

  /**
   * 当前是否有未消费的授权。
   */
  hasPendingAuthorization(): boolean {
    this.resetIfExpired();
    return this.authorizedCount > 0;
  }

  /**
   * 判断外部信号是否被允许触发重启。
   * 1. externalAllowed 必须为 true
   * 2. 必须有未消费的授权
   */
  canExternalSignalTrigger(): boolean {
    return this.externalAllowed && this.hasPendingAuthorization();
  }

  /**
   * 进入新一轮重启 cycle，返回新的 cycle token。
   * 仅更新 cycle 状态；不修改 lastEmitAt（应由 markEmitted() 显式标记）。
   */
  enterCycle(reason?: string): number {
    this.cycleToken += 1;
    this.emittedReason = reason;
    return this.cycleToken;
  }

  /**
   * 标记信号已实际发出（用于冷却期计算）。
   * 在 emitGatewayRestart 成功发送信号后调用。
   */
  markEmitted(): void {
    this.lastEmitAt = this.nowFn();
  }

  /**
   * 标记当前 cycle 已被消费。
   */
  markConsumed(): void {
    if (this.hasUnconsumedSignal()) {
      this.consumedToken = this.cycleToken;
      this.emittedReason = undefined;
    }
  }

  /**
   * 回滚最近一次 emit（emit 失败时调用）。
   */
  rollbackEmission(): void {
    this.cycleToken = this.consumedToken;
    this.emittedReason = undefined;
    this.consumeAuthorization();
  }

  /**
   * 当前是否有未消费的重启信号。
   */
  hasUnconsumedSignal(): boolean {
    return this.cycleToken > this.consumedToken;
  }

  /**
   * 当前 cycle 的 reason（仅当有未消费信号时返回）。
   */
  peekEmittedReason(): string | undefined {
    return this.hasUnconsumedSignal() ? this.emittedReason : undefined;
  }

  /**
   * 距离下次可重启还需等待的冷却时间（毫秒）。
   * 0 表示可以立即重启。
   */
  remainingCooldownMs(): number {
    if (this.cooldownMs <= 0) {
      return 0;
    }
    if (this.lastEmitAt < 0) {
      return 0;
    }
    const elapsed = this.nowFn() - this.lastEmitAt;
    if (elapsed >= this.cooldownMs) {
      return 0;
    }
    return this.cooldownMs - elapsed;
  }

  /**
   * 获取完整状态快照（用于诊断 / 测试）。
   */
  getState(): SentinelState {
    return {
      authorizedCount: this.authorizedCount,
      authorizedUntil: this.authorizedUntil,
      externalAllowed: this.externalAllowed,
      cycleToken: this.cycleToken,
      consumedToken: this.consumedToken,
      lastEmitAt: this.lastEmitAt,
      emittedReason: this.emittedReason,
    };
  }

  /**
   * 重置全部状态（仅用于测试）。
   */
  reset(): void {
    this.authorizedCount = 0;
    this.authorizedUntil = 0;
    this.externalAllowed = false;
    this.cycleToken = 0;
    this.consumedToken = 0;
    this.lastEmitAt = -1;
    this.emittedReason = undefined;
  }

  private resetIfExpired(): void {
    if (this.authorizedCount <= 0) {
      return;
    }
    if (this.nowFn() <= this.authorizedUntil) {
      return;
    }
    this.authorizedCount = 0;
    this.authorizedUntil = 0;
  }
}

/**
 * 默认单例 — 全局共享。
 */
let defaultSentinel: RestartSentinel | null = null;

export function getDefaultRestartSentinel(): RestartSentinel {
  if (!defaultSentinel) {
    defaultSentinel = new RestartSentinel();
  }
  return defaultSentinel;
}

/**
 * 重置默认单例（仅用于测试）。
 */
export function resetDefaultRestartSentinel(): void {
  defaultSentinel = null;
}

/**
 * 暴露内部常量给测试。
 */
export const __testing = {
  DEFAULT_AUTH_GRACE_MS,
  DEFAULT_COOLDOWN_MS,
};
