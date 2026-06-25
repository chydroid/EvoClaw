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
      this.eventBus.publish(
        "process.exited",
        { id, name, exitCode: code },
        "process-manager"
      );
    });

    childProcess.on("error", (err) => {
      processInfo.status = "crashed";
      this.eventBus.publish(
        "process.error",
        { id, name, error: err.message },
        "process-manager"
      );
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

  async kill(processId: string): Promise<void> {
    const proc = this.processes.get(processId);
    if (proc && proc.childProcess) {
      proc.childProcess.kill();
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