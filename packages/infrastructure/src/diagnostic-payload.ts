/**
 * 诊断载荷：结构化的诊断数据，用于跨进程/跨服务传递。
 *
 * 灵感来自 openclaw-main 的 src/logging/diagnostic-payload.ts。
 *
 * 与 trace-context.ts 中的 DiagnosticEvent 不同：
 * - DiagnosticEvent 关注 trace 上下文传播
 * - DiagnosticPayload 关注结构化诊断数据（含 severity / category / 脱敏字段）
 *   便于 stability monitor / support bundle 后续消费。
 */

import { v4 as uuidv4 } from "uuid";
import type { DiagnosticPhaseKind } from "./diagnostic-phase";

/** 诊断严重度。 */
export type DiagnosticSeverity = "info" | "warning" | "error" | "critical";

/** 实体类型。 */
export type DiagnosticEntityType =
  | "session"
  | "skill"
  | "agent"
  | "tool"
  | "channel";

/** 诊断载荷。 */
export interface DiagnosticPayload {
  /** 唯一 ID（uuid） */
  id: string;
  timestamp: Date;
  severity: DiagnosticSeverity;
  /** 分类（如 "session.stuck", "tool.timeout", "skill.quality"） */
  category: string;
  message: string;
  /** 关联实体 ID（如 sessionId、skillId） */
  entityId?: string;
  entityType?: DiagnosticEntityType;

  // ── 上下文 ──
  /** W3C trace ID */
  traceId?: string;
  spanId?: string;
  phase?: DiagnosticPhaseKind;

  // ── 数据 ──
  data?: Record<string, unknown>;

  // ── 关联 ──
  relatedPayloadIds?: string[];
  parentPayloadId?: string;

  // ── 脱敏标记 ──
  /** 是否已脱敏 */
  redacted?: boolean;
  /** 已脱敏字段列表 */
  redactedFields?: string[];
}

/** 默认敏感字段名列表（大小写不敏感匹配）。 */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "privateKey",
  "private_key",
  "credentials",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "sessionId",
  "session_id",
  "ssn",
  "creditCard",
  "credit_card",
  "cvv",
];

const REDACTED_PLACEHOLDER = "***REDACTED***";

/** 诊断载荷构造参数。 */
export interface DiagnosticPayloadCreateOptions {
  severity: DiagnosticSeverity;
  category: string;
  message: string;
  entityId?: string;
  entityType?: DiagnosticEntityType;
  data?: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
  phase?: DiagnosticPhaseKind;
  parentPayloadId?: string;
  relatedPayloadIds?: string[];
}

/** 诊断载荷构造器（静态工厂方法）。 */
export class DiagnosticPayloadBuilder {
  /** 创建新载荷。 */
  static create(opts: DiagnosticPayloadCreateOptions): DiagnosticPayload {
    return {
      id: uuidv4(),
      timestamp: new Date(),
      severity: opts.severity,
      category: opts.category,
      message: opts.message,
      entityId: opts.entityId,
      entityType: opts.entityType,
      traceId: opts.traceId,
      spanId: opts.spanId,
      phase: opts.phase,
      data: opts.data ? { ...opts.data } : undefined,
      parentPayloadId: opts.parentPayloadId,
      relatedPayloadIds: opts.relatedPayloadIds
        ? [...opts.relatedPayloadIds]
        : undefined,
    };
  }

  /**
   * 基于父载荷创建子载荷，自动继承 traceId / spanId / entityId / entityType。
   */
  static withParent(
    parent: DiagnosticPayload,
    opts: Omit<DiagnosticPayloadCreateOptions, "traceId" | "spanId" | "entityId" | "entityType">,
  ): DiagnosticPayload {
    return DiagnosticPayloadBuilder.create({
      ...opts,
      traceId: parent.traceId,
      spanId: parent.spanId,
      entityId: parent.entityId,
      entityType: parent.entityType,
      parentPayloadId: opts.parentPayloadId ?? parent.id,
      relatedPayloadIds: opts.relatedPayloadIds,
    });
  }

  /**
   * 脱敏载荷中的敏感字段（深拷贝，不修改入参）。
   *
   * 匹配规则：字段名（忽略大小写）在 sensitiveKeys 中时，整值替换为占位符。
   */
  static redact(
    payload: DiagnosticPayload,
    sensitiveKeys: readonly string[] = DEFAULT_SENSITIVE_KEYS,
  ): DiagnosticPayload {
    const lowerSet = new Set(sensitiveKeys.map((k) => k.toLowerCase()));
    const redactedFields: string[] = [];
    const redactedData = payload.data
      ? (redactRecord(payload.data, lowerSet, "", redactedFields) as Record<string, unknown>)
      : undefined;
    return {
      ...payload,
      data: redactedData,
      redacted: redactedFields.length > 0,
      redactedFields: redactedFields.length > 0 ? redactedFields : undefined,
    };
  }
}

/** 递归脱敏 record 中的敏感字段。返回新对象。 */
function redactRecord(
  value: unknown,
  sensitiveLower: Set<string>,
  pathPrefix: string,
  redactedFields: string[],
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) =>
      redactRecord(item, sensitiveLower, `${pathPrefix}[${i}]`, redactedFields),
    );
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    const fieldPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (sensitiveLower.has(key.toLowerCase())) {
      out[key] = REDACTED_PLACEHOLDER;
      redactedFields.push(fieldPath);
    } else if (val !== null && typeof val === "object") {
      out[key] = redactRecord(val, sensitiveLower, fieldPath, redactedFields);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** 查询参数。 */
export interface DiagnosticPayloadQuery {
  severity?: DiagnosticSeverity;
  category?: string;
  entityId?: string;
  after?: Date;
  before?: Date;
  limit?: number;
}

/**
 * 诊断载荷收集器：累积载荷并按时间/严重度/类别过滤。
 *
 * 使用 ring-buffer 风格的限制：超过 maxSize 时丢弃最旧条目。
 */
export class DiagnosticPayloadCollector {
  private payloads: DiagnosticPayload[] = [];
  private readonly maxSize: number;
  private readonly maxAgeMs: number;

  constructor(opts?: { maxSize?: number; maxAgeMs?: number }) {
    this.maxSize = opts?.maxSize ?? 1000;
    this.maxAgeMs = opts?.maxAgeMs ?? 24 * 60 * 60 * 1000; // 24h
  }

  /** 添加载荷；超过 maxSize 时丢弃最旧条目。 */
  add(payload: DiagnosticPayload): void {
    this.payloads.push(payload);
    if (this.payloads.length > this.maxSize) {
      this.payloads.splice(0, this.payloads.length - this.maxSize);
    }
  }

  /** 按条件查询载荷（按时间升序，limit 截断最新 N 条）。 */
  query(opts: DiagnosticPayloadQuery): DiagnosticPayload[] {
    const matched = this.payloads.filter((p) => {
      if (opts.severity && p.severity !== opts.severity) return false;
      if (opts.category && p.category !== opts.category) return false;
      if (opts.entityId && p.entityId !== opts.entityId) return false;
      if (opts.after && p.timestamp.getTime() < opts.after.getTime()) return false;
      if (opts.before && p.timestamp.getTime() > opts.before.getTime()) return false;
      return true;
    });
    const limit = opts.limit;
    // slice(-0) 会返回整个数组，limit 为 0 时应返回空数组
    if (limit === 0) return [];
    return limit !== undefined && limit >= 0
      ? matched.slice(-limit)
      : matched;
  }

  /** 导出所有载荷（自动脱敏）。 */
  exportAll(sensitiveKeys?: readonly string[]): DiagnosticPayload[] {
    return this.payloads.map((p) =>
      DiagnosticPayloadBuilder.redact(p, sensitiveKeys),
    );
  }

  /** 清理过期载荷；返回被清理的数量。 */
  prune(now: Date = new Date()): number {
    const cutoff = now.getTime() - this.maxAgeMs;
    const before = this.payloads.length;
    this.payloads = this.payloads.filter(
      (p) => p.timestamp.getTime() >= cutoff,
    );
    return before - this.payloads.length;
  }

  /** 清空所有载荷。 */
  clear(): void {
    this.payloads = [];
  }

  /** 当前载荷数量。 */
  size(): number {
    return this.payloads.length;
  }
}
