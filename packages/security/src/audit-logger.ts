import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { v4 as uuid } from "uuid";

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

  async clear(): Promise<void> {
    this.logs = [];
  }
}