/**
 * Observability Infrastructure — structured metrics, tracing, and health
 * endpoints for Prometheus / Grafana / OTEL integration.
 *
 * Features:
 *  - Counter / Gauge / Histogram metric types
 *  - Prometheus text exposition format
 *  - Label-based metric scoping
 *  - OTEL-compatible trace ID generation
 *  - Structured span tracing with timing
 *  - System health aggregation endpoint
 *  - Latency percentile tracking (P50/P90/P99)
 *  - Throughput and error rate monitoring
 */

import { randomBytes } from "crypto";
import { TracingService, type TracingConfig } from "./tracing";
import { SpanStatusCode, type Span } from "@opentelemetry/api";

// ── Types ─────────────────────────────────────────────────

export type MetricType = "counter" | "gauge" | "histogram";

export interface MetricLabel {
  key: string;
  value: string;
}

export interface MetricDef {
  name: string;
  type: MetricType;
  help: string;
  labels?: string[];
}

export interface MetricValue {
  value: number;
  labels: MetricLabel[];
  timestamp: number;
}

export interface HistogramBucket {
  le: number; // upper bound
  count: number;
}

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: "ok" | "error" | "unset";
  attributes: Record<string, string | number | boolean>;
  events: Array<{ name: string; timestamp: number; attributes?: Record<string, string | number | boolean> }>;
}

export interface HealthReport {
  status: "healthy" | "degraded" | "unhealthy";
  uptimeMs: number;
  metrics: {
    totalRequests: number;
    errorRate: number;
    avgLatencyMs: number;
    p50LatencyMs: number;
    p90LatencyMs: number;
    p99LatencyMs: number;
    activeSessions: number;
  };
  components: Array<{
    name: string;
    status: "up" | "down" | "degraded";
    message?: string;
    lastCheck: number;
  }>;
}

export interface ObservabilityConfig {
  /** Metrics prefix for Prometheus */
  metricsPrefix?: string;
  /** Max trace spans to keep in memory */
  maxTraceSpans?: number;
  /** Histogram bucket boundaries (ms) */
  latencyBuckets?: number[];
  /** Whether to include process metrics */
  includeProcessMetrics?: boolean;
}

// ── Observable Class ──────────────────────────────────────

export class Observability {
  private counters = new Map<string, Map<string, number>>();
  private gauges = new Map<string, Map<string, number>>();
  private histograms = new Map<string, Map<string, number[]>>();
  private metricDefs = new Map<string, MetricDef>();
  private spans: TraceSpan[] = [];
  private activeSpans = new Map<string, TraceSpan>();
  private otelSpans = new Map<string, Span>();
  private tracingService: TracingService;
  private config: Required<ObservabilityConfig>;
  private startTime: number;
  private maxLabelCardinality = 1000;
  private healthComponents = new Map<string, { status: HealthReport["components"][0]["status"]; message?: string; lastCheck: number }>();

  constructor(config: ObservabilityConfig = {}) {
    this.config = {
      metricsPrefix: config.metricsPrefix ?? "evoclaw",
      maxTraceSpans: config.maxTraceSpans ?? 1000,
      latencyBuckets: config.latencyBuckets ?? [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
      includeProcessMetrics: config.includeProcessMetrics ?? true,
    };
    this.startTime = Date.now();
    this.tracingService = new TracingService({
      serviceName: this.config.metricsPrefix,
      enabled: true,
    });
  }

  /** Get the TracingService instance for OpenTelemetry-compatible span tracing */
  getTracingService(): TracingService {
    return this.tracingService;
  }

  // ── Metric Registration ─────────────────────────────────

  registerMetric(def: MetricDef): void {
    // 限制外层 metric 数量，防止无限制增长
    if (this.metricDefs.size >= 256) {
      process.stderr.write(`[Observability] Metric count exceeded cap (256), rejecting new metric: ${def.name}\n`);
      return;
    }
    this.metricDefs.set(def.name, def);
  }

  // ── Counters ────────────────────────────────────────────

  /** 限制每个 metric 的 label 组合数，防止高基数 label 导致 Map 无限增长 */
  private trimLabelCardinality(map: Map<string, unknown>, metricName: string): void {
    if (map.size > this.maxLabelCardinality) {
      const keys = Array.from(map.keys()).slice(0, map.size - this.maxLabelCardinality);
      for (const k of keys) map.delete(k);
      process.stderr.write(`[Observability] Label cardinality exceeded cap for metric "${metricName}", evicted ${keys.length} entries\n`);
    }
  }

  counterIncrement(name: string, labels: MetricLabel[] = [], inc = 1): void {
    const key = this.labelKey(name, labels);
    if (!this.counters.has(name)) this.counters.set(name, new Map());
    const map = this.counters.get(name)!;
    const current = map.get(key) ?? 0;
    // delete + set 使该 label 移到 Map 末尾，实现真正 LRU（最近访问顺序）
    map.delete(key);
    map.set(key, current + inc);
    this.trimLabelCardinality(map, name);
  }

  counterGet(name: string, labels: MetricLabel[] = []): number {
    const key = this.labelKey(name, labels);
    return this.counters.get(name)?.get(key) ?? 0;
  }

  // ── Gauges ──────────────────────────────────────────────

  gaugeSet(name: string, value: number, labels: MetricLabel[] = []): void {
    const key = this.labelKey(name, labels);
    if (!this.gauges.has(name)) this.gauges.set(name, new Map());
    const map = this.gauges.get(name)!;
    // delete + set 使该 label 移到 Map 末尾，实现真正 LRU（最近访问顺序）
    map.delete(key);
    map.set(key, value);
    this.trimLabelCardinality(map, name);
  }

  gaugeGet(name: string, labels: MetricLabel[] = []): number {
    const key = this.labelKey(name, labels);
    return this.gauges.get(name)?.get(key) ?? 0;
  }

  gaugeAdjust(name: string, delta: number, labels: MetricLabel[] = []): void {
    const key = this.labelKey(name, labels);
    if (!this.gauges.has(name)) this.gauges.set(name, new Map());
    const map = this.gauges.get(name)!;
    const current = map.get(key) ?? 0;
    // delete + set 使该 label 移到 Map 末尾，实现真正 LRU（最近访问顺序）
    map.delete(key);
    map.set(key, current + delta);
    this.trimLabelCardinality(map, name);
  }

  // ── Histograms ──────────────────────────────────────────

  histogramObserve(name: string, value: number, labels: MetricLabel[] = []): void {
    const key = this.labelKey(name, labels);
    if (!this.histograms.has(name)) this.histograms.set(name, new Map());
    const map = this.histograms.get(name)!;
    const values = map.get(key) ?? [];
    values.push(value);
    // Keep last 10000 observations per (name, labels) to bound memory
    if (values.length > 10000) {
      values.splice(0, values.length - 10000);
    }
    // delete + set 使该 label 移到 Map 末尾，实现真正 LRU（最近访问顺序）
    map.delete(key);
    map.set(key, values);
    // 与 counter/gauge 一致：限制 label 组合数防止高基数 label 导致 Map 无限增长
    this.trimLabelCardinality(map, name);
  }

  histogramPercentile(name: string, percentile: number, labels: MetricLabel[] = []): number {
    const key = this.labelKey(name, labels);
    const values = this.histograms.get(name)?.get(key) ?? [];
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * percentile / 100) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
  }

  histogramCount(name: string, labels: MetricLabel[] = []): number {
    const key = this.labelKey(name, labels);
    return this.histograms.get(name)?.get(key)?.length ?? 0;
  }

  histogramSum(name: string, labels: MetricLabel[] = []): number {
    const key = this.labelKey(name, labels);
    return this.histograms.get(name)?.get(key)?.reduce((a, b) => a + b, 0) ?? 0;
  }

  // ── Convenience: Request Metrics ────────────────────────

  recordRequestLatency(endpoint: string, method: string, statusCode: number, latencyMs: number): void {
    const labels = [
      { key: "endpoint", value: endpoint },
      { key: "method", value: method },
      { key: "status", value: String(statusCode) },
    ];

    this.counterIncrement(`${this.config.metricsPrefix}_requests_total`, labels);
    this.histogramObserve(`${this.config.metricsPrefix}_request_duration_ms`, latencyMs, labels);

    if (statusCode >= 400) {
      this.counterIncrement(`${this.config.metricsPrefix}_request_errors_total`, labels);
    }
  }

  recordLLMCall(provider: string, model: string, tokens: number, latencyMs: number, success: boolean): void {
    const labels = [
      { key: "provider", value: provider },
      { key: "model", value: model },
      { key: "status", value: success ? "success" : "error" },
    ];

    this.counterIncrement(`${this.config.metricsPrefix}_llm_calls_total`, labels);
    this.counterIncrement(`${this.config.metricsPrefix}_llm_tokens_total`, labels, tokens);
    this.histogramObserve(`${this.config.metricsPrefix}_llm_latency_ms`, latencyMs, labels);

    if (!success) {
      this.counterIncrement(`${this.config.metricsPrefix}_llm_errors_total`, labels);
    }
  }

  recordToolCall(toolName: string, success: boolean, latencyMs: number): void {
    const labels = [
      { key: "tool", value: toolName },
      { key: "status", value: success ? "success" : "error" },
    ];

    this.counterIncrement(`${this.config.metricsPrefix}_tool_calls_total`, labels);
    this.histogramObserve(`${this.config.metricsPrefix}_tool_latency_ms`, latencyMs, labels);
  }

  // ── Tracing ─────────────────────────────────────────────

  startSpan(name: string, parentSpanId?: string, attributes?: Record<string, string | number | boolean>): TraceSpan {
    const span: TraceSpan = {
      traceId: parentSpanId
        ? this.activeSpans.get(parentSpanId)?.traceId ?? this.generateTraceId()
        : this.generateTraceId(),
      spanId: this.generateSpanId(),
      parentSpanId,
      name,
      startTime: Date.now(),
      status: "unset",
      attributes: attributes ?? {},
      events: [],
    };

    this.activeSpans.set(span.spanId, span);

    // Also create an OTEL span via TracingService
    const parentOtelSpan = parentSpanId ? this.otelSpans.get(parentSpanId) : undefined;
    const otelSpan = this.tracingService.startSpan(name, {
      attributes: attributes,
      parentSpan: parentOtelSpan,
    });
    this.otelSpans.set(span.spanId, otelSpan);

    return span;
  }

  addSpanEvent(spanId: string, name: string, attributes?: Record<string, string | number | boolean>): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.events.push({ name, timestamp: Date.now(), attributes });
    }
  }

  setSpanAttribute(spanId: string, key: string, value: string | number | boolean): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.attributes[key] = value;
    }
  }

  endSpan(spanId: string, error?: Error): TraceSpan | null {
    const span = this.activeSpans.get(spanId);
    if (!span) return null;

    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.status = error ? "error" : "ok";

    if (error) {
      span.attributes["error.message"] = error.message;
      span.attributes["error.type"] = error.name;
    }

    // End the corresponding OTEL span
    const otelSpan = this.otelSpans.get(spanId);
    if (otelSpan) {
      if (error) {
        otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        otelSpan.recordException(error);
      } else {
        otelSpan.setStatus({ code: SpanStatusCode.OK });
      }
      otelSpan.end();
      this.otelSpans.delete(spanId);
    }

    this.activeSpans.delete(spanId);
    this.spans.push(span);

    // Trim old spans
    if (this.spans.length > this.config.maxTraceSpans) {
      this.spans.splice(0, this.spans.length - this.config.maxTraceSpans);
    }

    return span;
  }

  getSpan(spanId: string): TraceSpan | undefined {
    return this.activeSpans.get(spanId) ?? this.spans.find((s) => s.spanId === spanId);
  }

  getSpansByTrace(traceId: string): TraceSpan[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }

  // ── Health ──────────────────────────────────────────────

  registerHealthComponent(name: string): void {
    this.healthComponents.set(name, { status: "up", lastCheck: Date.now() });
  }

  setComponentHealth(name: string, status: HealthReport["components"][0]["status"], message?: string): void {
    this.healthComponents.set(name, { status, message, lastCheck: Date.now() });
  }

  getHealthReport(): HealthReport {
    const now = Date.now();
    const components: HealthReport["components"] = [];

    let degraded = false;
    let down = false;

    for (const [name, comp] of this.healthComponents) {
      components.push({
        name,
        status: comp.status,
        message: comp.message,
        lastCheck: comp.lastCheck,
      });
      if (comp.status === "degraded") degraded = true;
      if (comp.status === "down") down = true;
    }

    const requestLabels = [{ key: "status", value: "200" }];

    return {
      status: down ? "unhealthy" : degraded ? "degraded" : "healthy",
      uptimeMs: now - this.startTime,
      metrics: {
        totalRequests: this.aggregateCounter(`${this.config.metricsPrefix}_requests_total`),
        errorRate: this.calculateErrorRate(),
        avgLatencyMs: this.histogramCount(`${this.config.metricsPrefix}_request_duration_ms`) > 0
          ? Math.round(this.histogramSum(`${this.config.metricsPrefix}_request_duration_ms`) /
              this.histogramCount(`${this.config.metricsPrefix}_request_duration_ms`))
          : 0,
        p50LatencyMs: this.histogramPercentile(`${this.config.metricsPrefix}_request_duration_ms`, 50),
        p90LatencyMs: this.histogramPercentile(`${this.config.metricsPrefix}_request_duration_ms`, 90),
        p99LatencyMs: this.histogramPercentile(`${this.config.metricsPrefix}_request_duration_ms`, 99),
        activeSessions: this.gaugeGet(`${this.config.metricsPrefix}_active_sessions`),
      },
      components,
    };
  }

  // ── Prometheus Export ───────────────────────────────────

  /**
   * Export all metrics in Prometheus text exposition format.
   * Can be served at /metrics endpoint for Prometheus scraping.
   */
  exportPrometheus(): string {
    const lines: string[] = [];
    const prefix = this.config.metricsPrefix;

    // Help comments from registered definitions
    for (const [, def] of this.metricDefs) {
      lines.push(`# HELP ${def.name} ${def.help}`);
      lines.push(`# TYPE ${def.name} ${def.type}`);
    }

    // Process metrics
    if (this.config.includeProcessMetrics) {
      const mem = process.memoryUsage();
      lines.push(`# HELP ${prefix}_process_memory_bytes Process memory usage`);
      lines.push(`# TYPE ${prefix}_process_memory_bytes gauge`);
      lines.push(`${prefix}_process_memory_bytes{type="heap_total"} ${mem.heapTotal}`);
      lines.push(`${prefix}_process_memory_bytes{type="heap_used"} ${mem.heapUsed}`);
      lines.push(`${prefix}_process_memory_bytes{type="rss"} ${mem.rss}`);
      lines.push(`${prefix}_process_memory_bytes{type="external"} ${mem.external}`);
      lines.push(`# HELP ${prefix}_process_uptime_seconds Process uptime`);
      lines.push(`# TYPE ${prefix}_process_uptime_seconds gauge`);
      lines.push(`${prefix}_process_uptime_seconds ${(Date.now() - this.startTime) / 1000}`);
    }

    // Export counters
    for (const [name, labelMap] of this.counters) {
      this.appendPrometheusMetric(lines, name, "counter", labelMap);
    }

    // Export gauges
    for (const [name, labelMap] of this.gauges) {
      this.appendPrometheusMetric(lines, name, "gauge", labelMap);
    }

    // Export histograms
    for (const [name, labelMap] of this.histograms) {
      this.appendPrometheusHistogram(lines, name, labelMap);
    }

    return lines.join("\n") + "\n";
  }

  // ── Reset ───────────────────────────────────────────────

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.spans = [];
    this.activeSpans.clear();
    this.otelSpans.clear();
    this.healthComponents.clear();
    this.startTime = Date.now();
  }

  // ── Internal ────────────────────────────────────────────

  private labelKey(name: string, labels: MetricLabel[]): string {
    if (labels.length === 0) return "_default";
    const sorted = [...labels].sort((a, b) => a.key.localeCompare(b.key));
    // 使用 JSON 序列化避免手工 `key=value,key=value` 编码在值含 `,` 或 `=` 时有损
    return JSON.stringify(sorted);
  }

  private labelString(labels: MetricLabel[]): string {
    if (labels.length === 0) return "";
    const sorted = [...labels].sort((a, b) => a.key.localeCompare(b.key));
    return "{" + sorted.map((l) => `${l.key}="${l.value.replace(/"/g, '\\"')}"`).join(",") + "}";
  }

  private parseLabelKey(key: string): MetricLabel[] {
    if (key === "_default") return [];
    // 兼容旧格式 `k=v,k=v`：若 JSON.parse 失败则回退到手工拆分
    try {
      const parsed = JSON.parse(key);
      if (Array.isArray(parsed)) return parsed as MetricLabel[];
    } catch { /* not JSON, try legacy format */ }
    return key.split(",").map((pair) => {
      const [k, ...rest] = pair.split("=");
      return { key: k, value: rest.join("=") };
    });
  }

  private appendPrometheusMetric(
    lines: string[],
    name: string,
    type: string,
    labelMap: Map<string, number>
  ): void {
    for (const [key, value] of labelMap) {
      const labels = this.parseLabelKey(key);
      lines.push(`${name}${this.labelString(labels)} ${value}`);
    }
  }

  private appendPrometheusHistogram(
    lines: string[],
    name: string,
    labelMap: Map<string, number[]>
  ): void {
    for (const [key, values] of labelMap) {
      const labels = this.parseLabelKey(key);
      const labelStr = this.labelString(labels);
      const sorted = [...values].sort((a, b) => a - b);

      const leLabel = (le: string) => labelStr
        ? `${labelStr.slice(0, -1)},le="${le}"}`
        : `{le="${le}"}`;

      // Le buckets
      for (const le of this.config.latencyBuckets) {
        const count = sorted.filter((v) => v <= le).length;
        lines.push(`${name}_bucket${leLabel(String(le))} ${count}`);
      }
      // +Inf bucket
      lines.push(`${name}_bucket${leLabel("+Inf")} ${values.length}`);
      // Sum and count
      const sum = values.reduce((a, b) => a + b, 0);
      lines.push(`${name}_sum${labelStr} ${sum}`);
      lines.push(`${name}_count${labelStr} ${values.length}`);
    }
  }

  private aggregateCounter(name: string): number {
    const labelMap = this.counters.get(name);
    if (!labelMap) return 0;
    let total = 0;
    for (const value of labelMap.values()) {
      total += value;
    }
    return total;
  }

  private calculateErrorRate(): number {
    const allLabels: MetricLabel[][] = [];
    const reqName = `${this.config.metricsPrefix}_requests_total`;
    const reqLabelMap = this.counters.get(reqName);
    if (reqLabelMap) {
      for (const key of reqLabelMap.keys()) {
        allLabels.push(this.parseLabelKey(key));
      }
    }

    let totalRequests = 0;
    let totalErrors = 0;
    const seen = new Set<string>();

    for (const labels of allLabels) {
      const key = this.labelKey("", labels);
      if (seen.has(key)) continue;
      seen.add(key);

      if (labels.some((l) => l.key === "status" && Number(l.value) >= 400)) {
        totalErrors += this.counterGet(`${this.config.metricsPrefix}_request_errors_total`, labels);
      }
      totalRequests += this.counterGet(`${this.config.metricsPrefix}_requests_total`, labels);
    }

    return totalRequests > 0 ? totalErrors / totalRequests : 0;
  }

  private generateTraceId(): string {
    return randomBytes(16).toString("hex");
  }

  private generateSpanId(): string {
    return randomBytes(8).toString("hex");
  }
}