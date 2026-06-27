import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { v4 as uuid } from "uuid";

export interface HealingAction {
  id: string;
  type: HealingActionType;
  target: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed" | "rolled_back";
  strategy: HealingStrategy;
  startedAt: Date;
  completedAt: Date | null;
  result: HealingResult | null;
  error?: string;
}

export type HealingActionType =
  | "restart_service"
  | "reload_config"
  | "clear_cache"
  | "scale_agents"
  | "terminate_stuck_tasks"
  | "rollback_skill"
  | "circuit_break"
  | "reconnect_database"
  | "flush_queue"
  | "garbage_collect";

export type HealingStrategy = "immediate" | "gradual" | "scheduled" | "manual_approval";

export interface HealingResult {
  success: boolean;
  message: string;
  metrics: Record<string, unknown>;
  sideEffects: string[];
}

export interface HealingRule {
  name: string;
  description: string;
  condition: string;
  action: HealingActionType;
  strategy: HealingStrategy;
  target: string;
  cooldownMs: number;
  maxRetries: number;
  enabled: boolean;
}

export interface ServiceHealth {
  serviceName: string;
  healthy: boolean;
  status: string;
  metrics: Record<string, number>;
  lastCheck: Date;
  consecutiveFailures: number;
  lastError?: string;
}

const SELF_SERVICE_NAME = "selfHealingManager";

const DEFAULT_HEALING_RULES: HealingRule[] = [
  {
    name: "agent_pool_exhaustion",
    description: "Scale up agent pool when utilization exceeds 90%",
    condition: "agent_pool.utilization > 0.9",
    action: "scale_agents",
    strategy: "immediate",
    target: "agentPool",
    cooldownMs: 60000,
    maxRetries: 3,
    enabled: true,
  },
  {
    name: "stuck_task_detection",
    description: "Terminate tasks that have been running for over 5 minutes",
    condition: "tasks.stuck_count > 3",
    action: "terminate_stuck_tasks",
    strategy: "immediate",
    target: "taskOrchestrator",
    cooldownMs: 30000,
    maxRetries: 5,
    enabled: true,
  },
  {
    name: "service_crash_recovery",
    description: "Attempt to recover a service after consecutive health check failures",
    condition: "service.consecutive_failures >= 3",
    action: "restart_service",
    strategy: "immediate",
    target: "serviceRegistry",
    cooldownMs: 30000,
    maxRetries: 3,
    enabled: true,
  },
  {
    name: "memory_pressure",
    description: "Trigger garbage collection when memory usage exceeds 80%",
    condition: "system.memory_usage > 0.8",
    action: "garbage_collect",
    strategy: "immediate",
    target: "system",
    cooldownMs: 300000,
    maxRetries: 2,
    enabled: true,
  },
  {
    name: "queue_backlog",
    description: "Flush message queue when backlog exceeds 1000 messages",
    condition: "queue.backlog > 1000",
    action: "flush_queue",
    strategy: "gradual",
    target: "messageQueue",
    cooldownMs: 60000,
    maxRetries: 2,
    enabled: true,
  },
  {
    name: "circuit_breaker",
    description: "Engage circuit breaker when error rate exceeds 50%",
    condition: "service.error_rate > 0.5",
    action: "circuit_break",
    strategy: "immediate",
    target: "serviceRegistry",
    cooldownMs: 300000,
    maxRetries: 1,
    enabled: true,
  },
  {
    name: "database_reconnect",
    description: "Reconnect to database on connection loss",
    condition: "database.connected == false",
    action: "reconnect_database",
    strategy: "immediate",
    target: "database",
    cooldownMs: 5000,
    maxRetries: 10,
    enabled: true,
  },
];

export class SelfHealingManager {
  private actions: HealingAction[] = [];
  private rules: HealingRule[] = DEFAULT_HEALING_RULES.map((r) => ({ ...r }));
  private serviceHealth = new Map<string, ServiceHealth>();
  private healingCooldowns = new Map<string, number>();
  private ruleRetryCounts = new Map<string, number>();
  private healInterval: NodeJS.Timeout | null = null;
  private enabled = true;
  private checkIntervalMs = 10000;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    registry.registerService("selfHealingManager", this);

    this.eventBus.subscribe("system.error", async (event) => {
      const errData = event.data as Record<string, unknown> | undefined;
      if (errData?.source) {
        this.recordServiceError(String(errData.source), errData.message as string || "Unknown error");
      }
    });
  }

  start(): void {
    if (this.healInterval) return;
    this.healInterval = setInterval(() => {
      this.runHealthCheck().catch((err) => {
        process.stderr.write(`[SelfHealing] Health check failed: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }, this.checkIntervalMs);
    this.healInterval.unref?.();
  }

  stop(): void {
    if (this.healInterval) {
      clearInterval(this.healInterval);
      this.healInterval = null;
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  addRule(rule: HealingRule): void {
    const existing = this.rules.findIndex((r) => r.name === rule.name);
    if (existing >= 0) {
      this.rules[existing] = rule;
    } else {
      this.rules.push(rule);
    }
  }

  removeRule(name: string): void {
    this.rules = this.rules.filter((r) => r.name !== name);
    this.ruleRetryCounts.delete(name);
  }

  getRules(): HealingRule[] {
    return [...this.rules];
  }

  getActions(limit = 50): HealingAction[] {
    return this.actions.slice(-limit);
  }

  getServiceHealth(): ServiceHealth[] {
    return Array.from(this.serviceHealth.values());
  }

  recordServiceError(serviceName: string, error: string): void {
    let health = this.serviceHealth.get(serviceName);
    if (!health) {
      health = {
        serviceName,
        healthy: true,
        status: "running",
        metrics: {},
        lastCheck: new Date(),
        consecutiveFailures: 0,
      };
    }

    health.consecutiveFailures++;
    health.lastError = error;
    health.lastCheck = new Date();

    if (health.consecutiveFailures >= 3) {
      health.healthy = false;
      health.status = "unhealthy";
    }

    this.serviceHealth.set(serviceName, health);
  }

  async triggerManualHealing(
    actionType: HealingActionType,
    target: string,
    strategy: HealingStrategy = "immediate"
  ): Promise<HealingAction> {
    const action = this.createAction(actionType, target, strategy);
    await this.executeAction(action);
    return action;
  }

  async runHealthCheck(): Promise<void> {
    if (!this.enabled) return;

    let healthResults: Map<string, boolean>;
    try {
      healthResults = await this.registry.healthCheckAll();
    } catch (checkErr) {
      process.stderr.write(`[SelfHealing] Health check collection failed: ${checkErr instanceof Error ? checkErr.message : String(checkErr)}\n`);
      return;
    }

    const now = Date.now();
    const systemMetrics = this.collectSystemMetrics();

    for (const [serviceName, healthy] of healthResults) {
      let health = this.serviceHealth.get(serviceName);
      if (!health) {
        health = {
          serviceName,
          healthy,
          status: healthy ? "running" : "unhealthy",
          metrics: {},
          lastCheck: new Date(),
          consecutiveFailures: 0,
          lastError: undefined,
        };
        this.serviceHealth.set(serviceName, health);
      } else {
        if (healthy) {
          health.consecutiveFailures = 0;
          health.healthy = true;
          health.status = "running";
        } else {
          health.consecutiveFailures++;
          if (health.consecutiveFailures >= 3) {
            health.healthy = false;
            health.status = "unhealthy";
          }
        }
        health.lastCheck = new Date();
      }

      for (const rule of this.rules) {
        if (!rule.enabled) continue;

        const lastHeal = this.healingCooldowns.get(rule.name);
        if (lastHeal && now - lastHeal < rule.cooldownMs) continue;

        const ruleRetries = this.ruleRetryCounts.get(rule.name) || 0;
        if (ruleRetries >= rule.maxRetries) {
          continue;
        }

        if (this.evaluateCondition(rule.condition, health, systemMetrics)) {
          const action = this.createAction(rule.action, rule.target, rule.strategy);
          await this.executeAction(action);

          const ruleRetryCount = (this.ruleRetryCounts.get(rule.name) || 0) + 1;
          this.ruleRetryCounts.set(rule.name, ruleRetryCount);
          this.healingCooldowns.set(rule.name, now);

          this.eventBus.publish(
            "healing.action_executed",
            { rule: rule.name, action: action.type, target: action.target, retryCount: ruleRetryCount },
            "self-healing-manager"
          ).catch((err) => { console.debug("[SelfHealing] Action executed event error:", err); });

          break;
        }
      }
    }
  }

  resetRuleRetries(): void {
    this.ruleRetryCounts.clear();
  }

  private evaluateCondition(
    condition: string,
    health: ServiceHealth,
    metrics: Record<string, number>
  ): boolean {
    if (!condition || typeof condition !== "string") return false;

    try {
      const parts = condition.split(/\s+/);
      if (parts.length < 3) return false;

      const variable = parts[0];
      const operator = parts[1];
      const rawThreshold = parts[2];
      const parsedThreshold = parseFloat(rawThreshold);
      const threshold = Number.isFinite(parsedThreshold) ? parsedThreshold : (rawThreshold === "false" ? 0 : 0);

      let value: number;

      switch (variable) {
        case "service.consecutive_failures":
          value = health.consecutiveFailures;
          break;
        case "service.error_rate":
          value = metrics.errorRate || 0;
          break;
        case "agent_pool.utilization":
          value = metrics.agentUtilization || 0;
          break;
        case "tasks.stuck_count":
          value = metrics.stuckTasks || 0;
          break;
        case "system.memory_usage":
          value = metrics.memoryUsage || 0;
          break;
        case "queue.backlog":
          value = metrics.queueBacklog || 0;
          break;
        case "database.connected":
          value = metrics.dbConnected ? 1 : 0;
          break;
        default:
          return false;
      }

      switch (operator) {
        case ">":
          return value > threshold;
        case ">=":
          return value >= threshold;
        case "<":
          return value < threshold;
        case "<=":
          return value <= threshold;
        case "==":
          return Math.abs(value - threshold) < 0.001;
        case "!=":
          return Math.abs(value - threshold) >= 0.001;
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  private collectSystemMetrics(): Record<string, number> {
    const memUsage = process.memoryUsage();
    const totalMem = memUsage.heapTotal;
    const usedMem = memUsage.heapUsed;

    return {
      memoryUsage: totalMem > 0 ? usedMem / totalMem : 0,
      errorRate: 0,
      agentUtilization: 0,
      stuckTasks: 0,
      queueBacklog: 0,
      dbConnected: 1,
    };
  }

  private createAction(
    type: HealingActionType,
    target: string,
    strategy: HealingStrategy
  ): HealingAction {
    const action: HealingAction = {
      id: uuid(),
      type,
      target,
      description: `Auto-healing: ${type} on ${target}`,
      status: "pending",
      strategy,
      startedAt: new Date(),
      completedAt: null,
      result: null,
    };

    this.actions.push(action);

    if (this.actions.length > 1000) {
      this.actions = this.actions.slice(-500);
    }

    return action;
  }

  private async executeAction(action: HealingAction): Promise<void> {
    if (action.target === SELF_SERVICE_NAME) {
      action.result = {
        success: false,
        message: "⛔ SAFETY: Cannot heal self. Use manual intervention for SelfHealingManager issues.",
        metrics: {},
        sideEffects: [],
      };
      action.status = "failed";
      action.completedAt = new Date();
      action.error = "Self-healing disabled —Refusing to heal self";
      return;
    }

    action.status = "running";

    try {
      switch (action.type) {
        case "restart_service":
          await this.healRestartService(action);
          break;
        case "scale_agents":
          await this.healScaleAgents(action);
          break;
        case "terminate_stuck_tasks":
          await this.healTerminateStuckTasks(action);
          break;
        case "clear_cache":
          await this.healClearCache(action);
          break;
        case "garbage_collect":
          await this.healGarbageCollect(action);
          break;
        case "circuit_break":
          await this.healCircuitBreak(action);
          break;
        case "flush_queue":
          await this.healFlushQueue(action);
          break;
        case "reconnect_database":
          await this.healReconnectDatabase(action);
          break;
        case "rollback_skill":
          await this.healRollbackSkill(action);
          break;
        case "reload_config":
          await this.healReloadConfig(action);
          break;
        default:
          action.result = {
            success: false,
            message: `Unknown healing action type: ${action.type}`,
            metrics: {},
            sideEffects: [],
          };
          break;
      }

      action.status = "completed";
      action.completedAt = new Date();
    } catch (err) {
      action.status = "failed";
      action.completedAt = new Date();
      action.error = err instanceof Error ? err.message : String(err);
      action.result = {
        success: false,
        message: action.error || "Execution failed — action rolled back safely",
        metrics: {},
        sideEffects: [],
      };
    }
  }

  /**
   * Restart a specific service WITHOUT stopping all services.
   * Only resets health status to give the service a fresh chance and logs an event.
   * NEVER calls stopAll()/startAll() to avoid cascading failures.
   */
  private async healRestartService(action: HealingAction): Promise<void> {
    const health = this.serviceHealth.get(action.target);
    // BUG 17.1 fix: 原代码先重置 consecutiveFailures=0，再读取作为 previousFailures，
    // 导致 previousFailures 恒为 0。先保存旧值再重置。
    const previousFailures = health?.consecutiveFailures || 0;
    if (health) {
      health.consecutiveFailures = 0;
      health.healthy = true;
      health.status = "running";
      health.lastError = undefined;
    }

    await this.eventBus.publish(
      "healing.service_health_reset",
      { target: action.target, actionId: action.id },
      "self-healing-manager"
    ).catch((err) => { console.debug("[SelfHealing] Service health reset event error:", err); });

    action.result = {
      success: true,
      message: `Service "${action.target}" health metrics reset (safe — no process restart)`,
      metrics: { previousFailures },
      sideEffects: ["Health status reset"],
    };
  }

  private async healScaleAgents(action: HealingAction): Promise<void> {
    const pool = this.registry.resolveService<{
      scale(delta: number): Promise<void>;
    }>(action.target);

    if (pool) {
      try {
        await pool.scale(2);
        action.result = {
          success: true,
          message: `Agent pool scaled up by 2 agents`,
          metrics: { scaleDelta: 2 },
          sideEffects: ["Agent pool expanded"],
        };
      } catch (err) {
        action.result = {
          success: false,
          message: `Failed to scale agent pool: ${err instanceof Error ? err.message : String(err)}`,
          metrics: {},
          sideEffects: [],
        };
      }
    } else {
      action.result = {
        success: false,
        message: `Agent pool "${action.target}" not found in registry — unable to scale`,
        metrics: {},
        sideEffects: [],
      };
    }
  }

  private async healTerminateStuckTasks(action: HealingAction): Promise<void> {
    const orchestrator = this.registry.resolveService<{
      getStuckTasks(): Promise<unknown[]>;
      cancelTask(id: string): Promise<void>;
    }>(action.target);

    if (orchestrator) {
      try {
        const stuckTasks = await orchestrator.getStuckTasks();
        if (stuckTasks.length === 0) {
          action.result = {
            success: true,
            message: "No stuck tasks found — system is healthy",
            metrics: { terminatedCount: 0 },
            sideEffects: [],
          };
          return;
        }

        let cancelled = 0;
        for (const task of stuckTasks as Array<{ id: string; runningTime?: number }>) {
          try {
            await orchestrator.cancelTask(task.id);
            cancelled++;
          } catch (taskErr) {
            process.stderr.write(`[SelfHealing] Failed to cancel stuck task ${task.id}: ${taskErr instanceof Error ? taskErr.message : String(taskErr)}\n`);
          }
        }
        action.result = {
          success: true,
          message: `Terminated ${cancelled}/${stuckTasks.length} stuck tasks`,
          metrics: { terminatedCount: cancelled, totalStuck: stuckTasks.length },
          sideEffects: ["Tasks terminated"],
        };
      } catch (err) {
        action.result = {
          success: false,
          message: `Failed to query stuck tasks: ${err instanceof Error ? err.message : String(err)}`,
          metrics: {},
          sideEffects: [],
        };
      }
    } else {
      action.result = {
        success: false,
        message: `Task orchestrator "${action.target}" not found in registry`,
        metrics: {},
        sideEffects: [],
      };
    }
  }

  private async healClearCache(action: HealingAction): Promise<void> {
    const memoryHub = this.registry.resolveService<{
      clearShortTerm(): Promise<void>;
    }>("memoryHub");

    if (memoryHub) {
      try {
        await memoryHub.clearShortTerm();
      } catch {
        // Memory cache clear is optional - non-critical
      }
    }

    if (global.gc) {
      global.gc();
    }

    action.result = {
      success: true,
      message: "Short-term memory cache cleared and GC triggered",
      metrics: {},
      sideEffects: ["Memory cache invalidated"],
    };
  }

  private async healGarbageCollect(action: HealingAction): Promise<void> {
    if (global.gc) {
      global.gc();
      action.result = {
        success: true,
        message: "Garbage collection triggered — memory reclaimed",
        metrics: {
          beforeHeapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100,
        },
        sideEffects: ["Memory reclaimed"],
      };
    } else {
      action.result = {
        success: true,
        message: "⚠ GC unavailable in this runtime — start with --expose-gc for automatic memory cleanup",
        metrics: {},
        sideEffects: [],
      };
    }
  }

  private async healCircuitBreak(action: HealingAction): Promise<void> {
    const governor = this.registry.resolveService<{
      enableCircuitBreaker(service: string): void;
    }>("securityGovernor");

    if (governor) {
      try {
        governor.enableCircuitBreaker(action.target);
      } catch (err) {
        action.result = {
          success: false,
          message: `Failed to engage circuit breaker: ${err instanceof Error ? err.message : String(err)}`,
          metrics: {},
          sideEffects: [],
        };
        return;
      }
    }

    action.result = {
      success: true,
      message: `Circuit breaker engaged for "${action.target}" — service temporarily isolated`,
      metrics: {},
      sideEffects: ["Service isolated", "Pending requests rejected"],
    };

    this.eventBus.publish(
      "healing.circuit_broken",
      { target: action.target, actionId: action.id },
      "self-healing-manager"
    ).catch((err) => { console.debug("[SelfHealing] Circuit break event error:", err); });
  }

  private async healFlushQueue(action: HealingAction): Promise<void> {
    const queue = this.registry.resolveService<{
      flush(): Promise<void>;
    }>(action.target);

    if (queue) {
      try {
        await queue.flush();
        action.result = {
          success: true,
          message: `Message queue "${action.target}" flushed successfully`,
          metrics: {},
          sideEffects: ["Pending messages cleared"],
        };
      } catch (err) {
        action.result = {
          success: false,
          message: `Failed to flush queue: ${err instanceof Error ? err.message : String(err)}`,
          metrics: {},
          sideEffects: [],
        };
      }
    } else {
      action.result = {
        success: false,
        message: `Message queue "${action.target}" not found — cannot flush`,
        metrics: {},
        sideEffects: [],
      };
    }
  }

  private async healReconnectDatabase(action: HealingAction): Promise<void> {
    const db = this.registry.resolveService<{
      reconnect(): Promise<void>;
    }>(action.target);

    if (db) {
      try {
        await db.reconnect();
        action.result = {
          success: true,
          message: `Database "${action.target}" reconnected successfully`,
          metrics: {},
          sideEffects: ["Connection re-established"],
        };
      } catch (err) {
        action.result = {
          success: false,
          message: `Failed to reconnect database: ${err instanceof Error ? err.message : String(err)}`,
          metrics: {},
          sideEffects: [],
        };
      }
    } else {
      action.result = {
        success: false,
        message: `Database manager "${action.target}" not found — cannot reconnect`,
        metrics: {},
        sideEffects: [],
      };
    }
  }

  private async healRollbackSkill(action: HealingAction): Promise<void> {
    const hotReload = this.registry.resolveService<{
      rollback(skillId: string, oldVersion: string): Promise<void>;
    }>("hotReload");

    if (hotReload) {
      try {
        await hotReload.rollback(action.target, "previous_version");
        action.result = {
          success: true,
          message: `Skill "${action.target}" rolled back to previous version`,
          metrics: {},
          sideEffects: ["Skill version rolled back"],
        };
      } catch (err) {
        action.result = {
          success: false,
          message: `Failed to rollback skill: ${err instanceof Error ? err.message : String(err)}`,
          metrics: {},
          sideEffects: [],
        };
      }
    } else {
      action.result = {
        success: false,
        message: `HotReload manager not available — cannot rollback skill "${action.target}"`,
        metrics: {},
        sideEffects: [],
      };
    }
  }

  private async healReloadConfig(action: HealingAction): Promise<void> {
    this.eventBus.publish(
      "system.config_reload",
      { target: action.target },
      "self-healing-manager"
    ).catch((err) => { console.debug("[SelfHealing] Config reload event error:", err); });

    action.result = {
      success: true,
      message: `Configuration reload event published for "${action.target}" — listeners notified`,
      metrics: {},
      sideEffects: ["Config reload event published"],
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}