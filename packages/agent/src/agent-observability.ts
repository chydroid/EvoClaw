/**
 * Agent Observability — Structured tracing & metrics for full-chain observability.
 *
 * OpenTelemetry-compatible span/trace model with built-in agent metrics.
 * Inspired by OpenClaw 2026.4.5 and enterprise agent best practices.
 *
 * No external dependencies. Production-ready.
 */

import * as fs from "fs";
import * as path from "path";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export type SpanKind =
  | "request"
  | "planner"
  | "tool"
  | "llm"
  | "reflection"
  | "guardrail"
  | "memory"
  | "delegation";

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, unknown>;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: SpanKind;
  name: string;
  startTime: number;
  endTime?: number;
  status: "ok" | "error" | "timeout";
  attributes: Record<string, unknown>;
  events: SpanEvent[];
}

export interface Trace {
  traceId: string;
  sessionId: string;
  rootSpanId: string;
  spans: Span[];
  startTime: number;
  endTime?: number;
  status: "ok" | "error" | "partial";
  metadata: Record<string, unknown>;
}

export type MetricType = "counter" | "gauge" | "histogram";

export interface Metric {
  name: string;
  type: MetricType;
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

export interface TraceSummary {
  traceId: string;
  totalDuration: number;
  spanCount: number;
  spanBreakdown: Record<SpanKind, { count: number; totalDuration: number }>;
  errorCount: number;
  toolCalls: number;
  llmCalls: number;
  tokenUsage?: { input: number; output: number };
}

export interface ObservabilityConfig {
  enabled: boolean;
  maxTraces: number;
  maxSpansPerTrace: number;
  maxMetrics: number;
  exportIntervalMs: number;
  /** 0–1 fraction of traces to record (1.0 = record all) */
  samplingRate: number;
  /** 持久化目录 */
  storeDir?: string;
}

// ──────────────────────────────────────────────────────────────
// ID Generation
// ──────────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ──────────────────────────────────────────────────────────────
// AgentObservability
// ──────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ObservabilityConfig = {
  enabled: true,
  maxTraces: 1000,
  maxSpansPerTrace: 100,
  maxMetrics: 10000,
  exportIntervalMs: 60000,
  samplingRate: 1.0,
};

export class AgentObservability {
  private config: ObservabilityConfig;
  private traces: Map<string, Trace> = new Map();
  private metrics: Metric[] = [];
  private traceOrder: string[] = []; // insertion order for eviction
  private exportTimer: ReturnType<typeof setInterval> | null = null;
  private storeDir: string;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: Partial<ObservabilityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.storeDir = this.config.storeDir || path.resolve(process.cwd(), "data", "observability");
    this.loadFromDisk();
    if (this.config.enabled && this.config.exportIntervalMs > 0) {
      this.exportTimer = setInterval(
        () => this.flushExport(),
        this.config.exportIntervalMs,
      );
      // Allow the process to exit even if the timer is running
      if (this.exportTimer && typeof this.exportTimer === "object" && "unref" in this.exportTimer) {
        this.exportTimer.unref();
      }
    }
  }

  // ── Trace lifecycle ──────────────────────────────────────

  startTrace(sessionId: string, metadata?: Record<string, unknown>): Trace {
    if (!this.config.enabled) {
      // Return a dummy trace that won't be stored
      const traceId = generateId();
      return this.makeTrace(traceId, sessionId, "", 0, {});
    }

    // Sampling: skip recording if random > samplingRate
    if (Math.random() > this.config.samplingRate) {
      const traceId = generateId();
      return this.makeTrace(traceId, sessionId, "", 0, {});
    }

    const traceId = generateId();
    const rootSpan = this.createSpan(traceId, "request", "root", undefined);
    const trace: Trace = {
      traceId,
      sessionId,
      rootSpanId: rootSpan.spanId,
      spans: [rootSpan],
      startTime: rootSpan.startTime,
      status: "ok",
      metadata: metadata ?? {},
    };

    this.storeTrace(trace);
    return trace;
  }

  startSpan(
    traceId: string,
    kind: SpanKind,
    name: string,
    parentSpanId?: string,
  ): Span {
    const span = this.createSpan(traceId, kind, name, parentSpanId);

    const trace = this.traces.get(traceId);
    if (!trace) {
      // Trace not being recorded (sampling or disabled) — return orphan span
      return span;
    }

    if (trace.spans.length >= this.config.maxSpansPerTrace) {
      // Drop span to prevent unbounded growth
      return span;
    }

    trace.spans.push(span);
    return span;
  }

  endSpan(
    traceId: string,
    spanId: string,
    status: "ok" | "error" | "timeout" = "ok",
  ): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    const span = trace.spans.find((s) => s.spanId === spanId);
    if (!span || span.endTime !== undefined) return;

    span.endTime = Date.now();
    span.status = status;

    // Auto-record built-in metrics based on span kind
    this.recordSpanMetrics(span);
  }

  addSpanEvent(
    traceId: string,
    spanId: string,
    event: SpanEvent,
  ): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    const span = trace.spans.find((s) => s.spanId === spanId);
    if (!span) return;

    span.events.push(event);
  }

  addSpanAttribute(
    traceId: string,
    spanId: string,
    key: string,
    value: unknown,
  ): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    const span = trace.spans.find((s) => s.spanId === spanId);
    if (!span) return;

    span.attributes[key] = value;
  }

  endTrace(
    traceId: string,
    status: "ok" | "error" | "partial" = "ok",
  ): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    trace.endTime = Date.now();
    trace.status = status;

    // End any still-open spans
    for (const span of trace.spans) {
      if (span.endTime === undefined) {
        span.endTime = trace.endTime;
        span.status = status === "ok" ? "ok" : "error";
      }
    }

    // Record request-level metrics
    this.recordMetric("agent.request.total", "counter", 1);
    if (trace.endTime && trace.startTime) {
      this.recordMetric(
        "agent.request.duration",
        "histogram",
        trace.endTime - trace.startTime,
      );
    }
    if (status === "error") {
      this.recordMetric("agent.error.total", "counter", 1, { type: "trace" });
    }
  }

  getTrace(traceId: string): Trace | undefined {
    return this.traces.get(traceId);
  }

  getActiveTraces(): Trace[] {
    const active: Trace[] = [];
    for (const trace of this.traces.values()) {
      if (trace.endTime === undefined) {
        active.push(trace);
      }
    }
    return active;
  }

  /** 获取最近的 traces（含已完成），按开始时间倒序 */
  getRecentTraces(limit = 100): Trace[] {
    const all = Array.from(this.traces.values());
    all.sort((a, b) => b.startTime - a.startTime);
    return all.slice(0, limit);
  }

  // ── Metrics ──────────────────────────────────────────────

  recordMetric(
    name: string,
    type: MetricType,
    value: number,
    labels: Record<string, string> = {},
  ): void {
    if (!this.config.enabled) return;

    if (this.metrics.length >= this.config.maxMetrics) {
      // Evict oldest 10%
      const evictCount = Math.ceil(this.config.maxMetrics * 0.1);
      this.metrics.splice(0, evictCount);
    }

    this.metrics.push({
      name,
      type,
      value,
      labels,
      timestamp: Date.now(),
    });
  }

  getMetrics(name?: string): Metric[] {
    if (name) {
      return this.metrics.filter((m) => m.name === name);
    }
    return [...this.metrics];
  }

  // ── Summary & Export ─────────────────────────────────────

  getTraceSummary(traceId: string): TraceSummary {
    const trace = this.traces.get(traceId);
    if (!trace) {
      return {
        traceId,
        totalDuration: 0,
        spanCount: 0,
        spanBreakdown: {} as Record<SpanKind, { count: number; totalDuration: number }>,
        errorCount: 0,
        toolCalls: 0,
        llmCalls: 0,
      };
    }

    const totalDuration =
      trace.endTime !== undefined
        ? trace.endTime - trace.startTime
        : Date.now() - trace.startTime;

    const spanBreakdown: Record<string, { count: number; totalDuration: number }> = {};
    let errorCount = 0;
    let toolCalls = 0;
    let llmCalls = 0;
    let tokenInput = 0;
    let tokenOutput = 0;
    let hasTokenUsage = false;

    for (const span of trace.spans) {
      const kind = span.kind;
      if (!spanBreakdown[kind]) {
        spanBreakdown[kind] = { count: 0, totalDuration: 0 };
      }
      spanBreakdown[kind].count++;

      const duration =
        span.endTime !== undefined
          ? span.endTime - span.startTime
          : Date.now() - span.startTime;
      spanBreakdown[kind].totalDuration += duration;

      if (span.status === "error" || span.status === "timeout") {
        errorCount++;
      }

      if (kind === "tool") {
        toolCalls++;
      }
      if (kind === "llm") {
        llmCalls++;
      }

      // Accumulate token usage from span attributes
      if (kind === "llm") {
        const input = span.attributes["tokens.input"];
        const output = span.attributes["tokens.output"];
        if (typeof input === "number") {
          tokenInput += input;
          hasTokenUsage = true;
        }
        if (typeof output === "number") {
          tokenOutput += output;
          hasTokenUsage = true;
        }
      }
    }

    const summary: TraceSummary = {
      traceId,
      totalDuration,
      spanCount: trace.spans.length,
      spanBreakdown: spanBreakdown as Record<SpanKind, { count: number; totalDuration: number }>,
      errorCount,
      toolCalls,
      llmCalls,
    };

    if (hasTokenUsage) {
      summary.tokenUsage = { input: tokenInput, output: tokenOutput };
    }

    return summary;
  }

  /**
   * Export a trace as JSON in an OpenTelemetry-compatible format.
   */
  exportTrace(traceId: string): string {
    const trace = this.traces.get(traceId);
    if (!trace) {
      return JSON.stringify({ resourceSpans: [] });
    }

    const otSpans = trace.spans.map((span) => ({
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId ?? "",
      kind: spanKindToOtel(span.kind),
      name: span.name,
      startTimeUnixNano: `${span.startTime}000000`,
      endTimeUnixNano: span.endTime !== undefined ? `${span.endTime}000000` : undefined,
      status: { code: span.status === "ok" ? 0 : 2 }, // 0=OK, 2=ERROR
      attributes: Object.entries(span.attributes).map(([k, v]) => ({
        key: k,
        value: { stringValue: String(v) },
      })),
      events: span.events.map((ev) => ({
        timeUnixNano: `${ev.timestamp}000000`,
        name: ev.name,
        attributes: ev.attributes
          ? Object.entries(ev.attributes).map(([k, v]) => ({
              key: k,
              value: { stringValue: String(v) },
            }))
          : [],
      })),
    }));

    return JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              scope: { name: "evoclaw-agent" },
              spans: otSpans,
            },
          ],
        },
      ],
    });
  }

  /**
   * Export metrics in Prometheus-compatible text format.
   */
  exportMetrics(): string {
    const lines: string[] = [];

    // Group metrics by name for TYPE/HELP declarations
    const byName = new Map<string, Metric[]>();
    for (const m of this.metrics) {
      const existing = byName.get(m.name) ?? [];
      existing.push(m);
      byName.set(m.name, existing);
    }

    for (const [name, samples] of byName) {
      // Determine Prometheus type mapping
      const promType = samples[0].type === "counter"
        ? "counter"
        : samples[0].type === "gauge"
          ? "gauge"
          : "histogram";

      lines.push(`# HELP ${name} EvoClaw agent metric`);
      lines.push(`# TYPE ${name} ${promType}`);

      for (const sample of samples) {
        const labelStr = Object.entries(sample.labels)
          .map(([k, v]) => `${k}="${escapePromLabelValue(v)}"`)
          .join(",");
        const labelPart = labelStr ? `{${labelStr}}` : "";
        lines.push(`${name}${labelPart} ${sample.value}`);
      }
    }

    return lines.join("\n") + "\n";
  }

  // ── Lifecycle ────────────────────────────────────────────

  /**
   * Stop the export timer and release resources.
   */
  shutdown(): void {
    if (this.exportTimer) {
      clearInterval(this.exportTimer);
      this.exportTimer = null;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistToDisk();
    this.flushExport();
  }

  // ── Internals ────────────────────────────────────────────

  private createSpan(
    traceId: string,
    kind: SpanKind,
    name: string,
    parentSpanId?: string,
  ): Span {
    return {
      traceId,
      spanId: generateId(),
      parentSpanId,
      kind,
      name,
      startTime: Date.now(),
      status: "ok",
      attributes: {},
      events: [],
    };
  }

  private makeTrace(
    traceId: string,
    sessionId: string,
    rootSpanId: string,
    startTime: number,
    metadata: Record<string, unknown>,
  ): Trace {
    return {
      traceId,
      sessionId,
      rootSpanId,
      spans: [],
      startTime,
      status: "ok",
      metadata,
    };
  }

  private storeTrace(trace: Trace): void {
    // Evict oldest traces if at capacity
    if (this.traces.size >= this.config.maxTraces) {
      const evictCount = Math.ceil(this.config.maxTraces * 0.1);
      for (let i = 0; i < evictCount && this.traceOrder.length > 0; i++) {
        const oldestId = this.traceOrder.shift();
        if (oldestId) {
          this.traces.delete(oldestId);
        }
      }
    }

    this.traces.set(trace.traceId, trace);
    this.traceOrder.push(trace.traceId);
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistToDisk(), 5000);
    // 允许进程在定时器运行时退出
    this.persistTimer.unref();
  }

  /** 保存 traces 到磁盘（JSON 格式） */
  private persistToDisk(): void {
    try {
      if (!fs.existsSync(this.storeDir)) {
        fs.mkdirSync(this.storeDir, { recursive: true });
      }
      const filePath = path.join(this.storeDir, "traces.json");
      const data = {
        traces: Array.from(this.traces.values()).slice(-1000),
        savedAt: new Date().toISOString(),
      };
      const serialized = JSON.stringify(data);
      // 原子写入：temp + fsync + rename，防止崩溃时 JSON 文件损坏
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      const fd = fs.openSync(tmpPath, "w");
      try {
        fs.writeFileSync(fd, serialized, "utf-8");
        fs.fsyncSync(fd);
      } finally {
        try { fs.closeSync(fd); } catch { /* ignore close errors to not mask original */ }
      }
      try {
        fs.renameSync(tmpPath, filePath);
      } catch (renameErr) {
        // EXDEV/EBUSY 跨设备回退：在目标目录侧创建临时文件再 rename
        const dstTmp = `${filePath}.${process.pid}.${Date.now()}.dst.tmp`;
        try {
          fs.copyFileSync(tmpPath, dstTmp);
          fs.renameSync(dstTmp, filePath);
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        } catch (fallbackErr) {
          try { fs.unlinkSync(dstTmp); } catch { /* ignore */ }
          throw fallbackErr;
        }
      }
    } catch (err) {
      process.stderr.write(`[AgentObservability] Failed to persist: ${err}\n`);
    }
  }

  /** 从磁盘加载 traces */
  private loadFromDisk(): void {
    try {
      const filePath = path.join(this.storeDir, "traces.json");
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data.traces)) {
        for (const t of data.traces) {
          if (t && t.traceId) {
            this.traces.set(t.traceId, t);
            this.traceOrder.push(t.traceId);
          }
        }
      }
    } catch (err) {
      process.stderr.write(`[AgentObservability] Failed to load from disk: ${err}\n`);
    }
  }

  private recordSpanMetrics(span: Span): void {
    const duration = span.endTime !== undefined
      ? span.endTime - span.startTime
      : 0;

    switch (span.kind) {
      case "tool": {
        const toolName = span.attributes["tool.name"] ?? span.name.replace("tool:", "");
        this.recordMetric("agent.tool.calls", "counter", 1, {
          tool_name: String(toolName),
        });
        this.recordMetric("agent.tool.duration", "histogram", duration, {
          tool_name: String(toolName),
        });
        break;
      }
      case "llm": {
        const model = span.attributes["model"] ?? span.name.replace("llm:", "");
        this.recordMetric("agent.llm.calls", "counter", 1, {
          model: String(model),
        });

        // Token metrics
        const inputTokens = span.attributes["tokens.input"];
        const outputTokens = span.attributes["tokens.output"];
        if (typeof inputTokens === "number") {
          this.recordMetric("agent.llm.tokens", "counter", inputTokens, {
            model: String(model),
            direction: "input",
          });
        }
        if (typeof outputTokens === "number") {
          this.recordMetric("agent.llm.tokens", "counter", outputTokens, {
            model: String(model),
            direction: "output",
          });
        }
        break;
      }
      case "guardrail": {
        const layer = span.attributes["layer"] ?? "unknown";
        if (span.status === "error") {
          this.recordMetric("agent.guardrail.blocks", "counter", 1, {
            layer: String(layer),
          });
        }
        break;
      }
      default:
        break;
    }

    if (span.status === "error") {
      this.recordMetric("agent.error.total", "counter", 1, {
        type: span.kind,
      });
    }
  }

  private flushExport(): void {
    try {
      // Export completed traces to a JSONL file for persistence
      const completedTraces = Array.from(this.traces.values())
        .filter(t => t.endTime !== undefined);

      if (completedTraces.length === 0) return;

      const dir = path.join(process.cwd(), "data", "observability");

      // Ensure directory exists
      try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {
        // 创建目录失败时记录到 stderr
        process.stderr.write("[AgentObservability] mkdir failed: " + err + "\n");
      }

      // Append traces as JSONL
      const traceFile = path.join(dir, `traces-${new Date().toISOString().slice(0, 10)}.jsonl`);
      const lines = completedTraces
        .map(t => JSON.stringify(this.exportTrace(t.traceId)))
        .join("\n") + "\n";
      fs.appendFileSync(traceFile, lines, "utf-8");

      // Export metrics to file
      const metricsFile = path.join(dir, `metrics-${new Date().toISOString().slice(0, 10)}.txt`);
      const metricsText = this.exportMetrics();
      fs.writeFileSync(metricsFile, metricsText, "utf-8");

      // Clean up old traces from memory (keep last 100)
      const toKeep = 100;
      if (this.traces.size > toKeep) {
        const sorted = Array.from(this.traces.entries())
          .sort((a, b) => (b[1].endTime || 0) - (a[1].endTime || 0));
        this.traces.clear();
        for (let i = 0; i < Math.min(toKeep, sorted.length); i++) {
          this.traces.set(sorted[i][0], sorted[i][1]);
        }
      }
    } catch (err) {
      // Export failure should not crash the agent，但记录到 stderr 以便排查
      process.stderr.write("[AgentObservability] export failed: " + err + "\n");
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

const SPAN_KIND_OTELO_MAP: Record<SpanKind, number> = {
  request: 1,    // CLIENT
  planner: 3,    // INTERNAL
  tool: 3,       // INTERNAL
  llm: 3,        // INTERNAL
  reflection: 3, // INTERNAL
  guardrail: 3,  // INTERNAL
  memory: 3,     // INTERNAL
  delegation: 1, // CLIENT
};

function spanKindToOtel(kind: SpanKind): number {
  return SPAN_KIND_OTELO_MAP[kind] ?? 3;
}

function escapePromLabelValue(val: string): string {
  return val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
