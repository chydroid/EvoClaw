import {
  ServiceRegistry,
  EventBus,
  type SkillLifecycle,
  type HealthCheckResult,
  type Skill,
  type SkillStatus,
} from "@evoclaw/core";

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

  createLifecycle(version: string): SkillLifecycle {
    return {
      status: "installed",
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
      await this.performHealthCheck(skill);
    }, this.config.checkInterval);

    this.healthMonitors.set(skill.id, intervalId);
  }

  stopHealthMonitoring(skillId: string): void {
    const existing = this.healthMonitors.get(skillId);
    if (existing) {
      clearInterval(existing);
      this.healthMonitors.delete(skillId);
    }
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

      const retryTimeoutId = setTimeout(async () => {
        await this.performHealthCheck(skill);
      }, this.config.retryDelay + decay);

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