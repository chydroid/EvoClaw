import { trace, context, SpanStatusCode, SpanKind, type Span, type Tracer, type Context } from "@opentelemetry/api";

export interface TracingConfig {
  serviceName: string;
  serviceVersion?: string;
  otlpEndpoint?: string;
  enabled?: boolean;
}

export class TracingService {
  private tracer: Tracer;
  private enabled: boolean;
  private serviceName: string;

  constructor(config: TracingConfig) {
    this.serviceName = config.serviceName || "evoclaw";
    this.enabled = config.enabled ?? true;
    this.tracer = trace.getTracer(
      this.serviceName,
      config.serviceVersion || "0.0.0"
    );
  }

  getTracer(): Tracer {
    return this.tracer;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Start a new span. Returns a no-op span if tracing is disabled.
   */
  startSpan(name: string, options?: { kind?: SpanKind; attributes?: Record<string, string | number | boolean>; parentSpan?: Span }): Span {
    if (!this.enabled) {
      return trace.getTracer("noop").startSpan(name); // no-op span
    }
    const ctx = options?.parentSpan
      ? trace.setSpan(context.active(), options.parentSpan)
      : undefined;
    return this.tracer.startSpan(name, {
      kind: options?.kind,
      attributes: options?.attributes,
    }, ctx);
  }

  /**
   * Run an async function within a span context. Automatically handles span lifecycle.
   */
  async withSpan<T>(name: string, fn: (span: Span) => Promise<T>, options?: { kind?: SpanKind; attributes?: Record<string, string | number | boolean> }): Promise<T> {
    if (!this.enabled) {
      return fn(trace.getTracer("noop").startSpan(name));
    }
    return context.with(trace.setSpan(context.active(), this.startSpan(name, options)), async () => {
      const span = trace.getSpan(context.active());
      try {
        const result = await fn(span!);
        span?.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span?.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
        span?.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        span?.end();
      }
    });
  }

  /**
   * Add an event to the current active span
   */
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
    if (!this.enabled) return;
    const span = trace.getSpan(context.active());
    span?.addEvent(name, attributes);
  }

  /**
   * Set attribute on the current active span
   */
  setAttribute(key: string, value: string | number | boolean): void {
    if (!this.enabled) return;
    const span = trace.getSpan(context.active());
    span?.setAttribute(key, value);
  }

  /**
   * Get the current active span
   */
  getActiveSpan(): Span | undefined {
    return trace.getSpan(context.active());
  }

  /**
   * Get the trace ID of the current active span
   */
  getCurrentTraceId(): string | undefined {
    const span = trace.getSpan(context.active());
    return span?.spanContext()?.traceId;
  }
}
