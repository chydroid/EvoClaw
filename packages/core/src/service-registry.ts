import type { IPluginRegistry, IService, ServiceInfo, ServiceStatus } from "./types/plugin";

export class ServiceRegistry implements IPluginRegistry {
  private services = new Map<string, unknown>();
  private serviceInfos = new Map<string, ServiceInfo>();
  private lifecycles = new Map<string, IService>();
  private startOrder: string[] = [];

  registerService<T>(name: string, service: T): void {
    if (this.services.has(name)) {
      throw new Error(`Service "${name}" is already registered`);
    }
    this.services.set(name, service);
    this.serviceInfos.set(name, {
      name,
      version: "0.0.0",
      status: "running",
      dependencies: [],
    });

    if (this.isIService(service)) {
      this.lifecycles.set(name, service);
    }
  }

  /** Replace an already-registered service, or register if not present */
  replaceService<T>(name: string, service: T): void {
    this.services.set(name, service);
    this.serviceInfos.set(name, {
      name,
      version: "0.0.0",
      status: "running",
      dependencies: [],
    });

    if (this.isIService(service)) {
      this.lifecycles.set(name, service);
    }
  }

  /** Remove a service entry from the registry. No-op if not present. */
  unregisterService(name: string): void {
    this.services.delete(name);
    this.serviceInfos.delete(name);
    this.lifecycles.delete(name);
    this.startOrder = this.startOrder.filter((n) => n !== name);
  }

  resolveService<T>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  hasService(name: string): boolean {
    return this.services.has(name);
  }

  getRegisteredServices(): string[] {
    return Array.from(this.services.keys());
  }

  getServiceInfo(name: string): ServiceInfo | undefined {
    return this.serviceInfos.get(name);
  }

  getAllServiceInfos(): ServiceInfo[] {
    return Array.from(this.serviceInfos.values());
  }

  setServiceStatus(name: string, status: ServiceStatus, error?: string): void {
    const info = this.serviceInfos.get(name);
    if (info) {
      info.status = status;
      if (error) info.error = error;
      if (status === "running") {
        info.startedAt = new Date();
      }
    }
  }

  async startAll(): Promise<void> {
    for (const [name] of this.services) {
      await this.startService(name);
    }
  }

  async stopAll(): Promise<void> {
    const reversed = [...this.startOrder].reverse();
    for (const name of reversed) {
      await this.stopService(name);
    }
  }

  private async startService(name: string): Promise<void> {
    const service = this.lifecycles.get(name);
    if (!service) return;

    // Idempotency: skip if already running or starting
    const info = this.serviceInfos.get(name);
    if (info && (info.status === "running" || info.status === "starting")) {
      return;
    }

    this.setServiceStatus(name, "starting");

    try {
      await service.start();
      this.setServiceStatus(name, "running");
      this.startOrder.push(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setServiceStatus(name, "error", message);
      throw err;
    }
  }

  private async stopService(name: string): Promise<void> {
    const service = this.lifecycles.get(name);
    if (!service) return;

    this.setServiceStatus(name, "stopping");

    try {
      await service.stop();
      this.setServiceStatus(name, "stopped");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setServiceStatus(name, "error", message);
    }
  }

  async healthCheckAll(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    for (const [name] of this.services) {
      const service = this.lifecycles.get(name);
      if (service) {
        try {
          results.set(name, await service.healthCheck());
        } catch {
          results.set(name, false);
        }
      }
    }
    return results;
  }

  private isIService(obj: unknown): obj is IService {
    return (
      typeof obj === "object" &&
      obj !== null &&
      "start" in obj &&
      "stop" in obj &&
      "healthCheck" in obj
    );
  }
}