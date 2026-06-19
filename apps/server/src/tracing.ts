import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { InMemorySpanCollector, type RecordedSpan } from "@evoclaw/infrastructure";

let sdk: NodeSDK | undefined;

/** Shared collector — also exported so the gateway can read from it. */
export const spanCollector = new InMemorySpanCollector({ maxSpans: 2000 });

/** SpanProcessor that mirrors spans into our in-memory ring buffer. */
class CollectorProcessor {
  onStart(): void {
    // no-op
  }
  onEnd(span: unknown): void {
    try {
      const s = span as {
        spanContext: () => { traceId: string; spanId: string };
        kind: number;
        startTime: [number, number];
        endTime: [number, number];
        attributes?: Record<string, unknown>;
        events?: Array<{ name: string; time: [number, number]; attributes?: Record<string, unknown> }>;
        status?: { code: number; message?: string };
        name?: string;
        parentSpanId?: string;
      };
      const sc = s.spanContext();
      const status = s.status ?? { code: 0 };
      const attributes = s.attributes ?? {};
      const events = (s.events ?? []).map((e) => ({
        name: e.name,
        time: e.time[0] * 1000 + e.time[1] / 1e6,
        attributes: e.attributes,
      }));
      const startTime = s.startTime[0] * 1000 + s.startTime[1] / 1e6;
      const endTime = s.endTime[0] * 1000 + s.endTime[1] / 1e6;
      const recorded: RecordedSpan = {
        name: s.name ?? "unknown",
        traceId: sc.traceId,
        spanId: sc.spanId,
        parentSpanId: s.parentSpanId,
        kind: s.kind,
        startTime,
        endTime,
        durationMs: Math.max(0, endTime - startTime),
        status: { code: status.code, message: status.message },
        attributes,
        events,
      };
      spanCollector.record(recorded);
    } catch {
      // never let the collector throw into OTel pipeline
    }
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

export function initTracing(serviceName: string, serviceVersion: string, otlpEndpoint?: string): NodeSDK {
  const traceExporter = otlpEndpoint
    ? new OTLPTraceExporter({ url: otlpEndpoint })
    : undefined;

  // NodeSDK accepts a `spanProcessors` array. The internal typing is
  // opaque to TS, so we cast to `unknown` first.
  const collector = new CollectorProcessor();
  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
    }),
    spanProcessors: [collector as unknown as never],
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();
  process.stdout.write(`[Tracing] OpenTelemetry SDK initialized (service=${serviceName}, otlp=${otlpEndpoint || "none"}, collectorBuffer=2000)`);
  return sdk;
}

export function shutdownTracing(): Promise<void> {
  return sdk?.shutdown() ?? Promise.resolve();
}
