/**
 * QueueManager — OpenClaw-style message queue system.
 *
 * Supports multiple queue modes:
 * - steer: The agent is directed to do something specific
 * - followup: A follow-up question or continuation
 * - collect: Collect results/feedback without interrupting
 * - interrupt: High-priority interruption to current task
 */

import type { EventBus } from "@evoclaw/core";
import * as fs from "fs";
import * as path from "path";

export type QueueMode = "steer" | "followup" | "collect" | "interrupt";

export interface QueueItem {
  id: string;
  sessionId: string;
  mode: QueueMode;
  message: string;
  priority: number;
  createdAt: string;
  context?: Record<string, unknown>;
  retryCount: number;
  maxRetries: number;
  status: "pending" | "processing" | "done" | "failed";
  result?: string;
  error?: string;
}

export interface QueueConfig {
  maxQueueSize: number;
  defaultMaxRetries: number;
  persistQueue: boolean;
  dataDir: string;
}

const QUEUE_PRIORITY: Record<QueueMode, number> = {
  interrupt: 100,
  steer: 50,
  followup: 30,
  collect: 10,
};

const DEFAULT_CONFIG: QueueConfig = {
  maxQueueSize: 100,
  defaultMaxRetries: 3,
  persistQueue: true,
  dataDir: path.join(process.cwd(), "data", "queues"),
};

export class QueueManager {
  private config: QueueConfig;
  private queues = new Map<string, QueueItem[]>();
  private processing = new Map<string, QueueItem>();
  private counter = 0;

  constructor(
    private eventBus: EventBus,
    config?: Partial<QueueConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureDataDir();
  }

  private ensureDataDir(): void {
    try {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    } catch (err) { console.warn(`[QueueManager] Failed to create data directory "${this.config.dataDir}":`, err); }
  }

  // ====== Enqueue ======

  /** Add a message to the queue */
  enqueue(
    sessionId: string,
    message: string,
    mode: QueueMode = "steer",
    context?: Record<string, unknown>,
    priority?: number,
  ): QueueItem {
    const queue = this.getOrCreateQueue(sessionId);

    // Enforce max queue size
    if (queue.length >= this.config.maxQueueSize) {
      // Remove lowest priority item
      queue.sort((a, b) => a.priority - b.priority);
      const removed = queue.shift();
      if (removed) {
        console.warn(
          `[QueueManager] Queue full for session "${sessionId}", dropped item: ${removed.id}`,
        );
      }
    }

    const item: QueueItem = {
      id: `q-${Date.now()}-${++this.counter}`,
      sessionId,
      mode,
      message,
      priority: priority ?? QUEUE_PRIORITY[mode],
      createdAt: new Date().toISOString(),
      context,
      retryCount: 0,
      maxRetries: this.config.defaultMaxRetries,
      status: "pending",
    };

    queue.push(item);

    // Sort by priority (highest first)
    queue.sort((a, b) => b.priority - a.priority);

    // Persist
    this.persistQueue(sessionId);

    this.eventBus.publish(
      "queue.item_added",
      { item, queueSize: queue.length },
      "queue-manager",
    );

    console.log(
      `[QueueManager] Enqueued [${mode}] for session "${sessionId}": "${message.slice(0, 80)}" (queue size: ${queue.length})`,
    );

    return item;
  }

  /** Enqueue with a steer (overrides current agent direction) */
  steer(
    sessionId: string,
    message: string,
    context?: Record<string, unknown>,
  ): QueueItem {
    return this.enqueue(sessionId, message, "steer", context);
  }

  /** Enqueue a follow-up (continues after current task) */
  followup(
    sessionId: string,
    message: string,
    context?: Record<string, unknown>,
  ): QueueItem {
    return this.enqueue(sessionId, message, "followup", context);
  }

  /** Enqueue a collect (gather results without interrupting) */
  collect(
    sessionId: string,
    message: string,
    context?: Record<string, unknown>,
  ): QueueItem {
    return this.enqueue(sessionId, message, "collect", context);
  }

  /** Enqueue an interrupt (high priority, pauses current task) */
  interrupt(
    sessionId: string,
    message: string,
    context?: Record<string, unknown>,
  ): QueueItem {
    return this.enqueue(sessionId, message, "interrupt", context, 200);
  }

  // ====== Dequeue ======

  /** Get the next item to process (highest priority pending) */
  dequeue(sessionId: string): QueueItem | undefined {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return undefined;

    const pending = queue.filter((q) => q.status === "pending");
    if (pending.length === 0) return undefined;

    // Get highest priority item
    const item = pending[0];
    item.status = "processing";
    this.processing.set(item.id, item);

    this.eventBus.publish(
      "queue.item_dequeued",
      { item, remainingCount: pending.length - 1 },
      "queue-manager",
    );

    return item;
  }

  /** Mark item as done */
  markDone(itemId: string, result?: string): void {
    const item = this.findItem(itemId);
    if (!item) return;

    item.status = "done";
    item.result = result;
    this.processing.delete(itemId);

    // Remove from queue (keep for history if needed)
    const queue = this.queues.get(item.sessionId);
    if (queue) {
      this.persistQueue(item.sessionId);
    }

    this.eventBus.publish(
      "queue.item_done",
      { itemId, result },
      "queue-manager",
    );
  }

  /** Mark item as failed (will retry if possible) */
  markFailed(itemId: string, error: string): boolean {
    const item = this.findItem(itemId);
    if (!item) return false;

    item.retryCount++;

    if (item.retryCount >= item.maxRetries) {
      item.status = "failed";
      item.error = error;
      this.processing.delete(itemId);

      this.eventBus.publish(
        "queue.item_failed",
        { itemId, error, retriesExhausted: true },
        "queue-manager",
      );

      console.warn(
        `[QueueManager] Item "${itemId}" failed after ${item.maxRetries} retries: ${error}`,
      );
      return false;
    }

    // Reset to pending for retry
    item.status = "pending";
    item.error = error;
    this.processing.delete(itemId);

    this.eventBus.publish(
      "queue.item_retry",
      { itemId, retryCount: item.retryCount, error },
      "queue-manager",
    );

    console.log(
      `[QueueManager] Item "${itemId}" will retry (attempt ${item.retryCount}/${item.maxRetries})`,
    );
    return true;
  }

  // ====== Queue Management ======

  /** Get the full queue for a session */
  getQueue(sessionId: string): QueueItem[] {
    return [...(this.queues.get(sessionId) || [])];
  }

  /** Get all pending items for a session */
  getPending(sessionId: string): QueueItem[] {
    return (this.queues.get(sessionId) || []).filter(
      (q) => q.status === "pending",
    );
  }

  /** Get item currently being processed */
  getProcessing(sessionId: string): QueueItem | undefined {
    return (this.queues.get(sessionId) || []).find(
      (q) => q.status === "processing",
    );
  }

  /** Check if there are pending items */
  hasPending(sessionId: string): boolean {
    return this.getPending(sessionId).length > 0;
  }

  /** Get queue statistics */
  getStats(sessionId: string): {
    total: number;
    pending: number;
    processing: number;
    done: number;
    failed: number;
  } {
    const queue = this.queues.get(sessionId) || [];
    return {
      total: queue.length,
      pending: queue.filter((q) => q.status === "pending").length,
      processing: queue.filter((q) => q.status === "processing").length,
      done: queue.filter((q) => q.status === "done").length,
      failed: queue.filter((q) => q.status === "failed").length,
    };
  }

  /** Clear the queue for a session */
  clearQueue(sessionId: string): void {
    this.queues.delete(sessionId);
    try {
      const filePath = path.join(this.config.dataDir, `${sessionId}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {}

    this.eventBus.publish(
      "queue.cleared",
      { sessionId },
      "queue-manager",
    );
  }

  /** Clear all queues */
  clearAll(): void {
    this.queues.clear();
    this.processing.clear();
  }

  /** Update a queue item's message content */
  updateItem(itemId: string, message: string): QueueItem | undefined {
    const item = this.findItem(itemId);
    if (!item || item.status !== "pending") return undefined;

    item.message = message;
    this.persistQueue(item.sessionId);

    this.eventBus.publish(
      "queue.item_updated",
      { itemId, message: message.slice(0, 100) },
      "queue-manager",
    );

    return item;
  }

  /** Remove a queue item by ID */
  removeItem(itemId: string): boolean {
    const item = this.findItem(itemId);
    if (!item) return false;

    const queue = this.queues.get(item.sessionId);
    if (!queue) return false;

    const idx = queue.findIndex((q) => q.id === itemId);
    if (idx === -1) return false;

    queue.splice(idx, 1);
    this.persistQueue(item.sessionId);

    this.eventBus.publish(
      "queue.item_removed",
      { itemId },
      "queue-manager",
    );

    return true;
  }

  /** Reorder queue items for a session */
  reorderItems(sessionId: string, orderedIds: string[]): boolean {
    const queue = this.queues.get(sessionId);
    if (!queue) return false;

    const ordered: QueueItem[] = [];
    const idSet = new Set(orderedIds);

    // Place items in specified order
    for (const id of orderedIds) {
      const item = queue.find((q) => q.id === id);
      if (item) ordered.push(item);
    }

    // Append any items not in the order list
    for (const item of queue) {
      if (!idSet.has(item.id)) ordered.push(item);
    }

    this.queues.set(sessionId, ordered);
    this.persistQueue(sessionId);

    this.eventBus.publish(
      "queue.reordered",
      { sessionId, count: orderedIds.length },
      "queue-manager",
    );

    return true;
  }

  /** Get all session IDs that have queues */
  getAllSessions(): string[] {
    return Array.from(this.queues.keys());
  }

  /** Move an item up or down in the queue */
  moveItem(sessionId: string, itemId: string, direction: "up" | "down"): boolean {
    const queue = this.queues.get(sessionId);
    if (!queue) return false;

    const idx = queue.findIndex((q) => q.id === itemId);
    if (idx === -1) return false;

    if (direction === "up" && idx > 0) {
      [queue[idx - 1], queue[idx]] = [queue[idx], queue[idx - 1]];
    } else if (direction === "down" && idx < queue.length - 1) {
      [queue[idx + 1], queue[idx]] = [queue[idx], queue[idx + 1]];
    } else {
      return false;
    }

    this.persistQueue(sessionId);

    this.eventBus.publish(
      "queue.item_moved",
      { sessionId, itemId, direction },
      "queue-manager",
    );

    return true;
  }

  // ====== Load persisted queues on startup ======

  loadPersistedQueues(): void {
    try {
      if (!fs.existsSync(this.config.dataDir)) return;

      const files = fs.readdirSync(this.config.dataDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        const sessionId = file.replace(".json", "");
        try {
          const data = JSON.parse(
            fs.readFileSync(path.join(this.config.dataDir, file), "utf-8"),
          );
          if (Array.isArray(data) && data.length > 0) {
            this.queues.set(sessionId, data);
            console.log(
              `[QueueManager] Loaded queue for session "${sessionId}": ${data.length} items`,
            );
          }
        } catch (err) {
          console.warn(
            `[QueueManager] Failed to load queue for "${sessionId}": ${err}`,
          );
        }
      }
    } catch (err) {
      console.warn(`[QueueManager] Failed to load persisted queues: ${err}`);
    }
  }

  // ====== Private ======

  private getOrCreateQueue(sessionId: string): QueueItem[] {
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = [];
      this.queues.set(sessionId, queue);
    }
    return queue;
  }

  private findItem(itemId: string): QueueItem | undefined {
    for (const queue of this.queues.values()) {
      const found = queue.find((q) => q.id === itemId);
      if (found) return found;
    }
    return this.processing.get(itemId);
  }

  private persistQueue(sessionId: string): void {
    if (!this.config.persistQueue) return;
    try {
      const queue = this.queues.get(sessionId);
      if (!queue || queue.length === 0) return;

      const filePath = path.join(this.config.dataDir, `${sessionId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(queue, null, 2), "utf-8");
    } catch (err) {
      console.warn(`[QueueManager] Failed to persist queue: ${err}`);
    }
  }
}