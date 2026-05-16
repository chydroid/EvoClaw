export interface Plugin {
  name: string;
  version: string;
  description: string;
  init(registry: IPluginRegistry): Promise<void>;
  shutdown(): Promise<void>;
}

export interface IPluginRegistry {
  registerService<T>(name: string, service: T): void;
  resolveService<T>(name: string): T | undefined;
  hasService(name: string): boolean;
  getRegisteredServices(): string[];
}

export interface IService {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<boolean>;
}

export type ServiceStatus = "uninitialized" | "starting" | "running" | "stopping" | "stopped" | "error";

export interface ServiceInfo {
  name: string;
  version: string;
  status: ServiceStatus;
  dependencies: string[];
  startedAt?: Date;
  uptime?: number;
  error?: string;
}

export interface ServiceLifecycle {
  preInit?(): Promise<void>;
  postInit?(): Promise<void>;
  preStart?(): Promise<void>;
  postStart?(): Promise<void>;
  preStop?(): Promise<void>;
  postStop?(): Promise<void>;
}