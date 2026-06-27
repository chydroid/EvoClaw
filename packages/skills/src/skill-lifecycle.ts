import {
  ServiceRegistry,
  EventBus,
  type SkillLifecycle,
  type HealthCheckResult,
  type Skill,
  type SkillStatus,
  type SkillUsageRecord,
} from "@evoclaw/core";

export type { SkillUsageRecord };

export interface HealthMonitorConfig {
  checkInterval: number;
  maxRetries: number;
  retryDelay: number;
  autoRecover: boolean;
  decayThreshold: number;
}

export interface HealthHistory {
  timestamp: Date;
  healthy: boolean;
  errors: string[];
  responseTime: number;
}

export interface SkillHealthReport {
  skillId: string;
  skillName: string;
  currentStatus: SkillStatus;
  healthy: boolean;
  totalChecks: number;
  successRate: number;
  averageResponseTime: number;
  lastError: string | null;
  history: HealthHistory[];
  recommendation: string;
}

export class SkillLifecycleManager {
  private healthMonitors = new Map<string, NodeJS.Timeout>();
  private healthHistories = new Map<string, HealthHistory[]>();
  private retryCounts = new Map<string, number>();
  private config: HealthMonitorConfig;

  // Lifecycle state machine
  private usageRecords: Map<string, SkillUsageRecord> = new Map();
  private staleSince: Map<string, Date> = new Map();

  // Thresholds (configurable)
  private staleAfterDays: number = 30;     // No usage for 30 days → stale
  private archiveAfterDays: number = 90;   // Stale for 90 days → archived
  private lowSuccessRate: number = 0.2;    // Success rate < 20% → stale
  private minUsesForRateCheck: number = 5; // Minimum uses before checking success rate

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.config = {
      checkInterval: 30000,
      maxRetries: 3,
      retryDelay: 5000,
      autoRecover: true,
      decayThreshold: 0.5,
    };
  }

  configure(config: Partial<HealthMonitorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Configure lifecycle thresholds */
  configureLifecycleThresholds(opts: {
    staleAfterDays?: number;
    archiveAfterDays?: number;
    lowSuccessRate?: number;
    minUsesForRateCheck?: number;
  }): void {
    if (opts.staleAfterDays !== undefined) this.staleAfterDays = opts.staleAfterDays;
    if (opts.archiveAfterDays !== undefined) this.archiveAfterDays = opts.archiveAfterDays;
    if (opts.lowSuccessRate !== undefined) this.lowSuccessRate = opts.lowSuccessRate;
    if (opts.minUsesForRateCheck !== undefined) this.minUsesForRateCheck = opts.minUsesForRateCheck;
  }

  /** Record a skill usage */
  recordUsage(skillId: string, success: boolean, error?: string): void {
    const existing = this.usageRecords.get(skillId);
    const now = new Date();

    if (existing) {
      existing.lastUsedAt = now;
      existing.useCount += 1;
      if (success) {
        existing.successCount += 1;
      } else {
        existing.failureCount += 1;
        existing.lastFailureAt = now;
        existing.lastFailureReason = error ?? null;
      }
    } else {
      this.usageRecords.set(skillId, {
        skillId,
        lastUsedAt: now,
        useCount: 1,
        successCount: success ? 1 : 0,
        failureCount: success ? 0 : 1,
        lastFailureAt: success ? null : now,
        lastFailureReason: success ? null : (error ?? null),
      });
    }
  }

  /** Check and transition skill lifecycle states */
  checkTransitions(): Array<{ skillId: string; from: SkillStatus; to: SkillStatus; reason: string }> {
    const transitions: Array<{ skillId: string; from: SkillStatus; to: SkillStatus; reason: string }> = [];
    const now = new Date();

    const skillManager = this.registry.resolveService<{
      getSkill(id: string): Skill | undefined;
      listSkills(): Skill[];
    }>("skillManager");

    if (!skillManager) return transitions;

    for (const [skillId, record] of this.usageRecords) {
      const skill = skillManager.getSkill(skillId);
      if (!skill) continue;

      const currentStatus = skill.lifecycle.status;

      // active → stale: no usage for staleAfterDays
      if (currentStatus === "active") {
        const daysSinceLastUse = (now.getTime() - record.lastUsedAt.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceLastUse >= this.staleAfterDays) {
          transitions.push({
            skillId,
            from: currentStatus,
            to: "stale",
            reason: `No usage for ${Math.round(daysSinceLastUse)} days (threshold: ${this.staleAfterDays} days)`,
          });
          continue;
        }

        // active → stale: low success rate (min 5 uses)
        if (record.useCount >= this.minUsesForRateCheck) {
          const successRate = record.successCount / record.useCount;
          if (successRate < this.lowSuccessRate) {
            transitions.push({
              skillId,
              from: currentStatus,
              to: "stale",
              reason: `Low success rate ${(successRate * 100).toFixed(1)}% (${record.successCount}/${record.useCount}, threshold: ${this.lowSuccessRate * 100}%)`,
            });
            continue;
          }
        }
      }

      // stale → archived: no usage for archiveAfterDays since becoming stale
      if (currentStatus === "stale") {
        const staleDate = this.staleSince.get(skillId);
        if (staleDate) {
          const daysStale = (now.getTime() - staleDate.getTime()) / (1000 * 60 * 60 * 24);
          if (daysStale >= this.archiveAfterDays) {
            transitions.push({
              skillId,
              from: currentStatus,
              to: "archived",
              reason: `Stale for ${Math.round(daysStale)} days (threshold: ${this.archiveAfterDays} days)`,
            });
            continue;
          }
        }
      }

      // stale → active: used successfully
      if (currentStatus === "stale") {
        const lastRecordedUse = record.lastUsedAt;
        const staleDate = this.staleSince.get(skillId);
        // If the skill was used after it became stale, and the last use was successful
        if (staleDate && lastRecordedUse > staleDate) {
          const lastUseSuccess = record.successCount > 0 &&
            (record.lastFailureAt === null || record.lastUsedAt > record.lastFailureAt);
          if (lastUseSuccess) {
            transitions.push({
              skillId,
              from: currentStatus,
              to: "active",
              reason: "Successfully used after becoming stale",
            });
            continue;
          }
        }
      }
    }

    return transitions;
  }

  /** Get usage stats for a skill */
  getUsageStats(skillId: string): SkillUsageRecord | undefined {
    return this.usageRecords.get(skillId);
  }

  /** Run periodic lifecycle check (called by scheduler) */
  async runPeriodicCheck(): Promise<void> {
    const transitions = this.checkTransitions();

    const skillManager = this.registry.resolveService<{
      getSkill(id: string): Skill | undefined;
    }>("skillManager");

    for (const transition of transitions) {
      if (!skillManager) continue;

      const skill = skillManager.getSkill(transition.skillId);
      if (!skill) continue;

      // Update skill status
      skill.lifecycle.status = transition.to;
      skill.lifecycle.lastUpdated = new Date();

      // Track stale timestamp
      if (transition.to === "stale") {
        this.staleSince.set(transition.skillId, new Date());
      } else if (transition.to === "active") {
        this.staleSince.delete(transition.skillId);
      } else if (transition.to === "archived") {
        this.staleSince.delete(transition.skillId);
      }

      // Log the transition
      process.stdout.write(
        `[SkillLifecycle] Transition: ${transition.skillId} ${transition.from} → ${transition.to} (${transition.reason})`
      );

      // Publish event via EventBus
      await this.eventBus.publish(
        "skill.lifecycle.transition",
        {
          skillId: transition.skillId,
          from: transition.from,
          to: transition.to,
          reason: transition.reason,
          timestamp: new Date(),
        },
        "skill-lifecycle"
      ).catch((err) => {
        process.stderr.write(`[SkillLifecycle] Failed to publish transition event for ${transition.skillId}:` + " " + err);
      });
    }
  }

  createLifecycle(version: string): SkillLifecycle {
    return {
      status: "draft",
      version,
      installDate: new Date(),
      lastUpdated: new Date(),
      healthCheck: null,
    };
  }

  activate(skill: Skill): void {
    skill.lifecycle.status = "active";
    skill.lifecycle.lastUpdated = new Date();

    this.eventBus?.publish(
      "skill.activated",
      { skillId: skill.id, name: skill.name },
      "skill-lifecycle"
    ).catch((err) => { console.debug("[SkillLifecycle] Init error:", err); });

    if (this.config.autoRecover) {
      this.startHealthMonitoring(skill);
    }
  }

  deactivate(skill: Skill): void {
    skill.lifecycle.status = "disabled";
    skill.lifecycle.lastUpdated = new Date();

    this.stopHealthMonitoring(skill.id);

    this.eventBus?.publish(
      "skill.deactivated",
      { skillId: skill.id, name: skill.name },
      "skill-lifecycle"
    ).catch((err) => { console.debug("[SkillLifecycle] Deactivate error:", err); });
  }

  update(skill: Skill, newVersion: string): void {
    skill.lifecycle.status = "updating";
    skill.lifecycle.version = newVersion;
    skill.lifecycle.lastUpdated = new Date();

    this.stopHealthMonitoring(skill.id);
  }

  async performHealthCheck(
    skill: Skill,
    executeFn?: (skillId: string, params: Record<string, unknown>) => Promise<{ success: boolean; errors: string[] }>
  ): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      let healthy = true;
      const errors: string[] = [];
      const missingDependencies: string[] = [];

      if (skill.lifecycle.status !== "active") {
        errors.push(`Skill is not active (status: ${skill.lifecycle.status})`);
        healthy = false;
      }

      for (const dep of skill.requires || []) {
        if (!dep.optional) {
          const installed = this.registry.resolveService<{
            hasService(name: string): boolean;
          }>("skillManager");
          const registry = this.registry.resolveService<{
            searchLocal(query: Record<string, unknown>): { entries: Array<{ name: string }> };
          }>("skillRegistry");
          let found = false;
          if (registry) {
            const results = registry.searchLocal({ keyword: dep.name });
            found = results.entries.some((e) => e.name === dep.name);
          }
          if (!found) {
            missingDependencies.push(dep.name);
          }
        }
      }

      if (executeFn) {
        try {
          const testResult = await executeFn(skill.id, { _healthCheck: true });
          if (!testResult.success) {
            errors.push(...testResult.errors);
            healthy = false;
          }
        } catch (err) {
          errors.push(
            `Health check execution failed: ${err instanceof Error ? err.message : String(err)}`
          );
          healthy = false;
        }
      }

      const result: HealthCheckResult = {
        healthy,
        lastCheck: new Date(),
        errors,
        missingDependencies,
      };

      this.recordHealthHistory(skill.id, result, Date.now() - startTime);

      skill.lifecycle.healthCheck = result;

      if (!healthy) {
        this.handleUnhealthy(skill, result);
      }

      return result;
    } catch (err) {
      const result: HealthCheckResult = {
        healthy: false,
        lastCheck: new Date(),
        errors: [err instanceof Error ? err.message : String(err)],
        missingDependencies: [],
      };

      this.recordHealthHistory(skill.id, result, Date.now() - startTime);
      this.handleUnhealthy(skill, result);

      return result;
    }
  }

  startHealthMonitoring(skill: Skill): void {
    this.stopHealthMonitoring(skill.id);

    const intervalId = setInterval(async () => {
      await this.performHealthCheck(skill).catch((err) => { process.stderr.write(`[SkillLifecycle] Health check failed for "${skill.id}":` + " " + err); });
    }, this.config.checkInterval);
    intervalId.unref();

    this.healthMonitors.set(skill.id, intervalId);
  }

  stopHealthMonitoring(skillId: string): void {
    const existing = this.healthMonitors.get(skillId);
    if (existing) {
      clearInterval(existing);
      this.healthMonitors.delete(skillId);
    }
    // 同时清理待触发的重试定时器，否则技能停用后重试仍会触发并打到已停用的技能。
    const retryKey = `retry:${skillId}`;
    const retryTimer = this.healthMonitors.get(retryKey);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.healthMonitors.delete(retryKey);
    }
  }

  /**
   * 关闭所有健康监控和重试定时器。服务器关闭时调用，防止定时器泄漏。
   */
  shutdown(): void {
    for (const [, timer] of this.healthMonitors) {
      // setInterval 和 setTimeout 句柄都可以被 clearTimeout/clearInterval 清理
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.healthMonitors.clear();
    this.retryCounts.clear();
  }

  getHealthReport(skill: Skill): SkillHealthReport {
    const history = this.healthHistories.get(skill.id) || [];

    const totalChecks = history.length;
    const healthyChecks = history.filter((h) => h.healthy).length;
    const successRate = totalChecks > 0 ? healthyChecks / totalChecks : 1;

    const averageResponseTime =
      totalChecks > 0
        ? history.reduce((sum, h) => sum + h.responseTime, 0) / totalChecks
        : 0;

    const lastError =
      history.length > 0 && !history[history.length - 1].healthy
        ? history[history.length - 1].errors.join("; ")
        : null;

    const recommendation = this.generateRecommendation(
      skill,
      successRate,
      history
    );

    return {
      skillId: skill.id,
      skillName: skill.name,
      currentStatus: skill.lifecycle.status,
      healthy: skill.lifecycle.healthCheck?.healthy ?? true,
      totalChecks,
      successRate: Math.round(successRate * 100) / 100,
      averageResponseTime: Math.round(averageResponseTime),
      lastError,
      history: history.slice(-20),
      recommendation,
    };
  }

  getAllHealthReports(): SkillHealthReport[] {
    const skillManager = this.registry.resolveService("skillManager") as
      | { listSkills: () => Skill[] }
      | undefined;

    if (!skillManager) {
      return [];
    }

    const skills = skillManager.listSkills();
    return skills.map((skill) => ({
      skillId: skill.id,
      skillName: skill.name,
      currentStatus: skill.lifecycle.status,
      healthy: skill.lifecycle.healthCheck?.healthy ?? true,
      totalChecks: skill.stats?.invocationCount ?? 0,
      successRate: skill.stats?.invocationCount
        ? skill.stats.successCount / skill.stats.invocationCount
        : 1,
      averageResponseTime: skill.stats?.averageDuration ?? 0,
      lastError: skill.lifecycle.healthCheck?.errors?.[0] ?? null,
      history: [],
      recommendation: skill.lifecycle.healthCheck?.healthy
        ? "Skill is healthy"
        : skill.lifecycle.healthCheck?.errors?.join("; ") || "Health check failed",
    }));
  }

  private handleUnhealthy(skill: Skill, result: HealthCheckResult): void {
    const retries = this.retryCounts.get(skill.id) || 0;

    if (!this.config.autoRecover) return;

    if (retries < this.config.maxRetries) {
      this.retryCounts.set(skill.id, retries + 1);

      const decay = retries * this.config.retryDelay;

      const retryTimeoutId = setTimeout(() => {
        // 定时器触发后从 Map 移除条目，避免条目无限累积导致内存增长。
        this.healthMonitors.delete(`retry:${skill.id}`);
        void this.performHealthCheck(skill).catch((err) => {
          process.stderr.write(`[SkillLifecycle] Retry health check failed for "${skill.id}":` + " " + err + "\n");
        });
      }, this.config.retryDelay + decay);
      retryTimeoutId.unref();

      this.healthMonitors.set(`retry:${skill.id}`, retryTimeoutId);
    } else {
      skill.lifecycle.status = "error";

      this.eventBus?.publish(
        "skill.critical_health_failure",
        {
          skillId: skill.id,
          name: skill.name,
          retries,
          errors: result.errors,
          recommendation: "Manual intervention required - skill has exceeded max retry limit",
        },
        "skill-lifecycle"
      ).catch((err) => { console.debug("[SkillLifecycle] Health monitor error:", err); });

      this.retryCounts.delete(skill.id);
    }
  }

  private recordHealthHistory(
    skillId: string,
    result: HealthCheckResult,
    responseTime: number
  ): void {
    const history = this.healthHistories.get(skillId) || [];
    history.push({
      timestamp: new Date(),
      healthy: result.healthy,
      errors: result.errors,
      responseTime,
    });

    if (history.length > 100) {
      history.splice(0, history.length - 100);
    }

    this.healthHistories.set(skillId, history);

    if (!result.healthy) {
      this.eventBus?.publish(
        "skill.health_issue",
        {
          skillId,
          errors: result.errors,
          timestamp: new Date(),
        },
        "skill-lifecycle"
      ).catch((err) => { console.debug("[SkillLifecycle] Recovery error:", err); });
    }

    if (result.healthy) {
      this.retryCounts.delete(skillId);
    }
  }

  private generateRecommendation(
    skill: Skill,
    successRate: number,
    history: HealthHistory[]
  ): string {
    if (skill.lifecycle.status === "error") {
      const recentErrors = history
        .slice(-5)
        .filter((h) => !h.healthy)
        .flatMap((h) => h.errors);

      if (recentErrors.length > 0) {
        const topError = recentErrors[0];
        return `Skill is in error state. Most recent issue: "${topError}". Consider reinstalling or updating this skill.`;
      }
      return "Skill is in error state. Review the health history for details.";
    }

    if (successRate < 0.5) {
      return `Low health rate (${Math.round(successRate * 100)}%). Consider updating or replacing this skill.`;
    }

    if (successRate < 0.8) {
      return `Moderate health rate (${Math.round(successRate * 100)}%). Monitor closely and check for intermittent issues.`;
    }

    if (successRate >= 0.95) {
      return "Skill is performing excellently with high reliability.";
    }

    return "Skill is healthy with normal operation.";
  }
}