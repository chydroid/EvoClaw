import type { EvoEvent, EventHandler, EventSubscription, IEventBus } from "./types/event";
import { randomUUID } from "crypto";

/** 单个 handler 的默认超时时间（ms）。挂起的 handler 不会无限期阻塞 publish。 */
const DEFAULT_HANDLER_TIMEOUT_MS = 5_000;

export class EventBus implements IEventBus {
  private subscriptions = new Map<string, Map<string, EventSubscription>>();
  private history: EvoEvent[] = [];
  private historyLimit = 1000;
  private closed = false;
  /** handler 执行超时时间，可通过 setHandlerTimeout 调整 */
  private handlerTimeoutMs = DEFAULT_HANDLER_TIMEOUT_MS;

  /** 设置 handler 执行超时时间。设为 0 表示禁用超时（不推荐，仅用于测试场景）。 */
  setHandlerTimeout(ms: number): void {
    this.handlerTimeoutMs = Math.max(0, ms);
  }

  async publish<T>(eventType: string, data: T, source: string): Promise<void> {
    if (this.closed) return;

    const event: EvoEvent<T> = {
      id: randomUUID(),
      type: eventType,
      source,
      timestamp: new Date(),
      data,
      metadata: {},
    };

    this.recordHistory(event);

    const typeSubscriptions = this.subscriptions.get(eventType);
    if (!typeSubscriptions) return;

    const handlers = Array.from(typeSubscriptions.values());
    // P1-2 修复：原实现使用 Promise.allSettled 等待所有 handler 完成，
    // 单个挂起（永不 resolve）的 handler 会无限期阻塞整条 publish 链路，
    // 导致 DoS。改为对每个 handler 应用独立超时：超时后记录错误并继续，
    // 不影响其他 handler 或后续 publish 调用。
    await Promise.allSettled(
      handlers.map(async (sub) => {
        try {
          if (sub.filter && !sub.filter(event)) return;
          await this.invokeWithTimeout(sub.handler, event, eventType);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`EventBus: handler error for "${eventType}": ${msg}\n`);
        }
      })
    );
  }

  /**
   * 在 handlerTimeoutMs 内执行 handler；超时则记录错误并返回。
   * 超时时间设为 0 时禁用超时（仅用于测试）。
   */
  private async invokeWithTimeout(
    handler: EventHandler,
    event: EvoEvent,
    eventType: string
  ): Promise<void> {
    if (this.handlerTimeoutMs <= 0) {
      await handler(event);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`handler timed out after ${this.handlerTimeoutMs}ms`));
      }, this.handlerTimeoutMs);
      // unref 防止 timer 阻止进程优雅退出
      timer.unref?.();
    });
    try {
      await Promise.race([Promise.resolve().then(() => handler(event)), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  subscribe<T>(eventType: string, handler: EventHandler<T>): EventSubscription {
    const subscription: EventSubscription = {
      id: randomUUID(),
      eventType,
      handler: handler as EventHandler,
    };

    if (!this.subscriptions.has(eventType)) {
      this.subscriptions.set(eventType, new Map());
    }
    this.subscriptions.get(eventType)!.set(subscription.id, subscription);

    return subscription;
  }

  unsubscribe(subscriptionId: string): void {
    for (const [, typeMap] of this.subscriptions) {
      if (typeMap.has(subscriptionId)) {
        typeMap.delete(subscriptionId);
        return;
      }
    }
  }

  once<T>(eventType: string, handler: EventHandler<T>): EventSubscription {
    // 使用同步标志防止并发 publish 下 handler 被执行多次：
    // publish 在调用 handler 前同步快照 handlers 数组，若两次 publish 在同一 tick 内发生，
    // 两次快照都包含 onceSub，导致 handler 被调用两次。同步标志在第一次调用时即置 true。
    let invoked = false;
    const sub: EventSubscription = {
      id: randomUUID(),
      eventType,
      handler: async (event: EvoEvent) => {
        if (invoked) return;
        invoked = true;
        this.unsubscribe(sub.id);
        await handler(event as EvoEvent<T>);
      },
    };

    if (!this.subscriptions.has(eventType)) {
      this.subscriptions.set(eventType, new Map());
    }
    this.subscriptions.get(eventType)!.set(sub.id, sub);

    return sub;
  }

  getHistory(eventType?: string, limit?: number): EvoEvent[] {
    let filtered = this.history;
    if (eventType) {
      filtered = filtered.filter((e) => e.type === eventType);
    }
    if (limit === undefined || limit === null) {
      limit = 100;
    }
    if (limit <= 0) return [];
    return filtered.slice(-limit);
  }

  clearHistory(): void {
    this.history = [];
  }

  /** Gracefully shut down the event bus — stops accepting new events */
  shutdown(): void {
    this.closed = true;
    this.subscriptions.clear();
  }

  private recordHistory(event: EvoEvent): void {
    this.history.push(event);
    if (this.history.length > this.historyLimit) {
      this.history = this.history.slice(-this.historyLimit);
    }
  }

  /** Number of active subscriptions */
  subscriptionCount(): number {
    let count = 0;
    for (const map of this.subscriptions.values()) {
      count += map.size;
    }
    return count;
  }
}