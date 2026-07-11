import {
  ServiceRegistry,
  EventBus,
  type EvolutionCandidate,
  type HotReloadEvent,
} from "@evoclaw/core";

export class HotReloadManager {
  private reloadQueue: HotReloadEvent[] = [];
  private isReloading = false;
  private scheduledTimeout: NodeJS.Timeout | null = null;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

  async publish(candidate: EvolutionCandidate): Promise<void> {
    // 清理可能挂起的延迟处理定时器，避免与新事件重复处理
    if (this.scheduledTimeout) {
      clearTimeout(this.scheduledTimeout);
      this.scheduledTimeout = null;
    }

    const event: HotReloadEvent = {
      skillId: candidate.id,
      action: candidate.type === "new_skill" ? "install" : "update",
      newVersion: "1.0.0",
      strategy: "graceful",
    };

    this.reloadQueue.push(event);
    await this.processQueue();
  }

  async scheduleUpdate(skillId: string, newVersion: string, strategy: "immediate" | "graceful" | "canary" = "graceful"): Promise<void> {
    const event: HotReloadEvent = {
      skillId,
      action: "update",
      newVersion,
      oldVersion: "current",
      strategy,
    };

    this.reloadQueue.push(event);

    if (strategy === "immediate") {
      await this.processQueue();
    } else {
      if (this.scheduledTimeout) {
        clearTimeout(this.scheduledTimeout);
      }
      this.scheduledTimeout = setTimeout(() => {
        this.scheduledTimeout = null;
        void this.processQueue().catch((err) => {
          process.stderr.write("[HotReloadManager] processQueue failed:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
        });
      }, 5000);
      this.scheduledTimeout.unref();
    }
  }

  async rollback(skillId: string, oldVersion: string): Promise<void> {
    // 清理可能挂起的延迟处理定时器，回滚需立即处理
    if (this.scheduledTimeout) {
      clearTimeout(this.scheduledTimeout);
      this.scheduledTimeout = null;
    }

    const event: HotReloadEvent = {
      skillId,
      action: "rollback",
      oldVersion,
      strategy: "immediate",
    };

    this.reloadQueue.push(event);
    await this.processQueue();
  }

  /** 停止管理器，清理挂起的定时器和待处理队列 */
  stop(): void {
    if (this.scheduledTimeout) {
      clearTimeout(this.scheduledTimeout);
      this.scheduledTimeout = null;
    }
    this.reloadQueue = [];
    this.isReloading = false;
  }

  private async processQueue(): Promise<void> {
    if (this.isReloading) return;
    this.isReloading = true;

    try {
      // Drain the queue, but do not let a single event failure take the
      // whole batch down. Each event is processed in its own try/catch so
      // the loop keeps going and `isReloading` is always released, even
      // when the publisher throws. The remaining items in the queue are
      // processed in subsequent calls (or by the same loop) so events
      // are not silently lost.
      while (this.reloadQueue.length > 0) {
        const event = this.reloadQueue.shift()!;
        try {
          await this.processEvent(event);
        } catch (err) {
          process.stderr.write(
            `[HotReload] Failed to process ${event.action} for "${event.skillId}":` + " " + (err instanceof Error ? err.message : String(err)) + "\n"
          );
          // Continue with the next event rather than aborting the batch.
        }
      }
    } finally {
      this.isReloading = false;
    }
  }

  private async processEvent(event: HotReloadEvent): Promise<void> {
    process.stdout.write(
      `[HotReload] ${event.action} skill "${event.skillId}" (${event.strategy})\n`
    );

    switch (event.action) {
      case "install":
        await this.eventBus.publish("evolution.hotreload", event, "hot-reload");
        break;
      case "update":
        await this.eventBus.publish("evolution.hotreload", event, "hot-reload");
        break;
      case "remove":
        await this.eventBus.publish("evolution.hotreload", event, "hot-reload");
        break;
      case "rollback":
        await this.eventBus.publish("evolution.rollback", event, "hot-reload");
        break;
    }
  }
}