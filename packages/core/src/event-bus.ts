import type { EvoEvent, EventHandler, EventSubscription, IEventBus } from "./types/event";
import { v4 as uuid } from "uuid";

export class EventBus implements IEventBus {
  private subscriptions = new Map<string, Map<string, EventSubscription>>();
  private history: EvoEvent[] = [];
  private historyLimit = 1000;
  private closed = false;

  async publish<T>(eventType: string, data: T, source: string): Promise<void> {
    if (this.closed) return;

    const event: EvoEvent<T> = {
      id: uuid(),
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
    await Promise.allSettled(
      handlers.map(async (sub) => {
        try {
          if (!sub.filter || sub.filter(event)) {
            await sub.handler(event);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`EventBus: handler error for "${eventType}": ${msg}\n`);
        }
      })
    );
  }

  subscribe<T>(eventType: string, handler: EventHandler<T>): EventSubscription {
    const subscription: EventSubscription = {
      id: uuid(),
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
    const sub: EventSubscription = {
      id: uuid(),
      eventType,
      handler: async (event: EvoEvent) => {
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