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

export class WebhookManager {
  private webhooks = new Map<string, WebhookConfig & { createdAt: number }>();
  private deliveries = new Map<string, WebhookDelivery[]>();
  private rateLimitCounters = new Map<string, { count: number; resetAt: number }>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private signingKey: string;

  /** Max delivery history per webhook */
  private maxHistoryPerWebhook = 100;

  constructor(signingKey?: string) {
    this.signingKey = signingKey ?? process.env.WEBHOOK_SIGNING_KEY ?? "evoclaw-webhook-key";
  }

  // ── Registration ─────────────────────────────────────────────────────

  register(config: WebhookConfig): boolean {
    if (this.webhooks.has(config.id)) {
      console.warn(`[WebhookManager] Webhook "${config.id}" already registered`);
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
    console.log(`[WebhookManager] Registered webhook "${config.id}" → ${config.url}`);
    return true;
  }

  unregister(id: string): boolean {
    const timer = this.retryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(id);
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

      const response = await fetch(wh.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

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
        this.retryTimers.set(
          timerKey,
          setTimeout(async () => {
            this.retryTimers.delete(timerKey);
            await this.deliverToWebhook(webhookId, event, attempt + 1);
          }, delay)
        );

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
      console.warn(
        `[WebhookManager] Delivery failed for "${webhookId}" after ${attempt} attempts: ${errorMessage}`
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
    try {
      // Constant-time comparison
      return crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(signature)
      );
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