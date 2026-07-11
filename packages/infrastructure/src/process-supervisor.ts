import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { randomUUID } from "crypto";

/**
 * SpawnFn 返回的进程句柄。
 * onExit 为可选字段：若 SpawnFn 实现提供，则 ProcessSupervisor 通过它即时感知退出；
 * 否则仅能通过手动 healthCheck 探测。
 */
export interface SpawnResult {
  pid: number;
  stop: () => Promise<void>;
  onExit?: (cb: () => void) => void;
}

export type SpawnFn = () => Promise<SpawnResult>;

export interface RestartPolicy {
  maxRestarts: number;
  restartDelay: number;
  backoffMultiplier: number;
  maxRestartDelay: number;
  windowSize: number;
}

export interface RegisterOptions {
  policy?: Partial<RestartPolicy>;
  healthCheck?: () => Promise<boolean>;
  autoStart?: boolean;
}

export interface SupervisedProcess {
  name: string;
  pid: number | null;
  status: "running" | "stopped" | "crashed" | "restarting";
  startTime: Date | null;
  restartCount: number;
  lastError: string | null;
}

const DEFAULT_POLICY: RestartPolicy = {
  maxRestarts: 5,
  restartDelay: 1000,
  backoffMultiplier: 2,
  maxRestartDelay: 30000,
  windowSize: 60000,
};

interface ManagedProcess {
  name: string;
  spawnFn: SpawnFn;
  policy: RestartPolicy;
  healthCheckFn?: () => Promise<boolean>;
  handle: SpawnResult | null;
  status: SupervisedProcess["status"];
  startTime: Date | null;
  restartCount: number;
  lastError: string | null;
  restartTimestamps: number[];
  restartTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

/**
 * 轻量级进程监督器：注册进程、自动重启（指数退避 + 滑动窗口限流）、健康检查、事件通知。
 * 借鉴 hermes-agent s6-overlay 的进程监督思路，在应用层实现等效的崩溃自动恢复。
 */
export class ProcessSupervisor {
  private processes = new Map<string, ManagedProcess>();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    registry.registerService("processSupervisor", this);
  }

  register(name: string, spawnFn: SpawnFn, options: RegisterOptions = {}): void {
    if (this.processes.has(name)) {
      throw new Error(`Process "${name}" is already registered`);
    }
    const policy: RestartPolicy = { ...DEFAULT_POLICY, ...options.policy };
    const managed: ManagedProcess = {
      name,
      spawnFn,
      policy,
      healthCheckFn: options.healthCheck,
      handle: null,
      status: "stopped",
      startTime: null,
      restartCount: 0,
      lastError: null,
      restartTimestamps: [],
      restartTimer: null,
      stopped: false,
    };
    this.processes.set(name, managed);
    if (options.autoStart) {
      this.start(name).catch((err) => {
        process.stderr.write(
          `[ProcessSupervisor] autoStart failed for "${name}": ${err instanceof Error ? err.message : String(err)}\n`
        );
      });
    }
  }

  async start(name: string): Promise<void> {
    const proc = this.processes.get(name);
    if (!proc) throw new Error(`Process "${name}" is not registered`);
    if (proc.status === "running" || proc.status === "restarting") return;
    proc.stopped = false;
    await this.doSpawn(proc);
  }

  async stop(name: string): Promise<void> {
    const proc = this.processes.get(name);
    if (!proc) throw new Error(`Process "${name}" is not registered`);
    proc.stopped = true;
    if (proc.restartTimer) {
      clearTimeout(proc.restartTimer);
      proc.restartTimer = null;
    }
    if (proc.handle) {
      try {
        await proc.handle.stop();
      } catch (err) {
        proc.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    proc.handle = null;
    proc.status = "stopped";
    await this.eventBus.publish(
      "supervisor.process.stopped",
      { name: proc.name },
      "process-supervisor"
    );
  }

  async restart(name: string): Promise<void> {
    const proc = this.processes.get(name);
    if (!proc) throw new Error(`Process "${name}" is not registered`);
    if (proc.restartTimer) {
      clearTimeout(proc.restartTimer);
      proc.restartTimer = null;
    }
    if (proc.handle) {
      proc.stopped = true;
      try {
        await proc.handle.stop();
      } catch (err) {
        proc.lastError = err instanceof Error ? err.message : String(err);
      }
      proc.handle = null;
    }
    proc.stopped = false;
    proc.status = "restarting";
    await this.eventBus.publish(
      "supervisor.process.restarted",
      { name: proc.name, restartId: randomUUID() },
      "process-supervisor"
    );
    await this.doSpawn(proc);
  }

  async healthCheck(name: string): Promise<boolean> {
    const proc = this.processes.get(name);
    if (!proc) throw new Error(`Process "${name}" is not registered`);
    if (proc.status !== "running" || !proc.handle) return false;
    if (proc.healthCheckFn) {
      try {
        return await proc.healthCheckFn();
      } catch {
        return false;
      }
    }
    try {
      process.kill(proc.handle.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  getStatus(name: string): SupervisedProcess | undefined {
    const proc = this.processes.get(name);
    if (!proc) return undefined;
    return {
      name: proc.name,
      pid: proc.handle?.pid ?? null,
      status: proc.status,
      startTime: proc.startTime,
      restartCount: proc.restartCount,
      lastError: proc.lastError,
    };
  }

  async cleanup(): Promise<void> {
    const names = Array.from(this.processes.keys());
    await Promise.all(names.map((name) => this.stop(name)));
  }

  private async doSpawn(proc: ManagedProcess): Promise<void> {
    if (proc.restartTimer) {
      clearTimeout(proc.restartTimer);
      proc.restartTimer = null;
    }
    try {
      const handle = await proc.spawnFn();
      proc.handle = handle;
      proc.status = "running";
      proc.startTime = new Date();
      proc.lastError = null;

      if (handle.onExit) {
        const currentHandle = handle;
        handle.onExit(() => {
          // 用户主动 stop 时不触发自动重启
          if (proc.stopped) return;
          // 防止旧句柄的退出事件影响新句柄
          if (proc.handle !== currentHandle) return;
          this.handleExit(proc).catch((err) => {
            process.stderr.write(
              `[ProcessSupervisor] exit handler error for "${proc.name}": ${err instanceof Error ? err.message : String(err)}\n`
            );
          });
        });
      }

      await this.eventBus.publish(
        "supervisor.process.started",
        { name: proc.name, pid: handle.pid },
        "process-supervisor"
      );
    } catch (err) {
      proc.lastError = err instanceof Error ? err.message : String(err);
      proc.status = "crashed";
      await this.eventBus.publish(
        "supervisor.process.crashed",
        { name: proc.name, error: proc.lastError, crashId: randomUUID() },
        "process-supervisor"
      );
      this.scheduleRestart(proc);
    }
  }

  private async handleExit(proc: ManagedProcess): Promise<void> {
    if (proc.stopped) {
      proc.status = "stopped";
      return;
    }
    proc.handle = null;
    proc.status = "crashed";
    proc.lastError = "Process exited unexpectedly";
    await this.eventBus.publish(
      "supervisor.process.crashed",
      { name: proc.name, error: proc.lastError, crashId: randomUUID() },
      "process-supervisor"
    );
    this.scheduleRestart(proc);
  }

  private scheduleRestart(proc: ManagedProcess): void {
    if (proc.stopped) return;

    const now = Date.now();
    // 清理滑动窗口外的旧重启时间戳
    proc.restartTimestamps = proc.restartTimestamps.filter(
      (ts) => now - ts < proc.policy.windowSize
    );

    // 窗口内重启次数已达上限，停止重启
    if (proc.restartTimestamps.length >= proc.policy.maxRestarts) {
      proc.status = "crashed";
      process.stderr.write(
        `[ProcessSupervisor] Process "${proc.name}" exceeded max restarts (${proc.policy.maxRestarts}) within window (${proc.policy.windowSize}ms). Stopping.\n`
      );
      return;
    }

    // 指数退避延迟
    const attempt = proc.restartTimestamps.length;
    const delay = Math.min(
      proc.policy.restartDelay * Math.pow(proc.policy.backoffMultiplier, attempt),
      proc.policy.maxRestartDelay
    );

    proc.status = "restarting";
    proc.restartTimestamps.push(now);
    proc.restartCount++;

    proc.restartTimer = setTimeout(() => {
      proc.restartTimer = null;
      this.doSpawn(proc).catch((err) => {
        process.stderr.write(
          `[ProcessSupervisor] Restart failed for "${proc.name}": ${err instanceof Error ? err.message : String(err)}\n`
        );
      });
    }, delay);
    proc.restartTimer.unref();
  }
}
