import { ServiceRegistry, EventBus } from "@evoclaw/core";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitStats {
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureTime: Date | null;
  lastSuccessTime: Date | null;
  lastFailureError: string | null;
  openedAt: Date | null;
  halfOpenAttempts: number;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeout: number;
  halfOpenMaxAttempts: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeout: 60_000,
  halfOpenMaxAttempts: 1,
};

interface CircuitRecord {
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureTime: Date | null;
  lastSuccessTime: Date | null;
  lastFailureError: string | null;
  openedAt: Date | null;
  halfOpenAttempts: number;
}

export class SkillCircuitBreaker {
  private circuits = new Map<string, CircuitRecord>();
  private config: CircuitBreakerConfig;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    config?: Partial<CircuitBreakerConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    registry.registerService("skillCircuitBreaker", this);
  }

  recordSuccess(skillId: string): void {
    const record = this.getOrCreateRecord(skillId);
    record.consecutiveFailures = 0;
    record.consecutiveSuccesses++;
    record.totalSuccesses++;
    record.lastSuccessTime = new Date();

    if (record.state === "HALF_OPEN") {
      record.state = "CLOSED";
      record.halfOpenAttempts = 0;
      this.eventBus.publish(
        "skill.circuit_closed",
        { skillId, reason: "half_open_success" },
        "SkillCircuitBreaker"
      );
    }
  }

  recordFailure(skillId: string, error: string): void {
    const record = this.getOrCreateRecord(skillId);
    record.consecutiveSuccesses = 0;
    record.consecutiveFailures++;
    record.totalFailures++;
    record.lastFailureTime = new Date();
    record.lastFailureError = error;

    if (record.state === "CLOSED" && record.consecutiveFailures >= this.config.failureThreshold) {
      record.state = "OPEN";
      record.openedAt = new Date();
      this.eventBus.publish(
        "skill.circuit_open",
        { skillId, consecutiveFailures: record.consecutiveFailures, error },
        "SkillCircuitBreaker"
      );
    } else if (record.state === "HALF_OPEN") {
      record.state = "OPEN";
      record.openedAt = new Date();
      record.halfOpenAttempts = 0;
      this.eventBus.publish(
        "skill.circuit_open",
        { skillId, reason: "half_open_failure", error },
        "SkillCircuitBreaker"
      );
    }
  }

  /**
   * 查询技能是否可用（熔断器是否允许放行）。
   *
   * 已知限制：本方法为查询语义但有副作用——
   *   1. OPEN 且已过 resetTimeout 时，会推进状态至 HALF_OPEN（探测窗口开启）；
   *   2. HALF_OPEN 时会递增 halfOpenAttempts 以计数探测次数，使熔断器在探测耗尽后能回到 OPEN。
   * 第 2 点是前一轮专门修复的探测计数问题：由于调用方（SkillDispatcher）不会单独调用
   * incrementHalfOpenAttempt()，若把递增移出本查询方法会导致探测次数永远不增加、
   * HALF_OPEN 永不收敛。因此保留递增，不抽离为纯查询。如需完全无副作用地读取，请改用
   * getStats() 并注意其内部仍会调用 getState() 触发 OPEN→HALF_OPEN 推进。
   */
  isAvailable(skillId: string): boolean {
    const record = this.circuits.get(skillId);
    if (!record) return true;

    if (record.state === "CLOSED") return true;

    if (record.state === "OPEN") {
      const elapsed = Date.now() - (record.openedAt?.getTime() ?? 0);
      if (elapsed >= this.config.resetTimeout) {
        record.state = "HALF_OPEN";
        record.halfOpenAttempts = 0;
        return true;
      }
      return false;
    }

    if (record.state === "HALF_OPEN") {
      // 半开状态下递增探测计数，使熔断器能在探测耗尽后回到 OPEN
      if (record.halfOpenAttempts < this.config.halfOpenMaxAttempts) {
        record.halfOpenAttempts++;
        return true;
      }
      return false;
    }

    return false;
  }

  /**
   * 查询熔断器当前状态。
   *
   * 已知限制：本方法为查询语义但有副作用——OPEN 且已过 resetTimeout 时会推进状态至
   * HALF_OPEN，以与 isAvailable() 的视图保持一致。getStats() 内部亦会经由本方法触发该推进。
   * 抽离为纯查询需同步改造 isAvailable/getStats 与调用方，风险较高，暂以注释标注限制。
   */
  getState(skillId: string): CircuitState {
    const record = this.circuits.get(skillId);
    if (!record) return "CLOSED";

    if (record.state === "OPEN") {
      const elapsed = Date.now() - (record.openedAt?.getTime() ?? 0);
      if (elapsed >= this.config.resetTimeout) {
        record.state = "HALF_OPEN";
        record.halfOpenAttempts = 0;
      }
    }

    return record.state;
  }

  getStats(skillId: string): CircuitStats {
    const record = this.circuits.get(skillId);
    if (!record) {
      return {
        state: "CLOSED",
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        totalFailures: 0,
        totalSuccesses: 0,
        lastFailureTime: null,
        lastSuccessTime: null,
        lastFailureError: null,
        openedAt: null,
        halfOpenAttempts: 0,
      };
    }

    this.getState(skillId);

    return {
      state: record.state,
      consecutiveFailures: record.consecutiveFailures,
      consecutiveSuccesses: record.consecutiveSuccesses,
      totalFailures: record.totalFailures,
      totalSuccesses: record.totalSuccesses,
      lastFailureTime: record.lastFailureTime,
      lastSuccessTime: record.lastSuccessTime,
      lastFailureError: record.lastFailureError,
      openedAt: record.openedAt,
      halfOpenAttempts: record.halfOpenAttempts,
    };
  }

  reset(skillId: string): void {
    const record = this.circuits.get(skillId);
    if (!record) return;

    const wasOpen = record.state === "OPEN" || record.state === "HALF_OPEN";
    record.state = "CLOSED";
    record.consecutiveFailures = 0;
    record.consecutiveSuccesses = 0;
    record.halfOpenAttempts = 0;
    record.openedAt = null;

    if (wasOpen) {
      this.eventBus.publish(
        "skill.circuit_closed",
        { skillId, reason: "manual_reset" },
        "SkillCircuitBreaker"
      );
    }
  }

  /**
   * 清理长时间无活动的熔断记录，防止 circuits Map 随技能失败无限增长。
   * lastActivity 取 lastFailureTime / lastSuccessTime 中较新者；
   * 两者皆缺（新创建尚未触发任何记录）的条目予以保留。
   * 默认阈值 24h。返回被清理的条目数。
   */
  pruneStaleCircuits(maxIdleMs: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let removed = 0;
    for (const [skillId, record] of this.circuits) {
      const lastFailure = record.lastFailureTime?.getTime() ?? 0;
      const lastSuccess = record.lastSuccessTime?.getTime() ?? 0;
      const lastActivity = Math.max(lastFailure, lastSuccess);
      if (lastActivity === 0) continue; // 无活动记录，保留新条目
      if (now - lastActivity > maxIdleMs) {
        this.circuits.delete(skillId);
        removed++;
      }
    }
    return removed;
  }

  private getOrCreateRecord(skillId: string): CircuitRecord {
    let record = this.circuits.get(skillId);
    if (!record) {
      record = {
        state: "CLOSED",
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        totalFailures: 0,
        totalSuccesses: 0,
        lastFailureTime: null,
        lastSuccessTime: null,
        lastFailureError: null,
        openedAt: null,
        halfOpenAttempts: 0,
      };
      this.circuits.set(skillId, record);
      // 新增条目时顺手清理过期熔断记录，防止 circuits Map 无限增长
      this.pruneStaleCircuits();
    }
    return record;
  }

  incrementHalfOpenAttempt(skillId: string): void {
    const record = this.circuits.get(skillId);
    if (record && record.state === "HALF_OPEN") {
      record.halfOpenAttempts++;
    }
  }
}
