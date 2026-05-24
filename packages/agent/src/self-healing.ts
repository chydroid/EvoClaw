/**
 * Self-Healing & Resilience Engine — automatic error recovery,
 * adaptive mutation strategies, and system robustness enhancement.
 *
 * Provides:
 *  - Auto-recovery patterns: retry, circuit breaker, fallback, graceful degradation
 *  - Adaptive mutation: dynamically adjust evolution mutation rates based on success
 *  - Health scoring: multi-dimensional system health monitoring
 *  - Anomaly detection: identify unusual patterns in agent behavior
 *  - Error pattern learning: recognize recurring error signatures
 *  - Resilience scoring: track and improve system robustness over time
 *
 * Integrates with EvolutionEngine for feedback-driven improvement
 * and ModelFailoverManager for provider health integration.
 */

import { EventEmitter } from "events";

// ── Types ─────────────────────────────────────────────────

export type RecoveryStrategy =
  | "retry"              // Retry with backoff
  | "circuit_breaker"    // Open circuit and use fallback
  | "fallback"           // Use alternative provider/model
  | "graceful_degrade"   // Reduce capability scope
  | "escalate"           // Escalate to human/supervisor
  | "rollback"           // Rollback to last known good state
  | "reinitialize"       // Reset and reinitialize
  | "cache_serve";       // Serve from cache

export interface ResilienceConfig {
  /** Max retry attempts for auto-recovery */
  maxRetries: number;
  /** Base delay for exponential backoff (ms) */
  retryBaseDelayMs: number;
  /** Max delay for exponential backoff (ms) */
  retryMaxDelayMs: number;
  /** Circuit breaker threshold (failures before opening) */
  circuitBreakerThreshold: number;
  /** Circuit breaker reset timeout (ms) */
  circuitResetTimeoutMs: number;
  /** Health check interval (ms) */
  healthCheckIntervalMs: number;
  /** Minimum health score before triggering recovery */
  minHealthScore: number;
  /** Anomaly detection sensitivity (0-1, lower = more sensitive) */
  anomalySensitivity: number;
}

export interface HealthScore {
  /** Overall system health (0-100) */
  overall: number;
  /** Provider health (API availability) */
  provider: number;
  /** Memory health (eviction rate, hit rate) */
  memory: number;
  /** Agent health (success rate, response time) */
  agent: number;
  /** Channel health (connection stability) */
  channels: number;
  /** Evolution engine health */
  evolution: number;
  /** Individual component scores */
  components: Record<string, number>;
  /** Last assessment timestamp */
  assessedAt: number;
}

export interface ErrorPattern {
  /** Unique signature hash */
  signature: string;
  /** Error type classification */
  type: "network" | "timeout" | "auth" | "rate_limit" | "context_overflow" | "parsing" | "validation" | "system" | "unknown";
  /** Error message pattern (regex) */
  messagePattern: string;
  /** Occurrence count */
  count: number;
  /** First seen */
  firstSeen: number;
  /** Last seen */
  lastSeen: number;
  /** Recommended recovery strategy */
  recovery: RecoveryStrategy;
  /** Success rate of the recommended recovery */
  recoverySuccessRate: number;
  /** Resolved (no longer occurs) */
  resolved: boolean;
}

export interface MutationStrategy {
  name: string;
  description: string;
  /** Current mutation rate (0-1) */
  rate: number;
  /** Rate adapts based on success feedback */
  adaptive: boolean;
  /** Minimum rate */
  minRate: number;
  /** Maximum rate */
  maxRate: number;
  /** Success rate of mutations using this strategy (0-1) */
  successRate: number;
  /** Times applied */
  appliedCount: number;
  /** Times successful */
  successCount: number;
}

export interface AnomalyRecord {
  id: string;
  type: "latency_spike" | "error_rate" | "memory_leak" | "token_explosion" | "tool_loop" | "response_drift";
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  detectedAt: number;
  resolvedAt?: number;
  resolved: boolean;
  resolution?: string;
}

// ── Self-Healing Engine ───────────────────────────────────

export class SelfHealingEngine extends EventEmitter {
  private config: Required<ResilienceConfig>;
  private errorPatterns: ErrorPattern[] = [];
  private mutationStrategies: MutationStrategy[] = [];
  private anomalies: AnomalyRecord[] = [];
  private healthScore: HealthScore;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private circuitState = new Map<string, { open: boolean; failures: number; lastFailure: number; resetTimer?: ReturnType<typeof setTimeout> }>();
  private recoveryStats = new Map<string, { attempts: number; successes: number }>();

  constructor(config: Partial<ResilienceConfig> = {}) {
    super();
    this.config = {
      maxRetries: config.maxRetries ?? 3,
      retryBaseDelayMs: config.retryBaseDelayMs ?? 1000,
      retryMaxDelayMs: config.retryMaxDelayMs ?? 30000,
      circuitBreakerThreshold: config.circuitBreakerThreshold ?? 5,
      circuitResetTimeoutMs: config.circuitResetTimeoutMs ?? 60000,
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? 30000,
      minHealthScore: config.minHealthScore ?? 40,
      anomalySensitivity: config.anomalySensitivity ?? 0.5,
    };

    this.healthScore = {
      overall: 100,
      provider: 100,
      memory: 100,
      agent: 100,
      channels: 100,
      evolution: 100,
      components: {},
      assessedAt: Date.now(),
    };

    this.initMutationStrategies();
  }

  // ── Error Pattern Learning ──────────────────────────────

  /**
   * Record an error occurrence. The engine learns error patterns
   * and recommends recovery strategies based on historical success.
   */
  recordError(error: Error, context?: { provider?: string; taskId?: string; toolName?: string }): ErrorPattern {
    const signature = this.buildErrorSignature(error, context);
    const classification = this.classifyError(error);

    // Check existing pattern
    let pattern = this.errorPatterns.find((p) => p.signature === signature);
    if (pattern) {
      pattern.count++;
      pattern.lastSeen = Date.now();
      pattern.resolved = false;
    } else {
      pattern = {
        signature,
        type: classification,
        messagePattern: this.extractPattern(error.message),
        count: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        recovery: this.recommendRecovery(classification),
        recoverySuccessRate: 0,
        resolved: false,
      };
      this.errorPatterns.push(pattern);
    }

    this.emit("error-recorded", { pattern, context });
    return pattern;
  }

  /**
   * Record the outcome of a recovery attempt.
   * Updates the error pattern's recovery success rate.
   */
  recordRecovery(signature: string, successful: boolean): void {
    const pattern = this.errorPatterns.find((p) => p.signature === signature);
    if (!pattern) return;

    let stats = this.recoveryStats.get(signature);
    if (!stats) {
      stats = { attempts: 0, successes: 0 };
      this.recoveryStats.set(signature, stats);
    }

    stats.attempts++;
    if (successful) stats.successes++;
    pattern.recoverySuccessRate = stats.successes / stats.attempts;

    if (successful) {
      pattern.resolved = true;
    }

    this.emit("recovery-recorded", { signature, successful });
  }

  /**
   * Get the recommended recovery strategy for an error.
   * Considers learned patterns and historical success rates.
   */
  getRecovery(error: Error, context?: Record<string, unknown>): RecoveryStrategy {
    const signature = this.buildErrorSignature(error, context);
    const pattern = this.errorPatterns.find((p) => p.signature === signature);

    if (pattern && pattern.recoverySuccessRate > 0.7) {
      return pattern.recovery;
    }

    // Check circuit breaker state
    const circuitKey = context?.provider as string ?? "default";
    const circuit = this.circuitState.get(circuitKey);
    if (circuit?.open) {
      return "fallback";
    }

    return this.recommendRecovery(this.classifyError(error));
  }

  // ── Auto-Recovery Execution ─────────────────────────────

  /**
   * Execute a function with automatic recovery.
   * Wraps the function call with retry, circuit breaker, and fallback logic.
   */
  async executeWithRecovery<T>(
    fn: () => Promise<T>,
    options?: {
      provider?: string;
      taskId?: string;
      maxRetries?: number;
      recoveryHints?: Partial<Record<RecoveryStrategy, () => Promise<T>>>;
    }
  ): Promise<{ result: T | null; recovered: boolean; strategy?: RecoveryStrategy; attempts: number; error?: Error }> {
    const circuitKey = options?.provider ?? "default";
    const maxRetries = options?.maxRetries ?? this.config.maxRetries;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Check circuit breaker
        const circuit = this.circuitState.get(circuitKey);
        if (circuit?.open) {
          const elapsed = Date.now() - circuit.lastFailure;
          if (elapsed > this.config.circuitResetTimeoutMs) {
            // Half-open: allow one probe
            circuit.open = false;
            circuit.failures = 0;
          } else if (options?.recoveryHints?.fallback) {
            try {
              const fallbackResult = await options.recoveryHints.fallback();
              return { result: fallbackResult, recovered: true, strategy: "fallback", attempts: attempt + 1 };
            } catch (fbErr) {
              lastError = fbErr as Error;
              this.recordCircuitFailure(circuitKey);
              continue;
            }
          } else {
            return {
              result: null,
              recovered: false,
              strategy: "circuit_breaker",
              attempts: attempt,
              error: new Error(`Circuit open for ${circuitKey}`),
            };
          }
        }

        // Execute
        const result = await fn();
        this.recordCircuitSuccess(circuitKey);
        return {
          result,
          recovered: attempt > 0,
          strategy: attempt > 0 ? "retry" : undefined,
          attempts: attempt + 1,
        };
      } catch (err) {
        lastError = err as Error;
        this.recordError(lastError, options);

        // Circuit breaker: record failure
        this.recordCircuitFailure(circuitKey);

        // If this is the last attempt, check for fallback
        if (attempt === maxRetries) {
          const recovery = this.getRecovery(lastError, options as Record<string, unknown>);

          // Try the recommended strategy first
          if (recovery === "fallback" && options?.recoveryHints?.fallback) {
            try {
              const fbResult = await options.recoveryHints.fallback();
              return { result: fbResult, recovered: true, strategy: "fallback", attempts: attempt + 1, error: lastError };
            } catch {
              // Fallback also failed
            }
          }

          if (recovery === "cache_serve" && options?.recoveryHints?.cache_serve) {
            try {
              const cacheResult = await options.recoveryHints.cache_serve();
              return { result: cacheResult, recovered: true, strategy: "cache_serve", attempts: attempt + 1, error: lastError };
            } catch {
              // Cache also failed
            }
          }

          // Try any other available recovery hints as last resort
          if (options?.recoveryHints) {
            for (const [key, hintFn] of Object.entries(options.recoveryHints)) {
              if (key === recovery) continue; // already tried above
              try {
                const result = await hintFn();
                return { result, recovered: true, strategy: key as RecoveryStrategy, attempts: attempt + 1, error: lastError };
              } catch {
                // Hint also failed
              }
            }
          }
        } else {
          // Wait before retrying (exponential backoff with jitter)
          const delay = Math.min(
            this.config.retryBaseDelayMs * (2 ** attempt) + Math.random() * 500,
            this.config.retryMaxDelayMs
          );
          this.emit("recovery-retrying", { attempt: attempt + 1, delay, error: lastError.message });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    return {
      result: null,
      recovered: false,
      attempts: maxRetries + 1,
      error: lastError,
    };
  }

  // ── Adaptive Mutation Strategies ────────────────────────

  /** Initialize default mutation strategies */
  private initMutationStrategies(): void {
    this.mutationStrategies = [
      {
        name: "prompt_rewrite",
        description: "Rewrite system prompt for clarity",
        rate: 0.3,
        adaptive: true,
        minRate: 0.1,
        maxRate: 0.5,
        successRate: 0.5,
        appliedCount: 0,
        successCount: 0,
      },
      {
        name: "tool_reorder",
        description: "Reorder tool definitions for better matching",
        rate: 0.2,
        adaptive: true,
        minRate: 0.05,
        maxRate: 0.4,
        successRate: 0.5,
        appliedCount: 0,
        successCount: 0,
      },
      {
        name: "temperature_tune",
        description: "Adjust temperature for optimal creativity/precision",
        rate: 0.15,
        adaptive: true,
        minRate: 0.05,
        maxRate: 0.3,
        successRate: 0.5,
        appliedCount: 0,
        successCount: 0,
      },
      {
        name: "context_compress",
        description: "Aggressively compact context to fit more tokens",
        rate: 0.25,
        adaptive: true,
        minRate: 0.1,
        maxRate: 0.5,
        successRate: 0.5,
        appliedCount: 0,
        successCount: 0,
      },
      {
        name: "example_injection",
        description: "Inject relevant examples into prompt",
        rate: 0.2,
        adaptive: true,
        minRate: 0.05,
        maxRate: 0.35,
        successRate: 0.5,
        appliedCount: 0,
        successCount: 0,
      },
      {
        name: "chain_of_thought",
        description: "Add chain-of-thought reasoning instructions",
        rate: 0.3,
        adaptive: true,
        minRate: 0.1,
        maxRate: 0.6,
        successRate: 0.5,
        appliedCount: 0,
        successCount: 0,
      },
    ];
  }

  /**
   * Record mutation outcome to adapt rates.
   * Successful mutations increase rate; failed ones decrease.
   */
  recordMutationOutcome(strategyName: string, successful: boolean): void {
    const strategy = this.mutationStrategies.find((s) => s.name === strategyName);
    if (!strategy) return;

    strategy.appliedCount++;
    if (successful) {
      strategy.successCount++;
    }

    strategy.successRate = strategy.successCount / strategy.appliedCount;

    // Adaptive rate adjustment
    if (strategy.adaptive) {
      if (successful) {
        strategy.rate = Math.min(strategy.rate * 1.1, strategy.maxRate);
      } else {
        strategy.rate = Math.max(strategy.rate * 0.9, strategy.minRate);
      }
    }

    this.emit("mutation-adjusted", { strategy: strategyName, rate: strategy.rate, successRate: strategy.successRate });
  }

  /** Get the best-performing mutation strategy */
  getBestMutation(): MutationStrategy {
    return this.mutationStrategies
      .filter((s) => s.appliedCount > 0)
      .sort((a, b) => b.successRate - a.successRate)[0]
      ?? this.mutationStrategies[0];
  }

  /** Get all mutation strategies with current stats */
  getMutationStrategies(): MutationStrategy[] {
    return [...this.mutationStrategies];
  }

  // ── Health Scoring ──────────────────────────────────────

  /** Calculate the current health score based on all components */
  assessHealth(components: Record<string, { healthy: boolean; score?: number }>): HealthScore {
    const now = Date.now();
    const scores: Record<string, number> = {};

    for (const [name, component] of Object.entries(components)) {
      scores[name] = component.score ?? (component.healthy ? 100 : 0);
    }

    // Overall: weighted average of component scores
    const componentEntries = Object.entries(scores);
    const overall = componentEntries.length > 0
      ? Math.round(componentEntries.reduce((sum, [, s]) => sum + s, 0) / componentEntries.length)
      : 100;

    // Sub-scores based on component categories
    const providerScore = this.averageScore(scores, ["openai", "anthropic", "google", "provider"]);
    const memoryScore = this.averageScore(scores, ["memory", "vector", "graph", "session"]);
    const agentScore = this.averageScore(scores, ["agent", "executor", "planner", "orchestrator"]);
    const channelsScore = this.averageScore(scores, ["telegram", "discord", "slack", "whatsapp", "feishu", "wechat", "qq", "matrix"]);
    const evolutionScore = this.averageScore(scores, ["evolution", "genetic", "healing"]);

    this.healthScore = {
      overall,
      provider: providerScore,
      memory: memoryScore,
      agent: agentScore,
      channels: channelsScore,
      evolution: evolutionScore,
      components: scores,
      assessedAt: now,
    };

    // Emit alert if health is critically low
    if (overall < this.config.minHealthScore) {
      this.emit("health-critical", { score: this.healthScore });
    }

    return this.healthScore;
  }

  /** Get current health score */
  getHealthScore(): HealthScore {
    return { ...this.healthScore };
  }

  /** Check if system needs recovery intervention */
  needsRecovery(): boolean {
    return this.healthScore.overall < this.config.minHealthScore;
  }

  // ── Anomaly Detection ───────────────────────────────────

  /**
   * Detect anomalies in agent behavior metrics.
   * Compares current values against baseline expectations.
   */
  detectAnomalies(metrics: {
    avgLatencyMs: number;
    errorRate: number;
    tokenUsageGrowth: number;
    toolCallCount: number;
    responseLength: number;
    baselineLatencyMs: number;
    baselineErrorRate: number;
  }): AnomalyRecord[] {
    const newAnomalies: AnomalyRecord[] = [];
    const now = Date.now();
    const sensitivity = this.config.anomalySensitivity;

    // Latency spike
    if (metrics.avgLatencyMs > metrics.baselineLatencyMs * (1 + sensitivity * 2)) {
      newAnomalies.push(this.createAnomaly("latency_spike",
        metrics.avgLatencyMs > metrics.baselineLatencyMs * 3 ? "high" : "medium",
        `Latency ${Math.round(metrics.avgLatencyMs)}ms vs baseline ${Math.round(metrics.baselineLatencyMs)}ms`
      ));
    }

    // Error rate spike
    if (metrics.errorRate > metrics.baselineErrorRate * (1 + sensitivity * 3)) {
      newAnomalies.push(this.createAnomaly("error_rate",
        metrics.errorRate > 0.5 ? "critical" : "high",
        `Error rate ${Math.round(metrics.errorRate * 100)}% vs baseline ${Math.round(metrics.baselineErrorRate * 100)}%`
      ));
    }

    // Token explosion
    if (metrics.tokenUsageGrowth > 2.0) {
      newAnomalies.push(this.createAnomaly("token_explosion",
        "medium",
        `Token usage grew by ${Math.round(metrics.tokenUsageGrowth * 100)}%`
      ));
    }

    // Tool loop (excessive tool calls)
    if (metrics.toolCallCount > 20) {
      newAnomalies.push(this.createAnomaly("tool_loop",
        "high",
        `Excessive tool calls: ${metrics.toolCallCount} in one turn`
      ));
    }

    this.anomalies.push(...newAnomalies);

    for (const anomaly of newAnomalies) {
      this.emit("anomaly-detected", { anomaly });
    }

    return newAnomalies;
  }

  /** Resolve a previously detected anomaly */
  resolveAnomaly(id: string, resolution?: string): void {
    const anomaly = this.anomalies.find((a) => a.id === id);
    if (anomaly) {
      anomaly.resolved = true;
      anomaly.resolvedAt = Date.now();
      anomaly.resolution = resolution;
      this.emit("anomaly-resolved", { anomaly });
    }
  }

  /** Get unresolved anomalies */
  getActiveAnomalies(): AnomalyRecord[] {
    return this.anomalies.filter((a) => !a.resolved);
  }

  // ── Robustness Scoring ──────────────────────────────────

  /**
   * Calculate a robustness score based on recovery success,
   * error pattern resolution, and system stability.
   */
  getRobustnessScore(): {
    score: number; // 0-100
    recoveryRate: number;
    patternResolutionRate: number;
    stabilityDays: number;
  } {
    const totalErrors = this.errorPatterns.reduce((sum, p) => sum + p.count, 0);
    const resolvedErrors = this.errorPatterns
      .filter((p) => p.resolved)
      .reduce((sum, p) => sum + p.count, 0);

    const recoveryRate = totalErrors > 0
      ? resolvedErrors / totalErrors
      : 1;

    const patternResolutionRate = this.errorPatterns.length > 0
      ? this.errorPatterns.filter((p) => p.resolved).length / this.errorPatterns.length
      : 1;

    const oldestResolved = this.errorPatterns
      .filter((p) => p.resolved)
      .map((p) => p.lastSeen)
      .sort()[0];

    const stabilityDays = oldestResolved
      ? (Date.now() - oldestResolved) / (24 * 3600_000)
      : 0;

    const score = Math.round(
      (recoveryRate * 40 + patternResolutionRate * 30 + Math.min(stabilityDays / 7, 1) * 30)
    );

    return { score, recoveryRate, patternResolutionRate, stabilityDays };
  }

  // ── Lifecycle ───────────────────────────────────────────

  /** Start periodic health checks */
  startHealthChecks(assessFn: () => Record<string, { healthy: boolean; score?: number }>): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(() => {
      const components = assessFn();
      this.assessHealth(components);
    }, this.config.healthCheckIntervalMs);
  }

  /** Stop periodic health checks */
  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /** Clean shutdown */
  shutdown(): void {
    this.stopHealthChecks();
    for (const [, circuit] of this.circuitState) {
      if (circuit.resetTimer) clearTimeout(circuit.resetTimer);
    }
    this.removeAllListeners();
  }

  // ── Internal ────────────────────────────────────────────

  private buildErrorSignature(error: Error, context?: Record<string, unknown>): string {
    const parts = [
      error.name,
      this.extractPattern(error.message),
      context?.provider ?? "",
      context?.toolName ?? "",
    ];
    return parts.join("::").slice(0, 200);
  }

  private extractPattern(message: string): string {
    // Remove specific values, keep structure
    return message
      .replace(/\d+/g, "<N>")
      .replace(/[0-9a-f]{8,}/gi, "<ID>")
      .replace(/https?:\/\/\S+/g, "<URL>")
      .slice(0, 150);
  }

  private classifyError(error: Error): ErrorPattern["type"] {
    const msg = error.message.toLowerCase();

    if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
    if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized") || msg.includes("invalid api key")) return "auth";
    if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) return "rate_limit";
    if (msg.includes("context") && (msg.includes("length") || msg.includes("tokens") || msg.includes("overflow"))) return "context_overflow";
    if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("network") || msg.includes("fetch failed")) return "network";
    if (msg.includes("parse") || msg.includes("json") || msg.includes("syntax")) return "parsing";
    if (msg.includes("validation") || msg.includes("invalid") || msg.includes("required")) return "validation";
    if (msg.includes("sigterm") || msg.includes("sigkill") || msg.includes("oom") || msg.includes("memory")) return "system";

    return "unknown";
  }

  private recommendRecovery(type: ErrorPattern["type"]): RecoveryStrategy {
    switch (type) {
      case "network": return "retry";
      case "timeout": return "retry";
      case "auth": return "escalate";
      case "rate_limit": return "retry";
      case "context_overflow": return "graceful_degrade";
      case "parsing": return "fallback";
      case "validation": return "graceful_degrade";
      case "system": return "reinitialize";
      default: return "fallback";
    }
  }

  private recordCircuitFailure(key: string): void {
    let circuit = this.circuitState.get(key);
    if (!circuit) {
      circuit = { open: false, failures: 0, lastFailure: 0 };
      this.circuitState.set(key, circuit);
    }

    circuit.failures++;
    circuit.lastFailure = Date.now();

    if (circuit.failures >= this.config.circuitBreakerThreshold) {
      circuit.open = true;
      this.emit("circuit-opened", { key, failures: circuit.failures });

      // Auto-reset after timeout
      if (circuit.resetTimer) clearTimeout(circuit.resetTimer);
      circuit.resetTimer = setTimeout(() => {
        circuit.open = false;
        circuit.failures = 0;
        this.emit("circuit-reset", { key });
      }, this.config.circuitResetTimeoutMs);
    }
  }

  private recordCircuitSuccess(key: string): void {
    const circuit = this.circuitState.get(key);
    if (circuit) {
      circuit.failures = 0;
      circuit.open = false;
    }
  }

  private createAnomaly(
    type: AnomalyRecord["type"],
    severity: AnomalyRecord["severity"],
    description: string
  ): AnomalyRecord {
    return {
      id: `anom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type,
      severity,
      description,
      detectedAt: Date.now(),
      resolved: false,
    };
  }

  /** Get all recorded error patterns (for testing/inspection) */
  getErrorPatterns(): ErrorPattern[] {
    return [...this.errorPatterns];
  }

  private averageScore(scores: Record<string, number>, keys: string[]): number {
    const matching = keys
      .map((k) => scores[k])
      .filter((s): s is number => s !== undefined);

    if (matching.length === 0) return 100;
    return Math.round(matching.reduce((a, b) => a + b, 0) / matching.length);
  }
}