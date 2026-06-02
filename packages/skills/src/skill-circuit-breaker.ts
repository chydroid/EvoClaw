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
      return record.halfOpenAttempts < this.config.halfOpenMaxAttempts;
    }

    return false;
  }

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
