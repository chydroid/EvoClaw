/**
 * Docker Sandbox — isolated execution environment for running code/tools.
 *
 * Features:
 *  - Container-based sandbox using named Docker images
 *  - File system isolation (tmpfs or volume mounts)
 *  - Resource limits (CPU, memory, network)
 *  - Timeout enforcement
 *  - Output capture (stdout + stderr)
 *  - Security: no --privileged, read-only rootfs, no new privileges
 *
 * Requires Docker daemon. Falls back gracefully when Docker is unavailable.
 */

import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";

export interface SandboxConfig {
  /** Docker image to use (default: "node:24-alpine") */
  image?: string;
  /** Maximum execution time in ms (default: 30000) */
  timeoutMs?: number;
  /** Memory limit (e.g., "256m", default: "256m") */
  memoryLimit?: string;
  /** CPU limit (shares, 0-1024, default: 256) */
  cpuShares?: number;
  /** Max output size in bytes (default: 1MB) */
  maxOutputBytes?: number;
  /** Working directory inside the container (default: "/workspace") */
  workdir?: string;
  /** Enable network access (default: false) */
  networkEnabled?: boolean;
  /** Mount a host directory into the container */
  hostMount?: { hostPath: string; containerPath: string; readOnly?: boolean };
  /** Additional environment variables */
  env?: Record<string, string>;
  /** User to run as inside container (default: "nobody") */
  runAsUser?: string;
}

export interface SandboxResult {
  /** Whether execution completed successfully */
  success: boolean;
  /** Exit code */
  exitCode: number;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Execution time in ms */
  durationMs: number;
  /** Whether the process was killed by timeout */
  timedOut: boolean;
  /** Error message if launch failed */
  error?: string;
  /** Path to output file (if output was written to a file) */
  outputFile?: string;
}

export class DockerSandbox {
  private available: boolean | null = null;

  /**
   * Check if Docker is available on this system.
   */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;

    try {
      await this.dockerCommand(["info"], 5000);
      this.available = true;
    } catch {
      this.available = false;
      process.stderr.write(
        "[DockerSandbox] Docker is not available — sandbox features disabled\n"
      );
    }

    return this.available;
  }

  /**
   * Run a command inside a Docker container sandbox.
   */
  async run(
    command: string[],
    config: SandboxConfig = {}
  ): Promise<SandboxResult> {
    if (!(await this.isAvailable())) {
      return {
        success: false,
        exitCode: -1,
        stdout: "",
        stderr: "",
        durationMs: 0,
        timedOut: false,
        error: "Docker is not available",
      };
    }

    const startTime = Date.now();

    const image = config.image ?? "node:24-alpine";
    const timeoutMs = config.timeoutMs ?? 30000;
    const memoryLimit = config.memoryLimit ?? "256m";
    const cpuShares = config.cpuShares ?? 256;
    const maxOutputBytes = config.maxOutputBytes ?? 1024 * 1024;
    const workdir = config.workdir ?? "/workspace";
    const networkEnabled = config.networkEnabled ?? false;
    const runAsUser = config.runAsUser ?? "nobody";

    // Build unique container name
    const containerName = `evoclaw-sandbox-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    const args: string[] = [
      "run",
      "--rm",
      "--name",
      containerName,
      // Resource limits
      "--memory",
      memoryLimit,
      "--cpu-shares",
      String(cpuShares),
      "--memory-swap",
      memoryLimit, // No swap
      // Security hardening
      "--read-only",
      "--security-opt=no-new-privileges:true",
      "--cap-drop=ALL",
      // Network
      ...(networkEnabled ? [] : ["--network=none"]),
      // User
      "-u",
      runAsUser,
      // Working directory
      "-w",
      workdir,
      // Temp workspace
      "--tmpfs",
      `${workdir}:rw,noexec,nosuid,size=50m`,
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=10m",
    ];

    // Host mount for shared data
    if (config.hostMount) {
      const mode = config.hostMount.readOnly ? "ro" : "rw";
      args.push(
        "-v",
        `${config.hostMount.hostPath}:${config.hostMount.containerPath}:${mode}`
      );
    }

    // Environment variables
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    // Default env
    args.push(
      "-e", "NODE_ENV=production",
      "-e", "HOME=/tmp",
      "-e", "NO_COLOR=1",
    );

    // Add image and command
    args.push(image);
    args.push(...command);

    try {
      const { stdout, stderr, exitCode, timedOut } = await this.dockerCommand(
        args,
        timeoutMs,
        maxOutputBytes,
        containerName
      );

      return {
        success: exitCode === 0 && !timedOut,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        timedOut,
      };
    } catch (err) {
      return {
        success: false,
        exitCode: -1,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - startTime,
        timedOut: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Run a Node.js script in the sandbox.
   */
  async runScript(
    script: string,
    config: SandboxConfig = {}
  ): Promise<SandboxResult> {
    const image = config.image ?? "node:24-alpine";
    return this.run(["node", "-e", script], { ...config, image });
  }

  /**
   * Run a Python script in the sandbox.
   */
  async runPython(
    script: string,
    config: SandboxConfig = {}
  ): Promise<SandboxResult> {
    const image = config.image ?? "python:3.13-alpine";
    return this.run(["python", "-c", script], { ...config, image });
  }

  /**
   * Execute a shell command in the sandbox.
   */
  async runShell(
    command: string,
    config: SandboxConfig = {}
  ): Promise<SandboxResult> {
    const image = config.image ?? "alpine:latest";
    return this.run(
      ["sh", "-c", command],
      {
        ...config,
        image,
        runAsUser: config.runAsUser ?? "root",
        networkEnabled: config.networkEnabled ?? true,
      }
    );
  }

  /**
   * Pull a Docker image in advance (for warm starts).
   */
  async pullImage(image: string): Promise<boolean> {
    if (!(await this.isAvailable())) return false;

    try {
      await this.dockerCommand(["pull", image], 120000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if the sandbox can use GPU acceleration (nvidia-docker).
   */
  async isGPUSupported(): Promise<boolean> {
    if (!(await this.isAvailable())) return false;

    try {
      await this.dockerCommand(
        ["run", "--rm", "--gpus", "all", "nvidia/cuda:12.0-base", "nvidia-smi"],
        15000
      );
      return true;
    } catch {
      return false;
    }
  }

  // ── Private ─────────────────────────────────────────────────────────

  private dockerCommand(
    args: string[],
    timeoutMs: number,
    maxOutputBytes?: number,
    containerName?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let resolved = false;
      let timedOut = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          timedOut = true;
          // Try to kill the container gracefully, then force.
          // Only kill when we know the container name (e.g. `docker run`).
          // For other commands (info/pull/isGPUSupported) args[3] is NOT a container name.
          if (containerName) {
            const killProc = spawn("docker", ["kill", containerName], {
              windowsHide: true,
            });
            killProc.on("close", () => {
              child.kill("SIGKILL");
            });
          } else {
            child.kill("SIGKILL");
          }
          setTimeout(() => {
            if (!resolved) {
              child.kill("SIGKILL");
            }
          }, 3000);
        }
      }, timeoutMs);

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
        if (maxOutputBytes && stdout.length > maxOutputBytes) {
          stdout = stdout.slice(0, maxOutputBytes) + "\n[output truncated]";
          child.kill("SIGTERM");
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
        if (maxOutputBytes && stderr.length > maxOutputBytes) {
          stderr = stderr.slice(0, maxOutputBytes) + "\n[output truncated]";
        }
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: code ?? 1,
            timedOut,
          });
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  }
}