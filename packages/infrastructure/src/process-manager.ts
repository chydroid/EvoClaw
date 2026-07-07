import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { ChildProcess, spawn } from "child_process";
import { v4 as uuid } from "uuid";

interface ProcessInfo {
  id: string;
  name: string;
  command: string;
  args: string[];
  status: "running" | "stopped" | "crashed";
  pid: number | null;
  startTime: Date | null;
  childProcess: ChildProcess | null;
}

export class ProcessManager {
  private processes = new Map<string, ProcessInfo>();
  // 已退出进程条目的保留上限，避免 Map 无限增长 + 持有已死 ChildProcess 引用
  private readonly maxExitedEntries = 100;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    registry.registerService("processManager", this);
  }

  async spawn(
    name: string,
    command: string,
    args: string[] = []
  ): Promise<string> {
    const id = uuid();
    const childProcess = spawn(command, args, {
      stdio: "pipe",
    });

    const processInfo: ProcessInfo = {
      id,
      name,
      command,
      args,
      status: "running",
      pid: childProcess.pid || null,
      startTime: new Date(),
      childProcess,
    };

    childProcess.on("exit", (code) => {
      processInfo.status = code === 0 ? "stopped" : "crashed";
      // 释放已死 ChildProcess 引用，允许 GC 回收底层资源
      processInfo.childProcess = null;
      processInfo.pid = null;
      this.eventBus.publish(
        "process.exited",
        { id, name, exitCode: code },
        "process-manager"
      ).catch((err) => process.stderr.write('[ProcessManager] event publish failed: ' + err + '\n'));
      this.trimExited();
    });

    childProcess.on("error", (err) => {
      processInfo.status = "crashed";
      processInfo.childProcess = null;
      processInfo.pid = null;
      this.eventBus.publish(
        "process.error",
        { id, name, error: err.message },
        "process-manager"
      ).catch((err) => process.stderr.write('[ProcessManager] event publish failed: ' + err + '\n'));
      this.trimExited();
    });

    childProcess.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(`[${name}] ${data.toString().trim()}\n`);
    });

    childProcess.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[${name}] ${data.toString().trim()}\n`);
    });

    this.processes.set(id, processInfo);
    return id;
  }

  /**
   * 当已退出进程条目超过上限时，按 FIFO 丢弃最旧的已退出条目，防止 Map 无限增长。
   * 仍在运行的进程条目不会被清理。
   */
  private trimExited(): void {
    const exited: string[] = [];
    for (const [id, info] of this.processes) {
      if (info.status !== "running") exited.push(id);
    }
    if (exited.length <= this.maxExitedEntries) return;
    const toRemove = exited.length - this.maxExitedEntries;
    for (let i = 0; i < toRemove; i++) {
      this.processes.delete(exited[i]);
    }
  }

  async kill(processId: string): Promise<void> {
    const proc = this.processes.get(processId);
    if (proc && proc.childProcess) {
      const child = proc.childProcess;
      // 安全：若进程已退出，立即返回而非等满 5s SIGKILL 定时器
      if (child.exitCode !== null || child.signalCode !== null) {
        proc.status = "stopped";
        return;
      }
      // 先 SIGTERM，等待最多 5s，若未退出则 SIGKILL 强制终止。
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      await new Promise<void>((resolve) => {
        const sigkillTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
          resolve();
        }, 5000);
        sigkillTimer.unref();
        child.once("exit", () => {
          clearTimeout(sigkillTimer);
          resolve();
        });
      });
      proc.status = "stopped";
    }
  }

  async killAll(): Promise<void> {
    for (const [id] of this.processes) {
      await this.kill(id);
    }
  }

  list(): ProcessInfo[] {
    return Array.from(this.processes.values());
  }

  getStatus(processId: string): ProcessInfo | undefined {
    return this.processes.get(processId);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}