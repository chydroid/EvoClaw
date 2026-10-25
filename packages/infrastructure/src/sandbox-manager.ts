import { DockerSandbox, type SandboxConfig, type SandboxResult } from "./docker-sandbox";
import { SSHSandbox, type SSHSandboxConfig, type SSHSandboxResult } from "./ssh-sandbox";
import { LocalSandboxBackend, type SandboxExecuteOptions } from "./sandbox-backend";
import { SingularitySandbox, ModalSandboxBackend, DaytonaSandboxBackend, VercelSandboxBackend, type CloudSandboxConfig } from "./cloud-sandboxes";
import type { SandboxPolicy } from "@evoclaw/core";
import { randomUUID } from "crypto";

export type SandboxBackendType = "docker" | "ssh" | "process" | "singularity" | "modal" | "daytona" | "vercel_sandbox";

export interface UnifiedSandboxConfig {
  backend: SandboxBackendType;
  docker?: SandboxConfig;
  ssh?: SSHSandboxConfig;
  /** 云端/容器后端配置（singularity/modal/daytona/vercel_sandbox） */
  cloud?: CloudSandboxConfig;
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
  private cloudSandboxes = new Map<string, { backend: SingularitySandbox | ModalSandboxBackend | DaytonaSandboxBackend | VercelSandboxBackend; type: SandboxBackendType }>();
  private sessions = new Map<string, SandboxSession>();
  private sessionCounter = 0;

  constructor() {
    this.dockerSandbox = new DockerSandbox();
    this.localBackend = new LocalSandboxBackend();
  }

  async createSession(config: UnifiedSandboxConfig): Promise<SandboxSession> {
    const id = `sandbox-${randomUUID()}`;
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
      } else if (config.backend === "singularity") {
        const sb = new SingularitySandbox(config.cloud);
        const available = await sb.isAvailable();
        if (!available) {
          session.status = "error";
          throw new Error("Singularity/Apptainer is not available");
        }
        this.cloudSandboxes.set(id, { backend: sb, type: "singularity" });
      } else if (config.backend === "modal") {
        const sb = new ModalSandboxBackend(config.cloud);
        const available = await sb.isAvailable();
        if (!available) {
          session.status = "error";
          throw new Error("Modal API key not configured (MODAL_API_KEY)");
        }
        this.cloudSandboxes.set(id, { backend: sb, type: "modal" });
      } else if (config.backend === "daytona") {
        const sb = new DaytonaSandboxBackend(config.cloud);
        const available = await sb.isAvailable();
        if (!available) {
          session.status = "error";
          throw new Error("Daytona API key not configured (DAYTONA_API_KEY)");
        }
        this.cloudSandboxes.set(id, { backend: sb, type: "daytona" });
      } else if (config.backend === "vercel_sandbox") {
        const sb = new VercelSandboxBackend(config.cloud);
        const available = await sb.isAvailable();
        if (!available) {
          session.status = "error";
          throw new Error("Vercel API key not configured (VERCEL_API_KEY)");
        }
        this.cloudSandboxes.set(id, { backend: sb, type: "vercel_sandbox" });
      }

      session.status = "ready";
    } catch (err) {
      session.status = "error";
      // 创建失败：从 Map 移除，避免遗留不可用的 session
      this.sessions.delete(id);
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

        // 安全：对每个参数做 shell quoting 后再拼接，避免命令注入。
        // 单引号内的内容不会被 shell 解释，参数中的单引号通过 '\''
        // 转义关闭再开启单引号段来实现字面量传递。
        const shellCommand = command
          .map((arg) => `'${arg.replace(/'/g, "'\\''")}'`)
          .join(" ");
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
        // 云端后端（singularity/modal/daytona/vercel_sandbox）
        const cloudEntry = this.cloudSandboxes.get(sessionId);
        if (!cloudEntry) {
          return this.errorResult(`Cloud backend not found for session: ${session.backend}`);
        }
        result = await cloudEntry.backend.execute(command, {
          timeoutMs: options?.timeoutMs,
          env: options?.env,
          workdir: options?.workdir,
          maxOutputBytes: options?.maxOutputBytes,
        });
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
    options?: { interpreter?: string; timeoutMs?: number; workdir?: string }
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
        workdir: options?.workdir,
        interpreter: interpreter === "python" || interpreter === "python3" ? interpreter : "node",
        policy: session.policy,
      });
    } else {
      // 云端后端
      const cloudEntry = this.cloudSandboxes.get(sessionId);
      if (!cloudEntry) {
        return this.errorResult(`Cloud backend not found for session: ${session.backend}`);
      }
      return cloudEntry.backend.executeScript(script, {
        timeoutMs: options?.timeoutMs,
        workdir: options?.workdir,
        interpreter: interpreter === "python" || interpreter === "python3" ? interpreter : "node",
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

    const cloudEntry = this.cloudSandboxes.get(sessionId);
    if (cloudEntry) {
      await cloudEntry.backend.dispose();
      this.cloudSandboxes.delete(sessionId);
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
    const [dockerAvailable, processAvailable] = await Promise.all([
      this.dockerSandbox.isAvailable(),
      this.localBackend.isAvailable(),
    ]);
    // 2026-10-15 P3-5：ssh 需配置才可用——原恒 true 会让调用方误判后端存在
    const sshAvailable = process.env.SANDBOX_SSH_HOST ? true : false;
    // 云端后端可用性检查
    const singularityAvailable = !!(process.env.SANDBOX_SINGULARITY_IMAGE || true); // CLI 驱动，运行时检查
    const modalAvailable = !!process.env.MODAL_API_KEY;
    const daytonaAvailable = !!process.env.DAYTONA_API_KEY;
    const vercelAvailable = !!process.env.VERCEL_API_KEY;
    return [
      { type: "docker", available: dockerAvailable },
      { type: "ssh", available: sshAvailable },
      { type: "process", available: processAvailable },
      { type: "singularity", available: singularityAvailable },
      { type: "modal", available: modalAvailable },
      { type: "daytona", available: daytonaAvailable },
      { type: "vercel_sandbox", available: vercelAvailable },
    ];
  }

  async dispose(): Promise<void> {
    for (const [, ssh] of this.sshSandboxes) {
      ssh.dispose();
    }
    this.sshSandboxes.clear();
    for (const [, entry] of this.cloudSandboxes) {
      await entry.backend.dispose();
    }
    this.cloudSandboxes.clear();
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
