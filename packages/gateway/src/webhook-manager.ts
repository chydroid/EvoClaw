/**
 * Webhook Manager — registration, dispatch, retry, and lifecycle management
 * for outgoing webhooks.
 *
 * Features:
 *  - Register webhooks for specific events
 *  - Dispatch events to matching webhooks
 *  - Retry with exponential backoff on failure
 *  - Delivery tracking and history
 *  - Webhook signing (HMAC-SHA256)
 *  - Rate limiting
 *  - Event filtering
 */

import * as crypto from "crypto";
import { isUnsafeRegex } from "@evoclaw/security";
import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync } from "./atomic-write";

/**
 * 常量时间字符串比较，防止时序攻击。
 * 长度不同时先返回 false（但仍消耗一定时间以减少长度泄露）。
 */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // 即使长度不同也做一次比较，避免完全基于长度差异的时序泄露
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export interface WebhookConfig {
  /** Unique webhook ID */
  id: string;
  /** Target URL */
  url: string;
  /** Event types to subscribe to (empty = all) */
  events?: string[];
  /** Secret for HMAC signature */
  secret?: string;
  /** Whether this webhook is active */
  enabled?: boolean;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Max retries on failure (default: 3) */
  maxRetries?: number;
  /** Timeout per request in ms (default: 10000) */
  timeoutMs?: number;
  /** Rate limit: max deliveries per minute (default: 60) */
  rateLimitPerMinute?: number;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  timestamp: number;
  status: "pending" | "success" | "failed" | "retrying";
  statusCode?: number;
  error?: string;
  attempt: number;
  durationMs: number;
}

export interface WebhookEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
  source?: string;
}

export interface WebhookEndpoint {
  id: string;
  path: string;
  method: "POST" | "GET";
  authToken?: string;
  action: string;
  description?: string;
  enabled: boolean;
  createdAt: string;
  lastTriggeredAt?: string;
  triggerCount: number;
  /**
   * 路由级声明式过滤器（借鉴 hermes-agent webhook_filters.py）。
   * 当 filter 存在时，trigger 会在 dispatch 前调用 matchFilter；
   * 不匹配时返回 202 Accepted 但不调用 actionHandler。
   */
  filter?: WebhookFilter;
}

/**
 * 复合过滤上下文。trigger 时由 headers/body/eventType 装配而来。
 */
export interface WebhookFilterContext {
  payload: unknown;
  headers: Record<string, string>;
  eventType: string;
}

/**
 * 路由级声明式过滤器。
 *
 * 借鉴 hermes-agent webhook_filters.py：以声明式结构表达复合过滤条件，
 * 而非仅靠 events?: string[] 做单一事件名匹配。
 *
 * - op="all"：所有 conditions 必须满足
 * - op="any"：任一 conditions 满足即可
 * - op="not"：conditions 取反（通常只含 1 个子条件）
 * - 叶子节点：field + operator + value
 */
export interface WebhookFilter {
  op: "all" | "any" | "not";
  conditions?: WebhookFilter[];
  field?: string;
  operator?: "exists" | "missing" | "equals" | "not_equals" | "contains" | "in" | "regex";
  value?: unknown;
}

/**
 * 沿 dotted path 解析 context 中的字段值。
 *
 * 支持三种根命名空间：
 *  - "payload.xxx.yyy" → 从 body 中按点分路径取值
 *  - "headers.xxx" → 从 headers 中取值（大小写不敏感）
 *  - "event_type" → 当前事件类型字符串
 *
 * 解析失败（路径不存在或类型不匹配）时返回 undefined，
 * 由调用方决定 exists/missing 操作符如何处理。
 */
export function resolveField(
  dottedPath: string,
  context: WebhookFilterContext,
): unknown {
  if (typeof dottedPath !== "string" || dottedPath.length === 0) return undefined;
  const parts = dottedPath.split(".");
  const root = parts[0];
  if (parts.length === 1) {
    if (root === "event_type") return context.eventType;
    // 单段路径不指定命名空间时默认从 payload 取
    return getFieldFromObject(context.payload, [root]);
  }
  const rest = parts.slice(1);
  if (root === "payload") {
    return getFieldFromObject(context.payload, rest);
  }
  if (root === "headers") {
    // headers 大小写不敏感：组合剩余段为单一 header 名
    const headerName = rest.join(".").toLowerCase();
    for (const [k, v] of Object.entries(context.headers)) {
      if (k.toLowerCase() === headerName) return v;
    }
    return undefined;
  }
  if (root === "event_type") {
    // 兼容 "event_type.xxx" 误用：event_type 本身是字符串
    return context.eventType;
  }
  // 未知根命名空间：默认从 payload 取整条路径
  return getFieldFromObject(context.payload, parts);
}

/**
 * 从 unknown 对象中沿路径取值。
 * 任一段不存在或类型非 plain object 时返回 undefined。
 */
function getFieldFromObject(obj: unknown, parts: string[]): unknown {
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      // 数组按数字索引取值
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
      continue;
    }
    const record = cur as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, part)) return undefined;
    cur = record[part];
  }
  return cur;
}

/**
 * 评估单个叶子条件（field+operator+value）。
 */
function matchLeaf(
  filter: WebhookFilter,
  context: WebhookFilterContext,
): boolean {
  if (!filter.field || !filter.operator) return false;
  const value = resolveField(filter.field, context);
  switch (filter.operator) {
    case "exists":
      return value !== undefined && value !== null;
    case "missing":
      return value === undefined || value === null;
    case "equals":
      return deepEqual(value, filter.value);
    case "not_equals":
      return !deepEqual(value, filter.value);
    case "contains":
      return containsValue(value, filter.value);
    case "in":
      if (!Array.isArray(filter.value)) return false;
      return filter.value.some((v) => deepEqual(value, v));
    case "regex": {
      if (typeof value !== "string") return false;
      const pattern = typeof filter.value === "string" ? filter.value : "";
      if (pattern.length === 0) return false;
      // 安全：拒绝 ReDoS 风险正则，防止灾难性回溯
      if (isUnsafeRegex(pattern)) return false;
      try {
        return new RegExp(pattern).test(value);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (Array.isArray(b)) return false;
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec);
  const bKeys = Object.keys(bRec);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) => Object.prototype.hasOwnProperty.call(bRec, k) && deepEqual(aRec[k], bRec[k]),
  );
}

function containsValue(haystack: unknown, needle: unknown): boolean {
  if (haystack === undefined || haystack === null) return false;
  if (typeof haystack === "string") {
    return typeof needle === "string" && haystack.includes(needle);
  }
  if (Array.isArray(haystack)) {
    return haystack.some((v) => deepEqual(v, needle));
  }
  if (typeof haystack === "object") {
    const rec = haystack as Record<string, unknown>;
    return Object.values(rec).some((v) => deepEqual(v, needle));
  }
  return false;
}

/**
 * 递归评估 WebhookFilter。
 *
 * - op="all"：所有 conditions 必须满足；空 conditions 视为通过（vacuous truth）
 * - op="any"：任一 conditions 满足即通过；空 conditions 视为不通过
 * - op="not"：对所有 conditions 取反（AND）；多个 conditions 时全取反；
 *             空 conditions 视为不通过
 *
 * 叶子节点（无 conditions，仅有 field+operator）按 matchLeaf 评估。
 * filter 为 null/undefined 时返回 true（无过滤）。
 */
export function matchFilter(
  filter: WebhookFilter | undefined,
  context: WebhookFilterContext,
): boolean {
  if (!filter) return true;
  // 显式处理空 conditions：all 视为通过（vacuous truth），any/not 视为不通过
  if (filter.conditions && filter.conditions.length === 0) {
    return filter.op === "all";
  }
  if (filter.conditions && filter.conditions.length > 0) {
    if (filter.op === "all") {
      return filter.conditions.every((c) => matchFilter(c, context));
    }
    if (filter.op === "any") {
      return filter.conditions.some((c) => matchFilter(c, context));
    }
    if (filter.op === "not") {
      return !filter.conditions.every((c) => matchFilter(c, context));
    }
    return false;
  }
  // 叶子节点
  return matchLeaf(filter, context);
}

export interface WebhookEventLog {
  id: string;
  endpointId: string;
  endpointPath: string;
  action: string;
  timestamp: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  statusCode: number;
  error?: string;
}

export type WebhookActionHandler = (action: string, payload: { headers: Record<string, string>; body: unknown; path: string; endpointId: string }) => Promise<{ statusCode: number; response?: unknown }>;

export class IncomingWebhookManager {
  private endpoints = new Map<string, WebhookEndpoint>();
  private eventLogs: WebhookEventLog[] = [];
  private maxEventLogs = 500;
  private actionHandler: WebhookActionHandler | null = null;
  /** 持久化文件路径（undefined 时禁用持久化，便于测试） */
  private persistencePath: string | undefined;

  constructor(options?: { persistencePath?: string }) {
    this.persistencePath = options?.persistencePath;
    if (this.persistencePath) {
      this.loadPersisted();
    }
  }

  setActionHandler(handler: WebhookActionHandler): void {
    this.actionHandler = handler;
  }

  register(data: Omit<WebhookEndpoint, "createdAt" | "lastTriggeredAt" | "triggerCount">): WebhookEndpoint {
    if (this.endpoints.has(data.id)) {
      throw new Error(`Webhook endpoint "${data.id}" already exists`);
    }

    const endpoint: WebhookEndpoint = {
      ...data,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    };

    this.endpoints.set(data.id, endpoint);
    this.persist();
    process.stdout.write(`[IncomingWebhookManager] Registered endpoint "${data.id}" at ${data.path} (${data.method})\n`);
    return endpoint;
  }

  get(id: string): WebhookEndpoint | undefined {
    return this.endpoints.get(id);
  }

  list(): WebhookEndpoint[] {
    return Array.from(this.endpoints.values());
  }

  update(id: string, updates: Partial<Omit<WebhookEndpoint, "id" | "createdAt">>): WebhookEndpoint | undefined {
    const endpoint = this.endpoints.get(id);
    if (!endpoint) return undefined;

    Object.assign(endpoint, updates);
    this.endpoints.set(id, endpoint);
    this.persist();
    return endpoint;
  }

  delete(id: string): boolean {
    const removed = this.endpoints.delete(id);
    if (removed) {
      this.persist();
    }
    return removed;
  }

  matchEndpoint(requestPath: string, requestMethod: string): WebhookEndpoint | undefined {
    for (const endpoint of this.endpoints.values()) {
      if (!endpoint.enabled) continue;
      if (endpoint.method !== requestMethod) continue;
      if (this.pathMatches(endpoint.path, requestPath)) {
        return endpoint;
      }
    }
    return undefined;
  }

  private pathMatches(pattern: string, requestPath: string): boolean {
    const patternParts = pattern.split("/");
    const pathParts = requestPath.split("/");

    if (patternParts.length !== pathParts.length) {
      if (pattern.endsWith("/*")) {
        const basePattern = pattern.slice(0, -2);
        return requestPath.startsWith(basePattern + "/") || requestPath === basePattern;
      }
      return false;
    }

    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i] === "*") continue;
      if (patternParts[i] !== pathParts[i]) return false;
    }

    return true;
  }

  authenticate(endpoint: WebhookEndpoint, headers: Record<string, string>): boolean {
    if (!endpoint.authToken) return true;

    const authHeader = headers["authorization"] || headers["x-webhook-token"] || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : authHeader;

    // 使用常量时间比较防止时序攻击
    return safeEqual(token, endpoint.authToken);
  }

  async trigger(
    endpointId: string,
    requestPath: string,
    method: string,
    headers: Record<string, string>,
    body: unknown
  ): Promise<{ statusCode: number; response?: unknown; eventLog: WebhookEventLog }> {
    const endpoint = this.endpoints.get(endpointId);
    const logId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const baseLog: WebhookEventLog = {
      id: logId,
      endpointId,
      endpointPath: requestPath,
      action: endpoint?.action ?? "unknown",
      timestamp,
      method,
      headers: this.sanitizeHeaders(headers),
      body,
      statusCode: 500,
    };

    if (!endpoint) {
      const log: WebhookEventLog = { ...baseLog, statusCode: 404, error: "Endpoint not found" };
      this.recordLog(log);
      return { statusCode: 404, eventLog: log };
    }

    if (!endpoint.enabled) {
      const log: WebhookEventLog = { ...baseLog, statusCode: 403, error: "Endpoint is disabled" };
      this.recordLog(log);
      return { statusCode: 403, eventLog: log };
    }

    if (!this.authenticate(endpoint, headers)) {
      const log: WebhookEventLog = { ...baseLog, statusCode: 401, error: "Authentication failed" };
      this.recordLog(log);
      return { statusCode: 401, eventLog: log };
    }

    // 路由级过滤器：声明式复合过滤（借鉴 hermes-agent webhook_filters.py）。
    // 不匹配时返回 202 Accepted 但不调用 actionHandler，
    // 这样上游调用方看到成功响应，但下游不会被不相关的事件触发。
    if (endpoint.filter) {
      const filterContext: WebhookFilterContext = {
        payload: body,
        headers,
        eventType: this.deriveEventType(headers, endpoint.action),
      };
      if (!matchFilter(endpoint.filter, filterContext)) {
        const log: WebhookEventLog = {
          ...baseLog,
          statusCode: 202,
          error: "Filter did not match",
        };
        this.recordLog(log);
        return { statusCode: 202, eventLog: log };
      }
    }

    endpoint.lastTriggeredAt = timestamp;
    endpoint.triggerCount++;

    if (!this.actionHandler) {
      const log: WebhookEventLog = { ...baseLog, statusCode: 200 };
      this.recordLog(log);
      return { statusCode: 200, eventLog: log };
    }

    try {
      const result = await this.actionHandler(endpoint.action, {
        headers,
        body,
        path: requestPath,
        endpointId,
      });

      const log: WebhookEventLog = { ...baseLog, statusCode: result.statusCode };
      this.recordLog(log);
      return { statusCode: result.statusCode, response: result.response, eventLog: log };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const log: WebhookEventLog = { ...baseLog, statusCode: 500, error: errorMessage };
      this.recordLog(log);
      return { statusCode: 500, eventLog: log };
    }
  }

  /**
   * 从常见事件头派生 eventType。
   * 支持 x-evoclaw-event / x-github-event / x-gitlab-event / x-event-type，
   * 全部缺失时回退到 endpoint.action。
   */
  private deriveEventType(headers: Record<string, string>, fallback: string): string {
    const candidates = [
      "x-evoclaw-event",
      "x-github-event",
      "x-gitlab-event",
      "x-event-type",
      "event-type",
    ];
    for (const name of candidates) {
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === name && typeof v === "string" && v.length > 0) {
          return v;
        }
      }
    }
    return fallback;
  }

  private sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (lower === "authorization" || lower === "x-webhook-token") {
        sanitized[key] = "***";
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  private recordLog(log: WebhookEventLog): void {
    this.eventLogs.push(log);
    if (this.eventLogs.length > this.maxEventLogs) {
      this.eventLogs.splice(0, this.eventLogs.length - this.maxEventLogs);
    }
  }

  getEventLogs(endpointId?: string, limit?: number): WebhookEventLog[] {
    let logs = endpointId
      ? this.eventLogs.filter((l) => l.endpointId === endpointId)
      : [...this.eventLogs];

    if (limit != null) {
      logs = logs.slice(-limit);
    }

    return logs;
  }

  clearEventLogs(): void {
    this.eventLogs = [];
  }

  getStats(): {
    totalEndpoints: number;
    activeEndpoints: number;
    totalTriggers: number;
    recentLogs: number;
  } {
    const endpoints = Array.from(this.endpoints.values());
    return {
      totalEndpoints: endpoints.length,
      activeEndpoints: endpoints.filter((e) => e.enabled).length,
      totalTriggers: endpoints.reduce((sum, e) => sum + e.triggerCount, 0),
      recentLogs: this.eventLogs.length,
    };
  }

  dispose(): void {
    this.endpoints.clear();
    this.eventLogs = [];
    this.actionHandler = null;
    this.persistencePath = undefined;
  }

  /**
   * 将当前所有 endpoints 持久化到 data/webhook-subscriptions.json。
   * 使用原子写入（temp + fsync + rename），防止崩溃时文件被截断。
   * 写入失败仅记录到 stderr，不阻断主流程。
   */
  private persist(): void {
    if (!this.persistencePath) return;
    try {
      const endpoints = Array.from(this.endpoints.values());
      const dir = path.dirname(this.persistencePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      atomicWriteFileSync(this.persistencePath, JSON.stringify(endpoints, null, 2));
    } catch (err) {
      process.stderr.write(
        `[IncomingWebhookManager] Failed to persist webhook subscriptions: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  /**
   * 从持久化文件加载 endpoints。
   * 文件不存在或解析失败时静默跳过；加载的 endpoint 不再写入文件
   * （register/unregister 时再写入）。
   */
  private loadPersisted(): void {
    if (!this.persistencePath) return;
    try {
      if (!fs.existsSync(this.persistencePath)) return;
      const content = fs.readFileSync(this.persistencePath, "utf-8");
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) return;
      for (const ep of parsed) {
        if (!ep || typeof ep !== "object") continue;
        const endpoint = ep as WebhookEndpoint;
        if (typeof endpoint.id !== "string" || typeof endpoint.path !== "string") continue;
        this.endpoints.set(endpoint.id, endpoint);
      }
    } catch (err) {
      process.stderr.write(
        `[IncomingWebhookManager] Failed to load persisted webhook subscriptions: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

export class WebhookManager {
  private webhooks = new Map<string, WebhookConfig & { createdAt: number }>();
  private deliveries = new Map<string, WebhookDelivery[]>();
  private rateLimitCounters = new Map<string, { count: number; resetAt: number }>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private signingKey: string;

  private maxHistoryPerWebhook = 100;

  constructor(signingKey?: string) {
    // 移除硬编码默认密钥，避免安全风险
    const envKey = process.env.WEBHOOK_SIGNING_KEY;
    if (signingKey) {
      this.signingKey = signingKey;
    } else if (envKey && envKey.length > 0) {
      this.signingKey = envKey;
    } else {
      // 未配置签名密钥时生成随机密钥并打印警告
      this.signingKey = crypto.randomBytes(32).toString("hex");
      process.stderr.write(
        "[WebhookManager] WARNING: WEBHOOK_SIGNING_KEY is not set. A temporary random signing key has been generated for this session. Set WEBHOOK_SIGNING_KEY environment variable for persistent and shared signature verification.\n"
      );
    }
  }

  // ── Registration ─────────────────────────────────────────────────────

  /**
   * 校验 webhook URL，防止 SSRF。
   * - 仅允许 http/https 协议
   * - 禁止指向内网/私有/回环地址
   * 返回 null 表示通过，否则返回错误信息。
   */
  private validateWebhookUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return "Webhook URL must use http or https";
      }
      const host = parsed.hostname;
      // IPv4 私有/内网/回环地址检查
      if (
        host === "localhost" ||
        host.startsWith("127.") ||
        host.startsWith("0.") ||
        host.startsWith("169.254.") ||
        host.startsWith("10.") ||
        host.startsWith("192.168.") ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)
      ) {
        return "Webhook URL must not point to private/internal network";
      }
      // IPv6 检查：URL 中 IPv6 用方括号 [...] 包裹，hostname 可能含或不含方括号
      const v6Raw = host.startsWith("[") && host.endsWith("]")
        ? host.slice(1, -1)
        : (host.includes(":") ? host : null);
      if (v6Raw) {
        const v6 = v6Raw.toLowerCase();
        // 回环 ::1 与未指定 ::
        if (v6 === "::1" || v6 === "::" || v6 === "0:0:0:0:0:0:0:1" || v6 === "0:0:0:0:0:0:0:0") {
          return "Webhook URL must not point to private/internal network";
        }
        // IPv4-mapped IPv6 地址检查：::ffff:x.x.x.x 或完整形式 0:0:0:0:0:ffff:x.x.x.x
        // 这些地址在大多数 OS 上等效于连接嵌入的 IPv4 私有地址
        const v4MappedMatch = v6.match(/^(?:0:0:0:0:0:)?ffff:(\d+\.\d+\.\d+\.\d+)$/) ||
          v6.match(/^(?:0:0:0:0:0:)?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (v4MappedMatch) {
          let ipv4: string;
          if (v4MappedMatch.length === 3) {
            // 十六进制形式 ::ffff:xxxx:xxxx → 转换为 IPv4
            const hi = parseInt(v4MappedMatch[1], 16);
            const lo = parseInt(v4MappedMatch[2], 16);
            ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
          } else {
            ipv4 = v4MappedMatch[1];
          }
          // 对嵌入的 IPv4 递归检查私有地址
          if (ipv4.startsWith("127.") || ipv4.startsWith("10.") ||
              ipv4.startsWith("192.168.") || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ipv4) ||
              ipv4.startsWith("169.254.")) {
            return "Webhook URL must not point to private/internal network";
          }
        }
        // 唯一本地地址 ULA (fc00::/7, 即 fc/fd 开头)
        if (v6.startsWith("fc") || v6.startsWith("fd")) {
          return "Webhook URL must not point to private/internal network";
        }
        // 链路本地 (fe80::/10, 即 fe8/fe9/fea/feb 开头)
        if (v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) {
          return "Webhook URL must not point to private/internal network";
        }
        // 多播 (ff00::/8, 即 ff 开头)
        if (v6.startsWith("ff")) {
          return "Webhook URL must not point to private/internal network";
        }
      }
      return null;
    } catch {
      return "Invalid webhook URL";
    }
  }

  register(config: WebhookConfig): boolean {
    if (this.webhooks.has(config.id)) {
      process.stderr.write(`[WebhookManager] Webhook "${config.id}" already registered\n`);
      return false;
    }

    // SSRF 防护：校验 URL 协议与目标地址
    const urlError = this.validateWebhookUrl(config.url);
    if (urlError) {
      process.stderr.write(`[WebhookManager] Rejected webhook "${config.id}": ${urlError}\n`);
      return false;
    }

    this.webhooks.set(config.id, {
      ...config,
      enabled: config.enabled ?? true,
      events: config.events ?? [],
      maxRetries: config.maxRetries ?? 3,
      timeoutMs: config.timeoutMs ?? 10000,
      rateLimitPerMinute: config.rateLimitPerMinute ?? 60,
      createdAt: Date.now(),
    });

    this.deliveries.set(config.id, []);
    process.stdout.write(`[WebhookManager] Registered webhook "${config.id}" → ${config.url}\n`);
    return true;
  }

  unregister(id: string): boolean {
    const timer = this.retryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(id);
    }
    for (const key of this.retryTimers.keys()) {
      if (key.startsWith(`${id}:`)) {
        const t = this.retryTimers.get(key);
        if (t) clearTimeout(t);
        this.retryTimers.delete(key);
      }
    }
    this.deliveries.delete(id);
    return this.webhooks.delete(id);
  }

  getWebhook(id: string): (WebhookConfig & { createdAt: number }) | undefined {
    return this.webhooks.get(id);
  }

  listWebhooks(): (WebhookConfig & { createdAt: number })[] {
    return Array.from(this.webhooks.values());
  }

  // ── Event Dispatch ───────────────────────────────────────────────────

  /**
   * Fire an event to all matching webhooks. Returns once all webhooks
   * have been notified (fire-and-forget per webhook, does not wait for responses).
   */
  async dispatch(event: WebhookEvent): Promise<void> {
    const matching = Array.from(this.webhooks.values()).filter((wh) => {
      if (!wh.enabled) return false;
      if (wh.events && wh.events.length > 0) {
        // * matches all, otherwise check exact match
        return wh.events.includes("*") || wh.events.includes(event.type);
      }
      return true; // Subscribe to all by default
    });

    if (matching.length === 0) return;

    // Fire to all matching webhooks in parallel (non-blocking)
    await Promise.allSettled(
      matching.map((wh) =>
        this.deliverToWebhook(wh.id, event).catch(() => {
          // Error already logged in deliverToWebhook
        })
      )
    );
  }

  /**
   * Dispatch synchronously and wait for all deliveries to complete.
   * Useful for webhooks that need acknowledgment.
   */
  async dispatchSync(event: WebhookEvent): Promise<WebhookDelivery[]> {
    const matching = Array.from(this.webhooks.values()).filter((wh) => {
      if (!wh.enabled) return false;
      if (wh.events && wh.events.length > 0) {
        return wh.events.includes("*") || wh.events.includes(event.type);
      }
      return true;
    });

    const results = await Promise.allSettled(
      matching.map((wh) => this.deliverToWebhook(wh.id, event))
    );

    return results
      .filter(
        (r): r is PromiseFulfilledResult<WebhookDelivery> =>
          r.status === "fulfilled"
      )
      .map((r) => r.value);
  }

  // ── Delivery ─────────────────────────────────────────────────────────

  private async deliverToWebhook(
    webhookId: string,
    event: WebhookEvent,
    attempt = 1
  ): Promise<WebhookDelivery> {
    const wh = this.webhooks.get(webhookId);
    if (!wh) {
      return {
        id: crypto.randomUUID(),
        webhookId,
        event: event.type,
        timestamp: Date.now(),
        status: "failed",
        error: "Webhook not found",
        attempt,
        durationMs: 0,
      };
    }

    // Rate limiting
    if (!this.checkRateLimit(webhookId, wh.rateLimitPerMinute ?? 60)) {
      return {
        id: crypto.randomUUID(),
        webhookId,
        event: event.type,
        timestamp: Date.now(),
        status: "failed",
        error: "Rate limit exceeded",
        attempt,
        durationMs: 0,
      };
    }

    const deliveryId = crypto.randomUUID();
    const startTime = Date.now();

    try {
      const body = JSON.stringify({
        id: deliveryId,
        event: event.type,
        timestamp: new Date(event.timestamp).toISOString(),
        source: event.source ?? "evoclaw",
        data: event.data,
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "EvoClaw-Webhook/1.0",
        "X-EvoClaw-Event": event.type,
        "X-EvoClaw-Delivery": deliveryId,
        "X-EvoClaw-Signature": this.sign(body, wh.secret),
        ...(wh.headers ?? {}),
      };

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        wh.timeoutMs ?? 10000
      );
      timeout.unref?.();

      // 安全：手动处理重定向，对每个 3xx Location 执行 SSRF 二次校验，
      // 防止外部服务器 302 到内网/元数据端点绕过注册时的 URL 校验。
      let response = await fetch(wh.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        redirect: "manual",
      });

      // 手动跟随重定向链（最多 5 跳），每跳都做 SSRF 校验
      let currentUrl = wh.url;
      let redirectCount = 0;
      while ([301, 302, 303, 307, 308].includes(response.status) && redirectCount < 5) {
        const location = response.headers.get("location");
        if (!location) break;
        const redirectUrl = new URL(location, currentUrl).toString();
        const redirectError = this.validateWebhookUrl(redirectUrl);
        if (redirectError) {
          clearTimeout(timeout);
          return {
            id: crypto.randomUUID(),
            webhookId,
            event: event.type,
            timestamp: Date.now(),
            status: "failed",
            statusCode: response.status,
            error: `Redirect blocked: ${redirectError}`,
            attempt,
            durationMs: Date.now() - startTime,
          };
        }
        currentUrl = redirectUrl;
        // 重定向后改用 GET（HTTP 规范：301/302/303 将 POST 转为 GET）
        const method = [301, 302, 303].includes(response.status) ? "GET" : "POST";
        response = await fetch(redirectUrl, {
          method,
          headers,
          signal: controller.signal,
          redirect: "manual",
        });
        redirectCount++;
      }

      clearTimeout(timeout);

      const durationMs = Date.now() - startTime;
      const statusCode = response.status;

      if (response.ok) {
        const delivery: WebhookDelivery = {
          id: deliveryId,
          webhookId,
          event: event.type,
          timestamp: startTime,
          status: "success",
          statusCode,
          attempt,
          durationMs,
        };
        this.recordDelivery(webhookId, delivery);
        return delivery;
      }

      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `HTTP ${statusCode}: ${errorBody.slice(0, 200)}`
      );
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage =
        err instanceof Error ? err.message : String(err);

      const maxRetries = wh.maxRetries ?? 3;
      if (attempt < maxRetries) {
        // Schedule retry with exponential backoff
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        const delivery: WebhookDelivery = {
          id: deliveryId,
          webhookId,
          event: event.type,
          timestamp: startTime,
          status: "retrying",
          error: errorMessage,
          attempt,
          durationMs,
        };
        this.recordDelivery(webhookId, delivery);

        const timerKey = `${webhookId}:${deliveryId}`;
        const retryTimer = setTimeout(() => {
          this.retryTimers.delete(timerKey);
          void this.deliverToWebhook(webhookId, event, attempt + 1).catch((err) => {
            process.stderr.write(
              "[WebhookManager] Retry delivery failed for" + " " + timerKey + ":" + " " + (err instanceof Error ? err.message : String(err)) + "\n"
            );
          });
        }, delay);
        retryTimer.unref?.();
        this.retryTimers.set(timerKey, retryTimer);

        return delivery;
      }

      // Final failure
      const delivery: WebhookDelivery = {
        id: deliveryId,
        webhookId,
        event: event.type,
        timestamp: startTime,
        status: "failed",
        error: errorMessage,
        attempt,
        durationMs,
      };
      this.recordDelivery(webhookId, delivery);
      process.stderr.write(
        `[WebhookManager] Delivery failed for "${webhookId}" after ${attempt} attempts: ${errorMessage}\n`
      );
      return delivery;
    }
  }

  // ── Delivery History ─────────────────────────────────────────────────

  private recordDelivery(webhookId: string, delivery: WebhookDelivery): void {
    const history = this.deliveries.get(webhookId) ?? [];
    history.push(delivery);

    // Trim history
    if (history.length > this.maxHistoryPerWebhook) {
      history.splice(0, history.length - this.maxHistoryPerWebhook);
    }

    this.deliveries.set(webhookId, history);
  }

  getDeliveries(webhookId: string, limit?: number): WebhookDelivery[] {
    const history = this.deliveries.get(webhookId) ?? [];
    if (limit != null) {
      return history.slice(-limit);
    }
    return [...history];
  }

  getFailedDeliveries(webhookId: string): WebhookDelivery[] {
    const history = this.deliveries.get(webhookId) ?? [];
    return history.filter((d) => d.status === "failed");
  }

  clearHistory(webhookId: string): void {
    this.deliveries.set(webhookId, []);
  }

  // ── Signing ──────────────────────────────────────────────────────────

  private sign(payload: string, webhookSecret?: string): string {
    const secret = webhookSecret ?? this.signingKey;
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(payload);
    return `sha256=${hmac.digest("hex")}`;
  }

  /**
   * Verify a webhook signature (for incoming webhooks).
   */
  verifySignature(
    payload: string,
    signature: string,
    secret?: string
  ): boolean {
    if (!signature) return false;

    const expected = this.sign(payload, secret);
    // 显式长度检查：timingSafeEqual 在长度不同时抛 RangeError，
    // 虽然 try/catch 能捕获但会泄露长度信息（时序旁路）。
    const expectedBuf = Buffer.from(expected);
    const signBuf = Buffer.from(signature);
    if (expectedBuf.length !== signBuf.length) return false;
    try {
      // Constant-time comparison
      return crypto.timingSafeEqual(expectedBuf, signBuf);
    } catch {
      return false;
    }
  }

  // ── Rate Limiting ────────────────────────────────────────────────────

  private checkRateLimit(
    webhookId: string,
    maxPerMinute: number
  ): boolean {
    const now = Date.now();
    const counter = this.rateLimitCounters.get(webhookId);

    if (!counter || now > counter.resetAt) {
      this.rateLimitCounters.set(webhookId, {
        count: 1,
        resetAt: now + 60000,
      });
      return true;
    }

    if (counter.count >= maxPerMinute) {
      return false;
    }

    counter.count++;
    return true;
  }

  // ── Stats ────────────────────────────────────────────────────────────

  getStats(): {
    totalWebhooks: number;
    activeWebhooks: number;
    totalDeliveries: number;
    totalFailures: number;
    webhookStats: Array<{
      id: string;
      url: string;
      enabled: boolean;
      totalDeliveries: number;
      totalFailures: number;
      lastDelivery?: number;
    }>;
  } {
    const webhooks = Array.from(this.webhooks.values());
    const deliveries = Array.from(this.deliveries.entries());

    let totalDeliveries = 0;
    let totalFailures = 0;

    const webhookStats = webhooks.map((wh) => {
      const history = this.deliveries.get(wh.id) ?? [];
      const failures = history.filter((d) => d.status === "failed").length;
      totalDeliveries += history.length;
      totalFailures += failures;
      return {
        id: wh.id,
        url: wh.url,
        enabled: wh.enabled ?? false,
        totalDeliveries: history.length,
        totalFailures: failures,
        lastDelivery: history.length > 0 ? history[history.length - 1].timestamp : undefined,
      };
    });

    return {
      totalWebhooks: webhooks.length,
      activeWebhooks: webhooks.filter((w) => w.enabled).length,
      totalDeliveries,
      totalFailures,
      webhookStats,
    };
  }

  dispose(): void {
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.webhooks.clear();
    this.deliveries.clear();
    this.rateLimitCounters.clear();
  }
}