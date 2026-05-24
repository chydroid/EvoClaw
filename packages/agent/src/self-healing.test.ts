import { describe, it, expect, beforeEach } from "vitest";
import { SelfHealingEngine } from "../src/self-healing";
import type { ErrorPattern } from "../src/self-healing";

describe("SelfHealingEngine", () => {
  let engine: SelfHealingEngine;

  beforeEach(() => {
    engine = new SelfHealingEngine({
      maxRetries: 3,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 5000,
      circuitBreakerThreshold: 3,
      circuitResetTimeoutMs: 5000,
    });
  });

  // ── Error Pattern Learning ──────────────────────────────

  describe("error pattern learning", () => {
    it("should record and classify network errors", () => {
      const pattern = engine.recordError(
        new Error("fetch failed: ECONNREFUSED"),
        { provider: "openai" }
      );

      expect(pattern.type).toBe("network");
      expect(pattern.count).toBe(1);
    });

    it("should record and classify timeout errors", () => {
      const pattern = engine.recordError(
        new Error("Request timed out after 30000ms"),
        { provider: "anthropic" }
      );

      expect(pattern.type).toBe("timeout");
    });

    it("should record and classify auth errors", () => {
      const pattern = engine.recordError(
        new Error("401 Unauthorized: Invalid API key")
      );

      expect(pattern.type).toBe("auth");
    });

    it("should record and classify rate limit errors", () => {
      const pattern = engine.recordError(
        new Error("429 Too Many Requests: Rate limit exceeded")
      );

      expect(pattern.type).toBe("rate_limit");
    });

    it("should record and classify context overflow", () => {
      const pattern = engine.recordError(
        new Error("Context length exceeded: maximum 128000 tokens")
      );

      expect(pattern.type).toBe("context_overflow");
    });

    it("should recognize repeated error patterns", () => {
      for (let i = 0; i < 5; i++) {
        engine.recordError(
          new Error("fetch failed: ECONNREFUSED"),
          { provider: "openai" }
        );
      }

      const patterns = engine.getErrorPatterns();
      // Should be one pattern with count 5 (not 5 separate patterns)
      const networkPatterns = patterns.filter((p: ErrorPattern) => p.type === "network");
      expect(networkPatterns.length).toBe(1);
      expect(networkPatterns[0].count).toBe(5);
    });

    it("should extract normalized error patterns", () => {
      engine.recordError(new Error("Request timed out after 12345ms"));
      engine.recordError(new Error("Request timed out after 67890ms"));

      const patterns = engine.getErrorPatterns();
      const timeoutPatterns = patterns.filter((p: ErrorPattern) => p.type === "timeout");
      expect(timeoutPatterns.length).toBe(1);
      expect(timeoutPatterns[0].count).toBe(2);
    });

    it("should track recovery success rate", () => {
      const pattern = engine.recordError(
        new Error("fetch failed: ECONNREFUSED")
      );

      engine.recordRecovery(pattern.signature, true);
      engine.recordRecovery(pattern.signature, false);

      // Re-fetch the pattern
      const updated = engine.getErrorPatterns().find((p: ErrorPattern) => p.signature === pattern.signature);
      expect(updated).toBeDefined();
      expect(updated!.recoverySuccessRate).toBe(0.5);
    });
  });

  // ── Recovery Strategy Recommendation ────────────────────

  describe("recovery recommendation", () => {
    it("should recommend retry for network errors", () => {
      const strategy = engine.getRecovery(new Error("fetch failed: ECONNREFUSED"));
      expect(strategy).toBe("retry");
    });

    it("should recommend graceful_degrade for context overflow", () => {
      const strategy = engine.getRecovery(new Error("context length exceeded"));
      expect(strategy).toBe("graceful_degrade");
    });

    it("should recommend escalate for auth errors", () => {
      const strategy = engine.getRecovery(new Error("401 Unauthorized"));
      expect(strategy).toBe("escalate");
    });

    it("should recommend fallback for unknown errors", () => {
      const strategy = engine.getRecovery(new Error("something weird happened"));
      expect(strategy).toBe("fallback");
    });
  });

  // ── Auto-Recovery Execution ─────────────────────────────

  describe("auto-recovery execution", () => {
    it("should execute successfully on first attempt", async () => {
      const result = await engine.executeWithRecovery(
        async () => "success"
      );

      expect(result.result).toBe("success");
      expect(result.recovered).toBe(false);
      expect(result.attempts).toBe(1);
    });

    it("should retry on failure and succeed", async () => {
      let attempts = 0;
      const result = await engine.executeWithRecovery(
        async () => {
          attempts++;
          if (attempts < 2) throw new Error("Temporary error");
          return "recovered";
        },
        { maxRetries: 3 }
      );

      expect(result.result).toBe("recovered");
      expect(result.recovered).toBe(true);
      expect(result.attempts).toBe(2);
    });

    it("should give up after max retries", async () => {
      const result = await engine.executeWithRecovery(
        async () => { throw new Error("Persistent error"); },
        { maxRetries: 2 }
      );

      expect(result.result).toBeNull();
      expect(result.recovered).toBe(false);
      expect(result.attempts).toBe(3); // initial + 2 retries
      expect(result.error).toBeDefined();
    });

    it("should use fallback when available", async () => {
      const result = await engine.executeWithRecovery(
        async () => { throw new Error("Primary failed"); },
        {
          maxRetries: 0,
          recoveryHints: {
            fallback: async () => "fallback result",
          },
        }
      );

      expect(result.result).toBe("fallback result");
      expect(result.recovered).toBe(true);
      expect(result.strategy).toBe("fallback");
    });

    it("should use cache_serve when available", async () => {
      const result = await engine.executeWithRecovery(
        async () => { throw new Error("Primary failed"); },
        {
          maxRetries: 0,
          recoveryHints: {
            cache_serve: async () => "cached result",
          },
        }
      );

      expect(result.result).toBe("cached result");
      expect(result.recovered).toBe(true);
      expect(result.strategy).toBe("cache_serve");
    });
  });

  // ── Circuit Breaker ─────────────────────────────────────

  describe("circuit breaker", () => {
    it("should open circuit after threshold failures", async () => {
      for (let i = 0; i < 5; i++) {
        await engine.executeWithRecovery(
          async () => { throw new Error("Boom"); },
          { provider: "test-provider", maxRetries: 0 }
        );
      }

      // Next call should fail with circuit open
      const result = await engine.executeWithRecovery(
        async () => "should not run",
        {
          provider: "test-provider",
          maxRetries: 0,
          recoveryHints: {
            fallback: async () => "fallback from circuit",
          },
        }
      );

      expect(result.result).toBe("fallback from circuit");
    });
  });

  // ── Adaptive Mutation Strategies ────────────────────────

  describe("adaptive mutation", () => {
    it("should adjust mutation rates based on outcomes", () => {
      engine.recordMutationOutcome("prompt_rewrite", true);
      const strategies = engine.getMutationStrategies();
      const pr = strategies.find((s) => s.name === "prompt_rewrite");
      expect(pr).toBeDefined();
      expect(pr!.successRate).toBe(1);
      expect(pr!.rate).toBeGreaterThan(0.3); // Increased from default 0.3
    });

    it("should decrease rate on failure", () => {
      engine.recordMutationOutcome("temperature_tune", false);
      engine.recordMutationOutcome("temperature_tune", false);
      const strategies = engine.getMutationStrategies();
      const tt = strategies.find((s) => s.name === "temperature_tune");
      expect(tt).toBeDefined();
      expect(tt!.rate).toBeLessThan(0.15); // Decreased from default 0.15
    });

    it("should respect min/max rate bounds", () => {
      for (let i = 0; i < 50; i++) {
        engine.recordMutationOutcome("prompt_rewrite", true);
      }
      const strategies = engine.getMutationStrategies();
      const pr = strategies.find((s) => s.name === "prompt_rewrite");
      expect(pr!.rate).toBeLessThanOrEqual(pr!.maxRate);
    });

    it("should return best performing mutation", () => {
      engine.recordMutationOutcome("prompt_rewrite", true);
      engine.recordMutationOutcome("temperature_tune", false);
      engine.recordMutationOutcome("tool_reorder", true);
      engine.recordMutationOutcome("tool_reorder", true);

      const best = engine.getBestMutation();
      expect(best.successRate).toBeGreaterThanOrEqual(0.5);
    });
  });

  // ── Health Scoring ──────────────────────────────────────

  describe("health scoring", () => {
    it("should assess overall health", () => {
      engine.assessHealth({
        openai: { healthy: true, score: 100 },
        anthropic: { healthy: true, score: 90 },
        memory: { healthy: true, score: 80 },
        telegram: { healthy: false, score: 0 },
      });

      const health = engine.getHealthScore();
      expect(health.overall).toBeGreaterThan(0);
      expect(health.overall).toBeLessThan(100); // Telegram is down
      expect(health.components["openai"]).toBe(100);
      expect(health.components["telegram"]).toBe(0);
    });

    it("should detect critical health", () => {
      engine.assessHealth({
        openai: { healthy: false, score: 0 },
        anthropic: { healthy: false, score: 0 },
        memory: { healthy: false, score: 10 },
      });

      expect(engine.needsRecovery()).toBe(true);
    });

    it("should detect healthy state", () => {
      engine.assessHealth({
        openai: { healthy: true, score: 100 },
      });

      expect(engine.needsRecovery()).toBe(false);
    });
  });

  // ── Anomaly Detection ───────────────────────────────────

  describe("anomaly detection", () => {
    it("should detect latency spikes", () => {
      const anomalies = engine.detectAnomalies({
        avgLatencyMs: 5000,
        errorRate: 0.05,
        tokenUsageGrowth: 1.0,
        toolCallCount: 3,
        responseLength: 500,
        baselineLatencyMs: 500,
        baselineErrorRate: 0.02,
      });

      const latency = anomalies.find((a) => a.type === "latency_spike");
      expect(latency).toBeDefined();
      expect(latency!.severity).toBe("high"); // 10x baseline
    });

    it("should detect error rate spikes", () => {
      const anomalies = engine.detectAnomalies({
        avgLatencyMs: 500,
        errorRate: 0.8,
        tokenUsageGrowth: 1.0,
        toolCallCount: 2,
        responseLength: 300,
        baselineLatencyMs: 500,
        baselineErrorRate: 0.05,
      });

      const errorAnom = anomalies.find((a) => a.type === "error_rate");
      expect(errorAnom).toBeDefined();
      expect(errorAnom!.severity).toBe("critical");
    });

    it("should detect tool loops", () => {
      const anomalies = engine.detectAnomalies({
        avgLatencyMs: 500,
        errorRate: 0.01,
        tokenUsageGrowth: 1.0,
        toolCallCount: 25,
        responseLength: 300,
        baselineLatencyMs: 500,
        baselineErrorRate: 0.02,
      });

      const toolLoop = anomalies.find((a) => a.type === "tool_loop");
      expect(toolLoop).toBeDefined();
    });

    it("should not flag normal metrics", () => {
      const anomalies = engine.detectAnomalies({
        avgLatencyMs: 500,
        errorRate: 0.02,
        tokenUsageGrowth: 1.0,
        toolCallCount: 3,
        responseLength: 500,
        baselineLatencyMs: 500,
        baselineErrorRate: 0.02,
      });

      expect(anomalies.length).toBe(0);
    });

    it("should track and resolve anomalies", () => {
      const anomalies = engine.detectAnomalies({
        avgLatencyMs: 3000,
        errorRate: 0.05,
        tokenUsageGrowth: 1.5,
        toolCallCount: 5,
        responseLength: 300,
        baselineLatencyMs: 500,
        baselineErrorRate: 0.02,
      });

      expect(engine.getActiveAnomalies().length).toBeGreaterThan(0);

      for (const a of anomalies) {
        engine.resolveAnomaly(a.id, "Fixed deployment");
      }

      expect(engine.getActiveAnomalies().length).toBe(0);
    });
  });

  // ── Robustness Scoring ──────────────────────────────────

  describe("robustness scoring", () => {
    it("should calculate robustness score", () => {
      const pattern = engine.recordError(new Error("Test error"));
      engine.recordRecovery(pattern.signature, true);

      const score = engine.getRobustnessScore();
      expect(score.score).toBeGreaterThan(0);
      expect(score.recoveryRate).toBeGreaterThan(0);
    });
  });

  // ── Lifecycle ───────────────────────────────────────────

  describe("lifecycle", () => {
    it("should start and stop health checks", () => {
      engine.startHealthChecks(() => ({
        test: { healthy: true, score: 100 },
      }));
      engine.stopHealthChecks();
      // Should not throw
    });

    it("should shutdown cleanly", () => {
      engine.shutdown();
      // Should not throw
    });
  });
});