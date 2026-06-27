// Heartbeat mechanism for AgentModelExecutor
// Extracted from agent-model-executor.ts for modularity

import type { ServiceRegistry, EventBus, MemorySearchResult } from "@evoclaw/core";
import type { QueueManager } from "./queue-manager";
import type { AgentLifecycleManager } from "./agent-lifecycle";

/** Heartbeat status information */
export interface HeartbeatStatus {
  enabled: boolean;
  active: boolean;
  intervalMs: number;
  lastFireTime: Date | null;
  nextFireTime: Date | null;
  isIdle: boolean;
  activeConversations: number;
}

/** Callback type for heartbeat fire events */
export type HeartbeatCallback = () => Promise<void>;

/** Dependencies for the HeartbeatManager's onHeartbeat handler */
export interface HeartbeatHandlerDeps {
  registry: ServiceRegistry;
  eventBus: EventBus;
  queueManager: QueueManager | null;
  lifecycleManager: AgentLifecycleManager | null;
  memoryHub: {
    getLongTerm(): {
      search(query: { query: string; tags?: string[]; limit: number }): Promise<MemorySearchResult[]>;
    };
  } | null;
  /** Called to process a queued message via chat() */
  processChatMessage: (message: string, options: { sessionId: string; channel: string; peerId: string }) => Promise<{ reply: string }>;
}

/**
 * Manages the heartbeat mechanism — a periodic timer that fires when the agent is idle
 * to process queued messages, cron tasks, and memory reminders.
 */
export class HeartbeatManager {
  private intervalMs: number = 1_800_000; // 30 minutes default
  private enabled: boolean = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeatRunning = false;
  private lastFireTime: Date | null = null;
  private nextFireTime: Date | null = null;
  private activeConversations = new Set<string>();
  private handlerDeps: HeartbeatHandlerDeps | null = null;

  /**
   * Set the handler dependencies needed for onHeartbeat processing.
   * Must be called before start() if onHeartbeat is expected to work.
   */
  setHandlerDeps(deps: HeartbeatHandlerDeps): void {
    this.handlerDeps = deps;
  }

  /** Configure heartbeat settings */
  configure(config: { intervalMs?: number; enabled?: boolean }): void {
    if (config.intervalMs !== undefined) {
      this.intervalMs = Math.max(60_000, config.intervalMs); // minimum 1 minute
    }
    if (config.enabled !== undefined) {
      this.enabled = config.enabled;
    }
    // Restart timer if already running
    if (this.timer) {
      this.stop();
      if (this.enabled) {
        this.start();
      }
    }
    process.stdout.write(`[HeartbeatManager] Heartbeat configured: enabled=${this.enabled}, interval=${this.intervalMs}ms`);
  }

  /** Start the heartbeat timer */
  start(): void {
    if (this.timer) return; // already running
    if (!this.enabled) {
      process.stdout.write("[HeartbeatManager] Heartbeat is disabled, not starting timer");
      return;
    }

    this.nextFireTime = new Date(Date.now() + this.intervalMs);
    this.timer = setInterval(() => {
      if (this.heartbeatRunning) return; // 防止上一次心跳未完成时重叠执行
      this.heartbeatRunning = true;
      this.onHeartbeat()
        .catch((err) => {
          process.stderr.write("[HeartbeatManager] onHeartbeat failed:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
        })
        .finally(() => { this.heartbeatRunning = false; });
    }, this.intervalMs);
    // unref 防止心跳定时器阻止进程优雅退出（依赖 stop() 才能清理时，SIGTERM 期间会卡住）
    this.timer.unref();
    process.stdout.write(`[HeartbeatManager] Heartbeat started (interval: ${this.intervalMs}ms, next fire: ${this.nextFireTime.toISOString()})`);
  }

  /** Stop the heartbeat timer */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.nextFireTime = null;
      process.stdout.write("[HeartbeatManager] Heartbeat stopped");
    }
  }

  /** Mark a session as actively processing (pauses heartbeat for that session) */
  markSessionActive(sessionId: string): void {
    this.activeConversations.add(sessionId);
  }

  /** Mark a session as idle (resumes heartbeat eligibility) */
  markSessionIdle(sessionId: string): void {
    this.activeConversations.delete(sessionId);
  }

  /** Check if the agent is currently idle (no active conversations) */
  isIdle(): boolean {
    return this.activeConversations.size === 0;
  }

  /** Get current heartbeat status */
  getStatus(): HeartbeatStatus {
    return {
      enabled: this.enabled,
      active: this.timer !== null,
      intervalMs: this.intervalMs,
      lastFireTime: this.lastFireTime,
      nextFireTime: this.nextFireTime,
      isIdle: this.isIdle(),
      activeConversations: this.activeConversations.size,
    };
  }

  /** Internal heartbeat handler — fires periodically when agent is idle */
  private async onHeartbeat(): Promise<void> {
    // Skip if agent is actively processing conversations
    if (!this.isIdle()) {
      process.stdout.write("[HeartbeatManager] Heartbeat skipped — agent is busy");
      this.nextFireTime = new Date(Date.now() + this.intervalMs);
      return;
    }

    this.lastFireTime = new Date();
    this.nextFireTime = new Date(Date.now() + this.intervalMs);

    process.stdout.write(`[HeartbeatManager] Heartbeat fired at ${this.lastFireTime.toISOString()}`);

    const heartbeatResults: {
      queueItemsProcessed: number;
      cronTasksDue: number;
      memoryReminders: number;
    } = {
      queueItemsProcessed: 0,
      cronTasksDue: 0,
      memoryReminders: 0,
    };

    try {
      if (!this.handlerDeps) {
        process.stderr.write("[HeartbeatManager] No handler deps set, skipping heartbeat processing");
        return;
      }

      const { registry, eventBus, queueManager, lifecycleManager, memoryHub, processChatMessage } = this.handlerDeps;

      // 1. Check for pending queue messages and process the next one
      if (queueManager) {
        const sessions = queueManager.getAllSessions();
        for (const sessionId of sessions) {
          if (queueManager.hasPending(sessionId)) {
            const item = queueManager.dequeue(sessionId);
            if (item) {
              heartbeatResults.queueItemsProcessed++;
              process.stdout.write(`[HeartbeatManager] Heartbeat processing queued item [${item.mode}] for session "${sessionId}": "${item.message.slice(0, 80)}"`);
              try {
                const result = await processChatMessage(item.message, {
                  sessionId,
                  channel: "heartbeat",
                  peerId: "system",
                });
                queueManager.markDone(item.id, result.reply);
              } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                queueManager.markFailed(item.id, errorMsg);
                process.stderr.write(`[HeartbeatManager] Heartbeat queue item failed: ${errorMsg}`);
              }
              // Only process one item per heartbeat to avoid overload
              break;
            }
          }
        }
      }

      // 2. Check for scheduled cron tasks that are due
      const scheduleManager = registry.resolveService<{
        listTasks(): Array<{ id: string; name: string; enabled: boolean; nextRun?: Date; cronExpression: string }>;
        executeTask(taskId: string): Promise<{ success: boolean; error?: string }>;
      }>("scheduleManager");
      if (scheduleManager) {
        const now = new Date();
        const tasks = scheduleManager.listTasks();
        for (const task of tasks) {
          if (task.enabled && task.nextRun && new Date(task.nextRun) <= now) {
            heartbeatResults.cronTasksDue++;
            process.stdout.write(`[HeartbeatManager] Heartbeat found due cron task: "${task.name}" (${task.id})`);
            try {
              await scheduleManager.executeTask(task.id);
            } catch (err) {
              process.stderr.write(`[HeartbeatManager] Heartbeat cron task execution failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }

      // 3. Check memory for follow-up reminders
      if (memoryHub) {
        try {
          const results = await memoryHub.getLongTerm().search({
            query: "follow-up reminder todo 待办 提醒",
            tags: ["reminder", "follow-up", "todo"],
            limit: 5,
          });
          heartbeatResults.memoryReminders = results.length;
          if (results.length > 0) {
            process.stdout.write(`[HeartbeatManager] Heartbeat found ${results.length} memory reminders`);
          }
        } catch {
          // Memory search is best-effort
        }
      }

      // 4. Emit agent.heartbeat event via EventBus
      await eventBus.publish("agent.heartbeat", {
        timestamp: this.lastFireTime.toISOString(),
        isIdle: true,
        results: heartbeatResults,
      }, "agent-model-executor");

      // Also notify the lifecycle manager
      if (lifecycleManager) {
        lifecycleManager.heartbeat("system");
      }

    } catch (err) {
      process.stderr.write(`[HeartbeatManager] Heartbeat error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
