import {
  ServiceRegistry,
  EventBus,
  type EvolutionCandidate,
  type HotReloadEvent,
} from "@evoclaw/core";

export class HotReloadManager {
  private reloadQueue: HotReloadEvent[] = [];
  private isReloading = false;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

  async publish(candidate: EvolutionCandidate): Promise<void> {
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
      setTimeout(() => this.processQueue(), 5000);
    }
  }

  async rollback(skillId: string, oldVersion: string): Promise<void> {
    const event: HotReloadEvent = {
      skillId,
      action: "rollback",
      oldVersion,
      strategy: "immediate",
    };

    this.reloadQueue.push(event);
    await this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isReloading) return;
    this.isReloading = true;

    try {
      while (this.reloadQueue.length > 0) {
        const event = this.reloadQueue.shift()!;
        await this.processEvent(event);
      }
    } finally {
      this.isReloading = false;
    }
  }

  private async processEvent(event: HotReloadEvent): Promise<void> {
    console.log(
      `[HotReload] ${event.action} skill "${event.skillId}" (${event.strategy})`
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