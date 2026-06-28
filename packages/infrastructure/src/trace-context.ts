/**
 * W3C Trace Context 传播（对齐 openclaw-main 的 traceId/spanId/parentSpanId/traceFlags）。
 *
 * 实现 W3C Trace Context 规范的核心部分：
 * - traceparent: <version>-<trace-id>-<parent-id>-<trace-flags>
 * - version: 00（当前固定）
 * - trace-id: 32 hex chars
 * - parent-id / span-id: 16 hex chars
 * - trace-flags: 2 hex chars（bit 0 = sampled）
 *
 * 用途：
 * - 在日志、HTTP 请求、消息队列消息中传播 trace 上下文
 * - 跨进程调用时保持分布式追踪链路
 * - diagnostic events 携带 trace 信息便于关联分析
 */

import crypto from "crypto";

/** W3C traceparent 头格式。 */
export interface TraceContext {
  /** 版本，当前固定 "00" */
  version: string;
  /** 32 字符 hex trace ID */
  traceId: string;
  /** 16 字符 hex span/parent ID */
  spanId: string;
  /** 2 字符 hex flags（bit 0 = sampled） */
  traceFlags: string;
}

/** Trace 上下文 + 父 span（用于构建 span 树）。 */
export interface TraceSpanContext extends TraceContext {
  /** 父 span ID（根 span 时为 undefined） */
  parentSpanId?: string;
}

/** 诊断事件（对齐 openclaw-main 的 emitDiagnosticEventWithTrustedTraceContext）。 */
export interface DiagnosticEvent {
  /** 事件名 */
  name: string;
  /** 事件分类（如 "http" / "skill" / "agent" / "channel"） */
  category: string;
  /** 事件级别 */
  level: "trace" | "debug" | "info" | "warn" | "error";
  /** 时间戳（ISO 字符串） */
  timestamp: string;
  /** 携带的 trace 上下文 */
  trace?: TraceSpanContext;
  /** 事件数据 */
  data?: Record<string, unknown>;
}

const TRACE_ID_LENGTH = 32;
const SPAN_ID_LENGTH = 16;
const TRACEPARENT_HEADER = "traceparent";

/** 生成随机 trace ID（32 hex）。 */
export function generateTraceId(): string {
  return crypto.randomBytes(16).toString("hex").padStart(TRACE_ID_LENGTH, "0");
}

/** 生成随机 span ID（16 hex）。 */
export function generateSpanId(): string {
  return crypto.randomBytes(8).toString("hex").padStart(SPAN_ID_LENGTH, "0");
}

/** 创建根 trace 上下文（新 trace 的起点）。 */
export function createRootTraceContext(sampled = true): TraceSpanContext {
  return {
    version: "00",
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    traceFlags: sampled ? "01" : "00",
  };
}

/** 从父上下文创建子上下文（继承 traceId，生成新 spanId）。 */
export function createChildTraceContext(parent: TraceSpanContext, sampled?: boolean): TraceSpanContext {
  const parentSampled = (parent.traceFlags === "01" || parent.traceFlags === "1");
  return {
    version: "00",
    traceId: parent.traceId,
    spanId: generateSpanId(),
    parentSpanId: parent.spanId,
    traceFlags: sampled !== undefined ? (sampled ? "01" : "00") : parent.traceFlags,
  };
}

/**
 * 将 TraceContext 序列化为 W3C traceparent 头值。
 * 格式：00-<trace-id(32)>-<span-id(16)>-<flags(2)>
 */
export function formatTraceparent(ctx: TraceContext): string {
  return `${ctx.version}-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags}`;
}

/**
 * 从 W3C traceparent 头值解析 TraceContext。
 * 失败时返回 null（不抛出）。
 */
export function parseTraceparent(header: string): TraceContext | null {
  if (!header || typeof header !== "string") return null;
  const trimmed = header.trim();
  // 格式：version-traceid-spanid-flags
  const parts = trimmed.split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, spanId, traceFlags] = parts;
  if (version.length !== 2 || !/^[0-9a-f]{2}$/i.test(version)) return null;
  if (traceId.length !== TRACE_ID_LENGTH || !/^[0-9a-f]{32}$/i.test(traceId)) return null;
  if (spanId.length !== SPAN_ID_LENGTH || !/^[0-9a-f]{16}$/i.test(spanId)) return null;
  if (traceFlags.length !== 2 || !/^[0-9a-f]{2}$/i.test(traceFlags)) return null;
  // 全零 trace-id 与 span-id 非法
  if (traceId === "0".repeat(TRACE_ID_LENGTH)) return null;
  if (spanId === "0".repeat(SPAN_ID_LENGTH)) return null;
  return { version, traceId, spanId, traceFlags };
}

/**
 * 从 HTTP 请求头提取 TraceContext（用于入站请求）。
 * 支持大小写不敏感查找。
 */
export function extractTraceContextFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): TraceSpanContext | null {
  // 大小写不敏感查找 traceparent
  const traceparentRaw = getHeaderCaseInsensitive(headers, TRACEPARENT_HEADER);
  if (!traceparentRaw) return null;
  const ctx = parseTraceparent(traceparentRaw);
  if (!ctx) return null;
  return { ...ctx };
}

/** 大小写不敏感获取头值。 */
function getHeaderCaseInsensitive(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      if (Array.isArray(value)) return value[0] ?? null;
      return value ?? null;
    }
  }
  return null;
}

/**
 * 将 TraceContext 注入到 HTTP 请求头（用于出站请求）。
 * 返回新的 headers 对象（不修改入参）。
 */
export function injectTraceContextIntoHeaders(
  headers: Record<string, string | string[] | undefined>,
  ctx: TraceContext,
): Record<string, string | string[] | undefined> {
  const result = { ...headers };
  result[TRACEPARENT_HEADER] = formatTraceparent(ctx);
  return result;
}

/**
 * AsyncLocalStorage 用于在同一次调用链中传播 trace 上下文，
 * 无需显式传递参数。
 */
import { AsyncLocalStorage } from "async_hooks";

const traceStorage = new AsyncLocalStorage<TraceSpanContext>();

/** 在 trace 上下文中运行函数（自动传播）。 */
export function withTraceContext<T>(
  ctx: TraceSpanContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return traceStorage.run(ctx, fn);
}

/** 获取当前异步上下文中的 trace（若无则 undefined）。 */
export function getCurrentTrace(): TraceSpanContext | undefined {
  return traceStorage.getStore();
}

/**
 * 发出诊断事件（对齐 openclaw-main 的 emitDiagnosticEventWithTrustedTraceContext）。
 *
 * 若未显式传入 trace，则尝试从 AsyncLocalStorage 获取当前 trace。
 * 这确保同一调用链中的所有事件都能被关联到同一 trace。
 */
export function emitDiagnosticEvent(params: {
  name: string;
  category: string;
  level?: DiagnosticEvent["level"];
  data?: Record<string, unknown>;
  trace?: TraceSpanContext;
  sink?: (event: DiagnosticEvent) => void;
}): DiagnosticEvent {
  const trace = params.trace ?? getCurrentTrace();
  const event: DiagnosticEvent = {
    name: params.name,
    category: params.category,
    level: params.level ?? "info",
    timestamp: new Date().toISOString(),
    trace,
    data: params.data,
  };
  // 默认 sink：写入 stderr 便于诊断
  if (params.sink) {
    params.sink(event);
  } else {
    const line = JSON.stringify({
      ts: event.timestamp,
      level: event.level,
      category: event.category,
      name: event.name,
      traceId: trace?.traceId,
      spanId: trace?.spanId,
      parentSpanId: trace?.parentSpanId,
      data: event.data,
    });
    process.stderr.write(line + "\n");
  }
  return event;
}

/**
 * 启动一个新 span（带 trace 上下文）。
 *
 * 用法：
 * ```ts
 * const span = startSpan("skill.execute", { category: "skill" });
 * try {
 *   // 业务逻辑
 *   span.end(); // 成功
 * } catch (err) {
 *   span.end(err); // 失败
 *   throw err;
 * }
 * ```
 */
export interface Span {
  /** Span 上下文 */
  context: TraceSpanContext;
  /** Span 名 */
  name: string;
  /** 开始时间（毫秒） */
  startTimeMs: number;
  /** 结束 span（记录耗时与状态） */
  end(error?: Error): void;
}

/** 启动新 span。 */
export function startSpan(params: {
  name: string;
  category?: string;
  parent?: TraceSpanContext;
  sink?: (event: DiagnosticEvent) => void;
}): Span {
  const parent = params.parent ?? getCurrentTrace();
  const context = parent
    ? createChildTraceContext(parent)
    : createRootTraceContext();
  const startTimeMs = Date.now();
  const name = params.name;
  const sink = params.sink;

  // 启动事件
  emitDiagnosticEvent({
    name: `${name}.start`,
    category: params.category ?? "span",
    level: "trace",
    trace: context,
    sink,
  });

  return {
    context,
    name,
    startTimeMs,
    end(error?: Error): void {
      const durationMs = Date.now() - startTimeMs;
      emitDiagnosticEvent({
        name: `${name}.end`,
        category: params.category ?? "span",
        level: error ? "error" : "trace",
        trace: context,
        data: {
          durationMs,
          success: !error,
          error: error ? error.message : undefined,
        },
        sink,
      });
    },
  };
}
