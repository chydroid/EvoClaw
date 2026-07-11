import type { Span } from "@opentelemetry/api";
import { trace, context, SpanStatusCode, type SpanKind, type Tracer } from "@opentelemetry/api";

/**
 * A lightweight in-memory ring buffer of recent spans, with optional filtering.
 * Used by the gateway `/api/tracing/spans` endpoint so the WebUI can display
 * a live trace timeline without requiring an OTel SDK or backend.
 *
 * Spans are pushed manually via the `record` method (which the TracingService
 * calls from its public API). This avoids depending on the optional
 * `@opentelemetry/sdk-trace-base` package.
 */
export class InMemorySpanCollector {
  private spans: RecordedSpan[] = [];
  private maxSpans: number;
  private listeners = new Set<(span: RecordedSpan) => void>();

  constructor(options?: { maxSpans?: number }) {
    this.maxSpans = options?.maxSpans ?? 1000;
  }

  /** Record a completed span. Called by TracingService. */
  record(span: RecordedSpan): void {
    this.spans.push(span);
    if (this.spans.length > this.maxSpans) {
      this.spans.splice(0, this.spans.length - this.maxSpans);
    }
    for (const listener of this.listeners) {
      try {
        listener(span);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  /** Returns the most recent spans in reverse chronological order. */
  recent(filter?: { sessionId?: string; limit?: number; nameContains?: string; traceId?: string; sinceMs?: number }): RecordedSpan[] {
    const limit = filter?.limit ?? 50;
    // slice(-0) 会返回整个数组，limit 为 0 时应返回空数组
    if (limit === 0) return [];
    const sinceMs = filter?.sinceMs ?? 0;
    const sessionId = filter?.sessionId;
    const nameContains = filter?.nameContains;
    const traceId = filter?.traceId;

    const matched = this.spans
      .filter((s) => {
        if (traceId && s.traceId !== traceId) return false;
        if (sinceMs && s.startTime < sinceMs) return false;
        if (nameContains && !s.name.toLowerCase().includes(nameContains.toLowerCase())) return false;
        if (sessionId) {
          const sess = (s.attributes["session.id"] as string) ?? (s.attributes.sessionId as string);
          if (sess !== sessionId) return false;
        }
        return true;
      })
      .slice(-limit)
      .reverse();

    return matched;
  }

  /** Return all spans for a given traceId, ordered by startTime. */
  byTrace(traceId: string): RecordedSpan[] {
    return this.recent({ traceId, limit: this.maxSpans }).sort((a, b) => a.startTime - b.startTime);
  }

  /** Total count of collected spans (for diagnostics). */
  size(): number {
    return this.spans.length;
  }

  /** Clear all spans. */
  clear(): void {
    this.spans = [];
  }

  onSpan(listener: (span: RecordedSpan) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface RecordedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: { code: number; message?: string };
  attributes: Record<string, unknown>;
  events: Array<{ name: string; time: number; attributes?: Record<string, unknown> }>;
}

/**
 * Helper that runs an async function inside a span, captures its events and
 * attributes into a RecordedSpan, and pushes it into the collector. Returns
 * the original result.
 */
export async function captureSpan<T>(
  collector: InMemorySpanCollector,
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: { kind?: SpanKind; attributes?: Record<string, string | number | boolean>; parentSpan?: Span }
): Promise<T> {
  const ctx = options?.parentSpan
    ? trace.setSpan(context.active(), options.parentSpan)
    : undefined;
  const span = tracer.startSpan(name, { kind: options?.kind, attributes: options?.attributes }, ctx);
  const start = Date.now();
  const recordedEvents: RecordedSpan["events"] = [];
  span.addEvent = (eventName: string, time, attributes) => {
    // Track events locally so we can surface them in the API response.
    recordedEvents.push({
      name: eventName,
      time: Date.now(),
      attributes: attributes as Record<string, unknown> | undefined,
    });
    return span;
  };
  try {
    const result = await context.with(trace.setSpan(context.active(), span), () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    span.end();
    const sc = span.spanContext();
    const status = (span as unknown as { status?: { code: number; message?: string } }).status ?? { code: 0 };
    const attributes = (span as unknown as { attributes?: Record<string, unknown> }).attributes ?? {};
    const parentSpanId = (span as unknown as { parentSpanId?: string }).parentSpanId;
    collector.record({
      name,
      traceId: sc.traceId,
      spanId: sc.spanId,
      parentSpanId,
      kind: (span as unknown as { kind?: number }).kind ?? 0,
      startTime: start,
      endTime: Date.now(),
      durationMs: Date.now() - start,
      status: { code: status.code, message: status.message },
      attributes,
      events: recordedEvents,
    });
  }
}
