import { DockerSandbox, type SandboxConfig, type SandboxResult } from "./docker-sandbox";
import { SSHSandbox, type SSHSandboxConfig, type SSHSandboxResult } from "./ssh-sandbox";

export type SandboxBackendType = "docker" | "ssh" | "process";

export interface UnifiedSandboxConfig {
  backend: SandboxBackendType;
  docker?: SandboxConfig;
  ssh?: SSHSandboxConfig;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SandboxSession {
  id: string;
  backend: SandboxBackendType;
  status: "creating" | "ready" | "executing" | "error" | "destroyed";
  createdAt: Date;
  lastActivityAt: Date;
  executeCount: number;
}

export class SandboxManager {
  private dockerSandbox: DockerSandbox;
  private sshSandboxes = new Map<string, SSHSandbox>();
  private sessions = new Map<string, SandboxSession>();
  private sessionCounter = 0;

  constructor() {
    this.dockerSandbox = new DockerSandbox();
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
    options?: { timeoutMs?: number; env?: Record<string, string>; workdir?: string }
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
      } else {
        return this.errorResult("Process backend not yet supported in unified manager");
      }

      session.executeCount++;
      session.status = "ready";
      session.lastActivityAt = new Date();

      return result;
    } catch (err) {
      session.status = "error";
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
    for (const [id, ssh] of this.sshSandboxes) {
      ssh.dispose();
    }
    this.sshSandboxes.clear();
    this.sessions.clear();
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
