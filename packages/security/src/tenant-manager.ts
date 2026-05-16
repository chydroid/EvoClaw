import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { v4 as uuid } from "uuid";

export interface Tenant {
  id: string;
  name: string;
  displayName: string;
  description: string;
  status: "active" | "suspended" | "deleted";
  config: TenantConfig;
  quota: TenantQuota;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantConfig {
  allowedSkills: string[];
  allowedModels: string[];
  maxAgents: number;
  defaultLanguage: string;
  timezone: string;
  features: Record<string, boolean>;
  customSettings: Record<string, unknown>;
}

export interface TenantQuota {
  maxTasksPerDay: number;
  maxTokensPerDay: number;
  maxConcurrentTasks: number;
  maxStorageMB: number;
  maxSkills: number;
  maxEvolutionCyclesPerDay: number;
}

export interface TenantStats {
  tenantId: string;
  tasksToday: number;
  tokensToday: number;
  concurrentTasks: number;
  storageUsedMB: number;
  evolutionCyclesToday: number;
  lastActivityAt: Date;
}

const DEFAULT_QUOTA: TenantQuota = {
  maxTasksPerDay: 10000,
  maxTokensPerDay: 10000000,
  maxConcurrentTasks: 50,
  maxStorageMB: 1024,
  maxSkills: 100,
  maxEvolutionCyclesPerDay: 10,
};

export class TenantManager {
  private tenants = new Map<string, Tenant>();
  private tenantStats = new Map<string, TenantStats>();
  private defaultTenantId: string | null = null;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    registry.registerService("tenantManager", this);
  }

  createTenant(
    name: string,
    config: Partial<TenantConfig> = {},
    quota: Partial<TenantQuota> = {}
  ): Tenant {
    if (this.getTenantByName(name)) {
      throw new Error(`Tenant "${name}" already exists`);
    }

    const now = new Date();
    const tenant: Tenant = {
      id: uuid(),
      name,
      displayName: name,
      description: "",
      status: "active",
      config: {
        allowedSkills: config.allowedSkills || [],
        allowedModels: config.allowedModels || [],
        maxAgents: config.maxAgents || 5,
        defaultLanguage: config.defaultLanguage || "en",
        timezone: config.timezone || "UTC",
        features: config.features || {},
        customSettings: config.customSettings || {},
      },
      quota: { ...DEFAULT_QUOTA, ...quota },
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };

    this.tenants.set(tenant.id, tenant);
    this.tenantStats.set(tenant.id, this.createEmptyStats(tenant.id));

    if (!this.defaultTenantId) {
      this.defaultTenantId = tenant.id;
    }

    this.eventBus.publish("tenant.created", { tenantId: tenant.id, name }, "tenant-manager")
      .catch((err) => { console.debug("[TenantManager] Create error:", err); });

    return tenant;
  }

  getTenant(tenantId: string): Tenant | undefined {
    return this.tenants.get(tenantId);
  }

  getTenantByName(name: string): Tenant | undefined {
    for (const tenant of this.tenants.values()) {
      if (tenant.name === name) return tenant;
    }
    return undefined;
  }

  listTenants(status?: Tenant["status"]): Tenant[] {
    const tenants = Array.from(this.tenants.values());
    if (status) {
      return tenants.filter((t) => t.status === status);
    }
    return tenants;
  }

  updateTenant(tenantId: string, updates: Partial<Pick<Tenant, "displayName" | "description" | "config" | "quota" | "status">>): Tenant {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      throw new Error(`Tenant "${tenantId}" not found`);
    }

    if (updates.config) {
      tenant.config = { ...tenant.config, ...updates.config };
    }
    if (updates.quota) {
      tenant.quota = { ...tenant.quota, ...updates.quota };
    }
    if (updates.displayName !== undefined) tenant.displayName = updates.displayName;
    if (updates.description !== undefined) tenant.description = updates.description;
    const previousStatus = tenant.status;
    if (updates.status !== undefined) {
      tenant.status = updates.status;
      this.eventBus.publish(
        `tenant.${updates.status}`,
        { tenantId, previousStatus },
        "tenant-manager"
      ).catch((err) => { console.debug("[TenantManager] Status update error:", err); });
    }
    tenant.updatedAt = new Date();

    this.tenants.set(tenantId, tenant);
    return tenant;
  }

  deleteTenant(tenantId: string): void {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      throw new Error(`Tenant "${tenantId}" not found`);
    }

    tenant.status = "deleted";
    tenant.updatedAt = new Date();

    if (this.defaultTenantId === tenantId) {
      this.defaultTenantId = null;
      for (const t of this.tenants.values()) {
        if (t.status === "active" && t.id !== tenantId) {
          this.defaultTenantId = t.id;
          break;
        }
      }
    }

    this.eventBus.publish("tenant.deleted", { tenantId }, "tenant-manager")
      .catch((err) => { console.debug("[TenantManager] Delete event error:", err); });
  }

  getDefaultTenant(): Tenant | undefined {
    if (!this.defaultTenantId) return undefined;
    return this.tenants.get(this.defaultTenantId);
  }

  setDefaultTenant(tenantId: string): void {
    if (!this.tenants.has(tenantId)) {
      throw new Error(`Tenant "${tenantId}" not found`);
    }
    this.defaultTenantId = tenantId;
  }

  checkQuota(tenantId: string): { allowed: boolean; reason?: string } {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return { allowed: false, reason: "Tenant not found" };
    }

    if (tenant.status !== "active") {
      return { allowed: false, reason: `Tenant is ${tenant.status}` };
    }

    const stats = this.tenantStats.get(tenantId);
    if (!stats) return { allowed: true };

    const quota = tenant.quota;

    if (stats.tasksToday >= quota.maxTasksPerDay) {
      return { allowed: false, reason: `Daily task limit (${quota.maxTasksPerDay}) reached` };
    }
    if (stats.tokensToday >= quota.maxTokensPerDay) {
      return { allowed: false, reason: `Daily token limit (${quota.maxTokensPerDay}) reached` };
    }
    if (stats.concurrentTasks >= quota.maxConcurrentTasks) {
      return { allowed: false, reason: `Concurrent task limit (${quota.maxConcurrentTasks}) reached` };
    }
    if (stats.evolutionCyclesToday >= quota.maxEvolutionCyclesPerDay) {
      return { allowed: false, reason: `Daily evolution cycle limit (${quota.maxEvolutionCyclesPerDay}) reached` };
    }

    return { allowed: true };
  }

  trackTask(tenantId: string, tokensUsed: number): void {
    const stats = this.tenantStats.get(tenantId);
    if (!stats) return;

    stats.tasksToday++;
    stats.tokensToday += tokensUsed;
    stats.concurrentTasks++;
    stats.lastActivityAt = new Date();
  }

  untrackTask(tenantId: string): void {
    const stats = this.tenantStats.get(tenantId);
    if (!stats) return;

    stats.concurrentTasks = Math.max(0, stats.concurrentTasks - 1);
  }

  trackEvolutionCycle(tenantId: string): void {
    const stats = this.tenantStats.get(tenantId);
    if (!stats) return;

    stats.evolutionCyclesToday++;
    stats.lastActivityAt = new Date();
  }

  getTenantStats(tenantId: string): TenantStats | undefined {
    return this.tenantStats.get(tenantId);
  }

  getAllStats(): TenantStats[] {
    return Array.from(this.tenantStats.values());
  }

  resetDailyCounters(): void {
    for (const stats of this.tenantStats.values()) {
      stats.tasksToday = 0;
      stats.tokensToday = 0;
      stats.evolutionCyclesToday = 0;
    }
  }

  onSkillExecute(tenantId: string): boolean {
    const check = this.checkQuota(tenantId);
    if (!check.allowed) {
      this.eventBus.publish(
        "tenant.quota_exceeded",
        { tenantId, reason: check.reason },
        "tenant-manager"
      ).catch((err) => { console.debug("[TenantManager] Quota event error:", err); });
      return false;
    }
    return true;
  }

  private createEmptyStats(tenantId: string): TenantStats {
    return {
      tenantId,
      tasksToday: 0,
      tokensToday: 0,
      concurrentTasks: 0,
      storageUsedMB: 0,
      evolutionCyclesToday: 0,
      lastActivityAt: new Date(),
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}