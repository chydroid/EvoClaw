import { describe, it, expect, beforeEach } from "vitest";
import { Observability } from "../src/observability";

describe("Observability", () => {
  let obs: Observability;

  beforeEach(() => {
    obs = new Observability({ metricsPrefix: "test" });
  });

  // ── Metric Registration ─────────────────────────────────

  describe("metric registration", () => {
    it("should register a metric definition", () => {
      obs.registerMetric({ name: "test_counter", type: "counter", help: "Test counter" });
      // Registration should not throw
    });
  });

  // ── Counters ────────────────────────────────────────────

  describe("counters", () => {
    it("should increment a counter from 0", () => {
      obs.counterIncrement("test_counter");
      expect(obs.counterGet("test_counter")).toBe(1);
    });

    it("should increment by custom amount", () => {
      obs.counterIncrement("test_counter", [], 5);
      expect(obs.counterGet("test_counter")).toBe(5);
    });

    it("should maintain separate values per label set", () => {
      obs.counterIncrement("test_counter", [{ key: "status", value: "ok" }]);
      obs.counterIncrement("test_counter", [{ key: "status", value: "error" }], 3);
      expect(obs.counterGet("test_counter", [{ key: "status", value: "ok" }])).toBe(1);
      expect(obs.counterGet("test_counter", [{ key: "status", value: "error" }])).toBe(3);
    });

    it("should return 0 for unknown counter", () => {
      expect(obs.counterGet("nonexistent")).toBe(0);
    });
  });

  // ── Gauges ──────────────────────────────────────────────

  describe("gauges", () => {
    it("should set and get gauge values", () => {
      obs.gaugeSet("test_gauge", 42);
      expect(obs.gaugeGet("test_gauge")).toBe(42);
    });

    it("should adjust gauge values", () => {
      obs.gaugeSet("test_gauge", 10);
      obs.gaugeAdjust("test_gauge", 5);
      expect(obs.gaugeGet("test_gauge")).toBe(15);
      obs.gaugeAdjust("test_gauge", -3);
      expect(obs.gaugeGet("test_gauge")).toBe(12);
    });

    it("should return 0 for unknown gauge", () => {
      expect(obs.gaugeGet("nonexistent")).toBe(0);
    });

    it("should support labeled gauges", () => {
      obs.gaugeSet("test_gauge", 100, [{ key: "region", value: "us" }]);
      obs.gaugeSet("test_gauge", 200, [{ key: "region", value: "eu" }]);
      expect(obs.gaugeGet("test_gauge", [{ key: "region", value: "us" }])).toBe(100);
      expect(obs.gaugeGet("test_gauge", [{ key: "region", value: "eu" }])).toBe(200);
    });
  });

  // ── Histograms ──────────────────────────────────────────

  describe("histograms", () => {
    it("should record observations", () => {
      obs.histogramObserve("test_hist", 50);
      obs.histogramObserve("test_hist", 100);
      obs.histogramObserve("test_hist", 150);
      expect(obs.histogramCount("test_hist")).toBe(3);
      expect(obs.histogramSum("test_hist")).toBe(300);
    });

    it("should calculate percentiles", () => {
      for (let i = 0; i < 100; i++) {
        obs.histogramObserve("test_hist", i);
      }
      expect(obs.histogramPercentile("test_hist", 50)).toBeGreaterThanOrEqual(49);
      expect(obs.histogramPercentile("test_hist", 90)).toBeGreaterThanOrEqual(89);
      expect(obs.histogramPercentile("test_hist", 99)).toBeGreaterThanOrEqual(98);
    });

    it("should return 0 for empty histogram", () => {
      expect(obs.histogramPercentile("nonexistent", 50)).toBe(0);
      expect(obs.histogramCount("nonexistent")).toBe(0);
      expect(obs.histogramSum("nonexistent")).toBe(0);
    });
  });

  // ── Convenience: Request Metrics ────────────────────────

  describe("request metrics", () => {
    it("should record request latency with status", () => {
      obs.recordRequestLatency("/api/test", "GET", 200, 45);
      obs.recordRequestLatency("/api/test", "GET", 500, 200);

      const labelsOk = [
        { key: "endpoint", value: "/api/test" },
        { key: "method", value: "GET" },
        { key: "status", value: "200" },
      ];
      const labelsErr = [
        { key: "endpoint", value: "/api/test" },
        { key: "method", value: "GET" },
        { key: "status", value: "500" },
      ];

      expect(obs.counterGet("test_requests_total", labelsOk)).toBe(1);
      expect(obs.counterGet("test_requests_total", labelsErr)).toBe(1);
      expect(obs.counterGet("test_request_errors_total", labelsErr)).toBe(1);
      expect(obs.histogramCount("test_request_duration_ms", labelsOk)).toBe(1);
    });
  });

  describe("LLM metrics", () => {
    it("should record LLM call metrics", () => {
      obs.recordLLMCall("openai", "gpt-4o", 500, 1200, true);
      obs.recordLLMCall("anthropic", "claude-sonnet-4", 300, 800, false);

      const openaiLabels = [
        { key: "provider", value: "openai" },
        { key: "model", value: "gpt-4o" },
        { key: "status", value: "success" },
      ];

      expect(obs.counterGet("test_llm_calls_total", openaiLabels)).toBe(1);
      expect(obs.counterGet("test_llm_tokens_total", openaiLabels)).toBe(500);
    });
  });

  describe("tool metrics", () => {
    it("should record tool call metrics", () => {
      obs.recordToolCall("search", true, 300);
      obs.recordToolCall("code_exec", false, 500);

      const searchLabels = [
        { key: "tool", value: "search" },
        { key: "status", value: "success" },
      ];
      expect(obs.counterGet("test_tool_calls_total", searchLabels)).toBe(1);
      expect(obs.histogramCount("test_tool_latency_ms", searchLabels)).toBe(1);
    });
  });

  // ── Tracing ─────────────────────────────────────────────

  describe("tracing", () => {
    it("should create and end spans", () => {
      const span = obs.startSpan("test_operation");
      expect(span.name).toBe("test_operation");
      expect(span.status).toBe("unset");
      expect(span.traceId).toBeTruthy();
      expect(span.spanId).toBeTruthy();

      obs.addSpanEvent(span.spanId, "started");
      obs.setSpanAttribute(span.spanId, "key", "value");

      const ended = obs.endSpan(span.spanId);
      expect(ended).not.toBeNull();
      expect(ended!.status).toBe("ok");
      expect(ended!.duration).toBeGreaterThanOrEqual(0);
      expect(ended!.events.length).toBe(1);
      expect(ended!.attributes["key"]).toBe("value");
    });

    it("should mark span as error when error provided", () => {
      const span = obs.startSpan("failing_op");
      const ended = obs.endSpan(span.spanId, new Error("Boom"));
      expect(ended?.status).toBe("error");
      expect(ended?.attributes["error.message"]).toBe("Boom");
    });

    it("should reuse trace ID from parent", () => {
      const parent = obs.startSpan("parent");
      const child = obs.startSpan("child", parent.spanId);
      expect(child.traceId).toBe(parent.traceId);
      expect(child.parentSpanId).toBe(parent.spanId);
    });

    it("should retrieve span by ID", () => {
      const span = obs.startSpan("findable");
      expect(obs.getSpan(span.spanId)).toBeDefined();
      obs.endSpan(span.spanId);
      expect(obs.getSpan(span.spanId)).toBeDefined();
    });

    it("should get spans by trace ID", () => {
      const s1 = obs.startSpan("op1");
      const s2 = obs.startSpan("op2", s1.spanId);
      obs.endSpan(s1.spanId);
      obs.endSpan(s2.spanId);

      const traceSpans = obs.getSpansByTrace(s1.traceId);
      expect(traceSpans.length).toBe(2);
    });
  });

  // ── Health ──────────────────────────────────────────────

  describe("health", () => {
    it("should register and update health components", () => {
      obs.registerHealthComponent("database");
      obs.setComponentHealth("database", "up");
      obs.setComponentHealth("cache", "degraded", "Slow response");

      const report = obs.getHealthReport();
      expect(report.status).toBe("degraded");
      expect(report.components.length).toBe(2);
      expect(report.components[0].name).toBe("database");
      expect(report.components[0].status).toBe("up");
      expect(report.uptimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should report healthy when all components up", () => {
      obs.registerHealthComponent("db");
      obs.setComponentHealth("db", "up");
      expect(obs.getHealthReport().status).toBe("healthy");
    });

    it("should report unhealthy when a component is down", () => {
      obs.registerHealthComponent("api");
      obs.setComponentHealth("api", "down", "Connection refused");
      expect(obs.getHealthReport().status).toBe("unhealthy");
    });

    it("should include metrics in health report", () => {
      obs.recordRequestLatency("/api", "GET", 200, 100);
      const report = obs.getHealthReport();
      expect(report.metrics.totalRequests).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Prometheus Export ───────────────────────────────────

  describe("prometheus export", () => {
    it("should export metrics in Prometheus format", () => {
      obs.registerMetric({ name: "test_requests_total", type: "counter", help: "Total requests" });
      obs.recordRequestLatency("/api", "GET", 200, 50);
      obs.gaugeSet("test_active_sessions", 5);

      const output = obs.exportPrometheus();
      expect(output).toContain("# HELP");
      expect(output).toContain("test_requests_total");
      expect(output).toContain("test_process_memory_bytes");
      expect(output).toContain("test_process_uptime_seconds");
      expect(output).not.toContain("undefined");
    });

    it("should include histogram buckets", () => {
      obs.histogramObserve("test_latency", 25);
      obs.histogramObserve("test_latency", 75);
      const output = obs.exportPrometheus();
      expect(output).toContain("_bucket");
      expect(output).toContain("_sum");
      expect(output).toContain("_count");
    });
  });

  // ── Reset ───────────────────────────────────────────────

  describe("reset", () => {
    it("should clear all metrics on reset", () => {
      obs.counterIncrement("test", [], 10);
      obs.gaugeSet("test", 50);
      obs.histogramObserve("test", 100);
      obs.reset();

      expect(obs.counterGet("test")).toBe(0);
      expect(obs.gaugeGet("test")).toBe(0);
      expect(obs.histogramCount("test")).toBe(0);
    });
  });
});