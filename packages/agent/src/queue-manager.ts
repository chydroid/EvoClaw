/**
 * QueueManager — OpenClaw-style message queue system.
 *
 * Supports multiple queue modes:
 * - steer: The agent is directed to do something specific
 * - followup: A follow-up question or continuation
 * - collect: Collect results/feedback without interrupting
 * - interrupt: High-priority interruption to current task
 *
 * 改进（借鉴 openclaw command-queue.ts）：
 * 1. 命名车道（Named Lanes）：不同类型任务独立并发上限，避免相互阻塞
 * 2. generation 字段：处理 in-process restart 后的僵尸任务
 * 3. 队列等待诊断：queuedAheadAtEnqueue、warnAfterMs、onWait 回调
 * 4. 精细错误类型：区分车道清空、任务超时、网关排空
 */

import type { EventBus } from "@evoclaw/core";
import * as fs from "fs";
import * as path from "path";

export type QueueMode = "steer" | "followup" | "collect" | "interrupt";

/**
 * 命名车道（借鉴 openclaw CommandLane）。
 * 不同类型任务使用不同车道，避免相互阻塞。
 */
export type QueueLane = "main" | "cron" | "subagent" | "nested" | "background";

/** 车道默认并发上限 */
const LANE_MAX_CONCURRENT: Record<QueueLane, number> = {
  main: 3,
  cron: 2,
  subagent: 2,
  nested: 1,
  background: 1,
};

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
  /** 命名车道（借鉴 openclaw） */
  lane?: QueueLane;
  /** generation 标记（用于 in-process restart 后区分新旧任务） */
  generation?: number;
  /** 入队时前方排队任务数（诊断用） */
  queuedAheadAtEnqueue?: number;
  /** 入队时前方活跃任务数（诊断用） */
  activeAheadAtEnqueue?: number;
  /** 队列等待超时警告阈值（ms） */
  warnAfterMs?: number;
  /** 队列等待超时回调 */
  onWait?: (waitMs: number, queuedAhead: number) => void;
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

// ── 精细错误类型（借鉴 openclaw）───────────────────────────

/** 车道被清空时抛出 */
export class QueueLaneClearedError extends Error {
  constructor(public lane: QueueLane) {
    super(`Queue lane "${lane}" was cleared`);
    this.name = "QueueLaneClearedError";
  }
}

/** 任务超时时抛出 */
export class QueueTaskTimeoutError extends Error {
  constructor(public taskId: string, public timeoutMs: number) {
    super(`Queue task "${taskId}" timed out after ${timeoutMs}ms`);
    this.name = "QueueTaskTimeoutError";
  }
}

/** 网关排空中时抛出 */
export class QueueDrainingError extends Error {
  constructor() {
    super("Queue is draining, no new tasks accepted");
    this.name = "QueueDrainingError";
  }
}

// ── 车道状态 ───────────────────────────────────────────────

interface LaneState {
  lane: QueueLane;
  activeTaskIds: Set<string>;
  maxConcurrent: number;
  draining: boolean;
  /** generation 标记，restart 后递增 */
  generation: number;
}

export class QueueManager {
  private config: QueueConfig;
  private queues = new Map<string, QueueItem[]>();
  private processing = new Map<string, QueueItem>();
  private counter = 0;
  /** 车道状态映射 */
  private laneStates = new Map<QueueLane, LaneState>();
  /** 全局 generation（用于 in-process restart） */
  private globalGeneration = 0;
  /** 是否排空中 */
  private draining = false;

  constructor(
    private eventBus: EventBus,
    config?: Partial<QueueConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureDataDir();
    this.initLanes();
  }

  /** 初始化车道状态 */
  private initLanes(): void {
    for (const lane of ["main", "cron", "subagent", "nested", "background"] as QueueLane[]) {
      this.laneStates.set(lane, {
        lane,
        activeTaskIds: new Set(),
        maxConcurrent: LANE_MAX_CONCURRENT[lane],
        draining: false,
        generation: 0,
      });
    }
  }

  private ensureDataDir(): void {
    try {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    } catch (err) { process.stderr.write(`[QueueManager] Failed to create data directory "${this.config.dataDir}":` + " " + err); }
  }

  // ====== Enqueue ======

  /**
   * Add a message to the queue.
   *
   * 改进：
   * 1. 支持命名车道（lane 参数），不同车道独立并发上限
   * 2. 设置 generation 字段，用于 in-process restart 后区分新旧任务
   * 3. 记录 queuedAheadAtEnqueue 和 activeAheadAtEnqueue 诊断信息
   * 4. draining 状态时拒绝入队
   */
  enqueue(
    sessionId: string,
    message: string,
    mode: QueueMode = "steer",
    context?: Record<string, unknown>,
    priority?: number,
    lane: QueueLane = "main",
  ): QueueItem {
    // 检查排空状态
    if (this.draining) {
      throw new QueueDrainingError();
    }

    const queue = this.getOrCreateQueue(sessionId);

    // Enforce max queue size
    if (queue.length >= this.config.maxQueueSize) {
      // Remove lowest priority item
      queue.sort((a, b) => a.priority - b.priority);
      const removed = queue.shift();
      if (removed) {
        process.stderr.write(
          `[QueueManager] Queue full for session "${sessionId}", dropped item: ${removed.id}`,
        );
      }
    }

    // 记录入队时的诊断信息
    const pendingCount = queue.filter(q => q.status === "pending").length;
    const laneState = this.laneStates.get(lane);
    const activeCount = laneState?.activeTaskIds.size ?? 0;

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
      lane,
      generation: this.globalGeneration,
      queuedAheadAtEnqueue: pendingCount,
      activeAheadAtEnqueue: activeCount,
    };

    queue.push(item);

    // Sort by priority (highest first)
    queue.sort((a, b) => b.priority - a.priority);

    // Persist
    this.persistQueue(sessionId);

    this.eventBus.publish(
      "queue.item_added",
      { item, queueSize: queue.length, lane },
      "queue-manager",
    );

    process.stdout.write(
      `[QueueManager] Enqueued [${mode}] lane=${lane} for session "${sessionId}": "${message.slice(0, 80)}" (queue size: ${queue.length})`,
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

  /**
   * Get the next item to process (highest priority pending).
   *
   * 改进：车道并发控制。
   * 每个车道有独立的并发上限，避免某类任务占满所有资源。
   */
  dequeue(sessionId: string): QueueItem | undefined {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return undefined;

    const pending = queue.filter((q) => q.status === "pending");
    if (pending.length === 0) return undefined;

    // 找到第一个车道未满的 pending 任务
    for (const item of pending) {
      const lane = item.lane ?? "main";
      const laneState = this.laneStates.get(lane);
      if (laneState && laneState.activeTaskIds.size >= laneState.maxConcurrent) {
        // 该车道并发已满，跳过
        continue;
      }

      item.status = "processing";
      this.processing.set(item.id, item);

      // 更新车道活跃任务
      if (laneState) {
        laneState.activeTaskIds.add(item.id);
      }

      this.eventBus.publish(
        "queue.item_dequeued",
        { item, remainingCount: pending.length - 1, lane },
        "queue-manager",
      );

      return item;
    }

    // 所有车道都满了
    return undefined;
  }

  /** Mark item as done */
  markDone(itemId: string, result?: string): void {
    const item = this.findItem(itemId);
    if (!item) return;

    item.status = "done";
    item.result = result;
    this.processing.delete(itemId);

    // 更新车道活跃任务
    const lane = item.lane ?? "main";
    const laneState = this.laneStates.get(lane);
    laneState?.activeTaskIds.delete(itemId);

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

    // 更新车道活跃任务
    const lane = item.lane ?? "main";
    const laneState = this.laneStates.get(lane);
    laneState?.activeTaskIds.delete(itemId);

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

      process.stderr.write(
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

    process.stdout.write(
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
    // 重置车道状态
    for (const laneState of this.laneStates.values()) {
      laneState.activeTaskIds.clear();
    }
  }

  // ====== Lane Management（借鉴 openclaw）──────────────────

  /**
   * 获取车道统计信息。
   */
  getLaneStats(lane: QueueLane): {
    lane: QueueLane;
    active: number;
    maxConcurrent: number;
    pending: number;
    draining: boolean;
    generation: number;
  } {
    const laneState = this.laneStates.get(lane);
    if (!laneState) {
      return {
        lane,
        active: 0,
        maxConcurrent: LANE_MAX_CONCURRENT[lane],
        pending: 0,
        draining: false,
        generation: 0,
      };
    }

    // 统计该车道的 pending 任务
    let pending = 0;
    for (const queue of this.queues.values()) {
      pending += queue.filter(q => q.lane === lane && q.status === "pending").length;
    }

    return {
      lane,
      active: laneState.activeTaskIds.size,
      maxConcurrent: laneState.maxConcurrent,
      pending,
      draining: laneState.draining,
      generation: laneState.generation,
    };
  }

  /**
   * 清空指定车道的所有任务。
   * 借鉴 openclaw 的 CommandLaneClearedError 设计。
   */
  clearLane(lane: QueueLane): number {
    let cleared = 0;
    for (const [sessionId, queue] of this.queues) {
      const before = queue.length;
      const filtered = queue.filter(q => q.lane !== lane);
      const removed = before - filtered.length;
      if (removed > 0) {
        this.queues.set(sessionId, filtered);
        cleared += removed;
      }
    }

    // 清除车道活跃任务
    const laneState = this.laneStates.get(lane);
    laneState?.activeTaskIds.clear();

    this.eventBus.publish(
      "queue.lane_cleared",
      { lane, cleared },
      "queue-manager",
    );

    return cleared;
  }

  /**
   * 递增 generation（用于 in-process restart）。
   *
   * 借鉴 openclaw 的 generation 字段设计。
   * restart 后旧 generation 的任务可被识别并清理，避免僵尸任务残留。
   */
  bumpGeneration(): number {
    this.globalGeneration++;
    // 同步更新所有车道的 generation
    for (const laneState of this.laneStates.values()) {
      laneState.generation = this.globalGeneration;
    }

    this.eventBus.publish(
      "queue.generation_bumped",
      { generation: this.globalGeneration },
      "queue-manager",
    );

    return this.globalGeneration;
  }

  /**
   * 获取旧 generation 的僵尸任务。
   * 在 in-process restart 后调用，清理残留的旧任务。
   */
  getStaleTasks(): QueueItem[] {
    const stale: QueueItem[] = [];
    for (const queue of this.queues.values()) {
      for (const item of queue) {
        if (item.generation !== undefined && item.generation < this.globalGeneration) {
          stale.push(item);
        }
      }
    }
    return stale;
  }

  /**
   * 开始排空模式。
   * 排空期间拒绝新任务入队，等待现有任务完成。
   * 借鉴 openclaw 的 GatewayDrainingError 设计。
   */
  startDraining(): void {
    this.draining = true;
    for (const laneState of this.laneStates.values()) {
      laneState.draining = true;
    }

    this.eventBus.publish(
      "queue.draining_started",
      {},
      "queue-manager",
    );
  }

  /**
   * 停止排空模式，恢复正常接受任务。
   */
  stopDraining(): void {
    this.draining = false;
    for (const laneState of this.laneStates.values()) {
      laneState.draining = false;
    }

    this.eventBus.publish(
      "queue.draining_stopped",
      {},
      "queue-manager",
    );
  }

  /**
   * 检查是否正在排空。
   */
  isDraining(): boolean {
    return this.draining;
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
            process.stdout.write(
              `[QueueManager] Loaded queue for session "${sessionId}": ${data.length} items`,
            );
          }
        } catch (err) {
          process.stderr.write(
            `[QueueManager] Failed to load queue for "${sessionId}": ${err}`,
          );
        }
      }
    } catch (err) {
      process.stderr.write(`[QueueManager] Failed to load persisted queues: ${err}`);
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
      // 原子写入：写临时文件 + fsync + rename，避免部分写入导致文件损坏。
      // 与 @evoclaw/infrastructure 的 atomicWriteFile 同源模式（此处为同步版本，
      // 因为 persistQueue 的所有调用方均为同步签名）。
      const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
      const fd = fs.openSync(tmpPath, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify(queue, null, 2), "utf-8");
        fs.fsyncSync(fd);
      } catch (err) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw err;
      }
      fs.closeSync(fd);
      // 保留原文件权限位
      try {
        if (fs.existsSync(filePath)) {
          const st = fs.statSync(filePath);
          fs.chmodSync(tmpPath, st.mode);
        }
      } catch {
        // 权限复制失败不阻断写入
      }
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      process.stderr.write(`[QueueManager] Failed to persist queue: ${err}`);
    }
  }
}