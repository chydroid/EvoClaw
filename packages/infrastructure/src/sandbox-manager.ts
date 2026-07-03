import { DockerSandbox, type SandboxConfig, type SandboxResult } from "./docker-sandbox";
import { SSHSandbox, type SSHSandboxConfig, type SSHSandboxResult } from "./ssh-sandbox";
import { LocalSandboxBackend, type SandboxExecuteOptions } from "./sandbox-backend";
import type { SandboxPolicy } from "@evoclaw/core";

export type SandboxBackendType = "docker" | "ssh" | "process";

export interface UnifiedSandboxConfig {
  backend: SandboxBackendType;
  docker?: SandboxConfig;
  ssh?: SSHSandboxConfig;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** 安全策略：网络/文件系统/子进程开关 + 资源限额（所有后端尽力执行） */
  policy?: SandboxPolicy;
}

export interface SandboxSession {
  id: string;
  backend: SandboxBackendType;
  status: "creating" | "ready" | "executing" | "error" | "destroyed";
  createdAt: Date;
  lastActivityAt: Date;
  executeCount: number;
  lastError?: string;
  /** 会话绑定的安全策略（createSession 时传入，后续 execute 自动应用） */
  policy?: SandboxPolicy;
}

export class SandboxManager {
  private dockerSandbox: DockerSandbox;
  private localBackend: LocalSandboxBackend;
  private sshSandboxes = new Map<string, SSHSandbox>();
  private sessions = new Map<string, SandboxSession>();
  private sessionCounter = 0;

  constructor() {
    this.dockerSandbox = new DockerSandbox();
    this.localBackend = new LocalSandboxBackend();
  }

  async createSession(config: UnifiedSandboxConfig): Promise<SandboxSession> {
    const id = `sandbox-${Date.now()}-${++this.sessionCounter}`;
    const session: SandboxSession = {
      id,
      backend: config.backend,
      status: "creating",
      createdAt: new Date(),
      lastActivityAt: new Date(),
      executeCount: 0,
      policy: config.policy,
    };

    this.sessions.set(id, session);

    try {
      if (config.backend === "docker") {
        const available = await this.dockerSandbox.isAvailable();
        if (!available) {
          session.status = "error";
          throw new Error("Docker is not available");
        }
      } else if (config.backend === "ssh") {
        if (!config.ssh) {
          session.status = "error";
          throw new Error("SSH config is required for ssh backend");
        }
        const ssh = new SSHSandbox(config.ssh);
        const available = await ssh.isAvailable();
        if (!available) {
          session.status = "error";
          ssh.dispose();
          throw new Error(`SSH connection to ${config.ssh.user}@${config.ssh.host} is not available`);
        }
        this.sshSandboxes.set(id, ssh);
      } else if (config.backend === "process") {
        const available = await this.localBackend.isAvailable();
        if (!available) {
          session.status = "error";
          throw new Error("Local process backend is not available");
        }
      }

      session.status = "ready";
    } catch (err) {
      session.status = "error";
      throw err;
    }

    return session;
  }

  async execute(
    sessionId: string,
    command: string[],
    options?: { timeoutMs?: number; env?: Record<string, string>; workdir?: string; maxOutputBytes?: number }
  ): Promise<SandboxResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return this.errorResult("Session not found");
    }

    if (session.status !== "ready" && session.status !== "executing") {
      return this.errorResult(`Session is in ${session.status} state`);
    }

    session.status = "executing";
    session.lastActivityAt = new Date();

    try {
      let result: SandboxResult;

      if (session.backend === "docker") {
        result = await this.dockerSandbox.run(command, {
          timeoutMs: options?.timeoutMs,
          env: options?.env,
          workdir: options?.workdir,
        });
      } else if (session.backend === "ssh") {
        const ssh = this.sshSandboxes.get(sessionId);
        if (!ssh) {
          return this.errorResult("SSH sandbox not found for session");
        }

        const shellCommand = command.join(" ");
        const sshResult = await ssh.execute(shellCommand, {
          timeoutMs: options?.timeoutMs,
          env: options?.env,
          workdir: options?.workdir,
        });

        result = {
          success: sshResult.success,
          exitCode: sshResult.exitCode,
          stdout: sshResult.stdout,
          stderr: sshResult.stderr,
          durationMs: sshResult.durationMs,
          timedOut: sshResult.timedOut,
          error: sshResult.error,
        };
      } else if (session.backend === "process") {
        const execOpts: SandboxExecuteOptions = {
          timeoutMs: options?.timeoutMs,
          env: options?.env,
          workdir: options?.workdir,
          maxOutputBytes: options?.maxOutputBytes,
          policy: session.policy,
        };
        result = await this.localBackend.execute(command, execOpts);
      } else {
        return this.errorResult(`Unsupported backend: ${session.backend}`);
      }

      session.executeCount++;
      session.status = "ready";
      session.lastActivityAt = new Date();

      return result;
    } catch (err) {
      session.status = "ready";
      session.lastError = err instanceof Error ? err.message : String(err);
      return this.errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  async executeScript(
    sessionId: string,
    script: string,
    options?: { interpreter?: string; timeoutMs?: number }
  ): Promise<SandboxResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return this.errorResult("Session not found");
    }

    const interpreter = options?.interpreter ?? "node";

    if (session.backend === "docker") {
      if (interpreter === "python") {
        return this.dockerSandbox.runPython(script, { timeoutMs: options?.timeoutMs });
      }
      return this.dockerSandbox.runScript(script, { timeoutMs: options?.timeoutMs });
    } else if (session.backend === "ssh") {
      const ssh = this.sshSandboxes.get(sessionId);
      if (!ssh) {
        return this.errorResult("SSH sandbox not found for session");
      }

      const sshResult = await ssh.runScript(script, {
        interpreter,
        timeoutMs: options?.timeoutMs,
      });

      return {
        success: sshResult.success,
        exitCode: sshResult.exitCode,
        stdout: sshResult.stdout,
        stderr: sshResult.stderr,
        durationMs: sshResult.durationMs,
        timedOut: sshResult.timedOut,
        error: sshResult.error,
      };
    } else if (session.backend === "process") {
      return this.localBackend.executeScript(script, {
        timeoutMs: options?.timeoutMs,
        interpreter: interpreter === "python" || interpreter === "python3" ? interpreter : "node",
        policy: session.policy,
      });
    }

    return this.errorResult("Unsupported backend");
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const ssh = this.sshSandboxes.get(sessionId);
    if (ssh) {
      ssh.dispose();
      this.sshSandboxes.delete(sessionId);
    }

    session.status = "destroyed";
    this.sessions.delete(sessionId);
  }

  listSessions(): SandboxSession[] {
    return Array.from(this.sessions.values());
  }

  getSession(sessionId: string): SandboxSession | undefined {
    return this.sessions.get(sessionId);
  }

  async listBackends(): Promise<Array<{ type: SandboxBackendType; available: boolean }>> {
    const dockerAvailable = await this.dockerSandbox.isAvailable();

    return [
      { type: "docker", available: dockerAvailable },
      { type: "ssh", available: true },
      { type: "process", available: true },
    ];
  }

  async dispose(): Promise<void> {
    for (const [, ssh] of this.sshSandboxes) {
      ssh.dispose();
    }
    this.sshSandboxes.clear();
    this.sessions.clear();
    await this.localBackend.dispose();
  }

  private errorResult(error: string): SandboxResult {
    return {
      success: false,
      exitCode: -1,
      stdout: "",
      stderr: "",
      durationMs: 0,
      timedOut: false,
      error,
    };
  }
}
