import { ServiceRegistry, EventBus } from "@evoclaw/core";

interface AuditEntry {
  timestamp: Date;
  actor: string;
  action: string;
  resource: string;
  result: "success" | "failure" | "blocked";
  details: Record<string, unknown>;
  traceId: string;
  ipAddress: string;
  userAgent: string;
}

export class AuditLogger {
  private logs: AuditEntry[] = [];
  private maxLogs = 10000;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

  async log(entry: AuditEntry): Promise<void> {
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      const dropped = this.logs.length - this.maxLogs;
      process.stderr.write(`[AuditLogger] log overflow: dropped ${dropped} oldest entries\n`);
      this.logs = this.logs.slice(-this.maxLogs);
    }
  }

  query(filters: {
    actor?: string;
    action?: string;
    result?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): AuditEntry[] {
    let results = this.logs;

    if (filters.actor) results = results.filter((l) => l.actor === filters.actor);
    if (filters.action) results = results.filter((l) => l.action.includes(filters.action!));
    if (filters.result) results = results.filter((l) => l.result === filters.result);
    if (filters.from) results = results.filter((l) => l.timestamp >= filters.from!);
    if (filters.to) results = results.filter((l) => l.timestamp <= filters.to!);

    return results.slice(-(filters.limit || 100));
  }

  async export(): Promise<AuditEntry[]> {
    return [...this.logs];
  }

  /**
   * 清空审计日志。需要管理员鉴权：调用方必须提供包含 "admin" 角色的 caller，
   * 否则拒绝执行。清空操作会记录警告日志，防止审计日志被无声抹除。
   */
  async clear(caller?: { userId?: string; roles?: string[] }): Promise<void> {
    const userId = caller?.userId ?? "unknown";
    const roles = caller?.roles ?? [];
    if (!roles.includes("admin")) {
      process.stderr.write(`[AuditLogger] clear denied for caller=${userId} roles=${JSON.stringify(roles)}\n`);
      throw new Error(`Access denied: clearing audit logs requires admin role (caller: ${userId})`);
    }
    process.stderr.write(`[AuditLogger] Audit logs cleared by admin=${userId} at ${new Date().toISOString()}\n`);
    this.logs = [];
  }
}