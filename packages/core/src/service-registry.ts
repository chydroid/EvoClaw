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
    // 先停止旧服务（若存在且实现了 IService.stop）。replaceService 为同步方法，
    // stop() 可能是 async，采用 fire-and-forget + catch 避免阻塞调用方。
    const oldLifecycle = this.lifecycles.get(name);
    if (oldLifecycle && typeof (oldLifecycle as { stop?: unknown }).stop === "function") {
      Promise.resolve((oldLifecycle as IService).stop()).catch((err) => {
        process.stderr.write(
          `[ServiceRegistry] Old service "${name}" stop() error during replace: ${err}\n`,
        );
      });
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
    } else {
      // 新服务未实现 IService，移除旧生命周期条目避免悬挂引用
      this.lifecycles.delete(name);
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
      // 状态恢复到 running/stopped 时清除旧 error；传入 error 时覆盖；其它情况保留以供诊断
      if (status === "running" || status === "stopped") {
        info.error = undefined;
      }
      if (error !== undefined) {
        info.error = error;
      }
      if (status === "running") {
        info.startedAt = new Date();
      }
    }
  }

  async startAll(): Promise<void> {
    // 快照 entries，防止 service.start() 在迭代过程中注册/注销其他 service 修改 Map
    const entries = Array.from(this.services.entries());
    for (const [name] of entries) {
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
      // 重启时去重，保留最近一次启动顺序
      const idx = this.startOrder.indexOf(name);
      if (idx !== -1) this.startOrder.splice(idx, 1);
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
    // 快照 entries，避免 healthCheck() 在迭代过程中注册/注销 service 修改 Map 导致迭代错乱
    const entries = Array.from(this.services.entries());
    for (const [name] of entries) {
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