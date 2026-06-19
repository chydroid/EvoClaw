import { spawn } from "child_process";
import * as crypto from "crypto";

export interface SSHSandboxConfig {
  host: string;
  port?: number;
  user: string;
  privateKey?: string;
  password?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  workdir?: string;
  env?: Record<string, string>;
}

export interface SSHSandboxResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

export class SSHSandbox {
  private host: string;
  private port: number;
  private user: string;
  private privateKey?: string;
  private password?: string;
  private available: boolean | null = null;

  constructor(config: SSHSandboxConfig) {
    this.host = config.host;
    this.port = config.port ?? 22;
    this.user = config.user;
    this.privateKey = config.privateKey;
    this.password = config.password;
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;

    try {
      const result = await this.execute("echo ok", { timeoutMs: 5000 });
      this.available = result.success && result.stdout.trim() === "ok";
    } catch {
      this.available = false;
      process.stderr.write(
        `[SSHSandbox] SSH connection to ${this.user}@${this.host}:${this.port} is not available\n`
      );
    }

    return this.available;
  }

  async execute(
    command: string,
    options?: { timeoutMs?: number; maxOutputBytes?: number; env?: Record<string, string>; workdir?: string }
  ): Promise<SSHSandboxResult> {
    const timeoutMs = options?.timeoutMs ?? 30000;
    const maxOutputBytes = options?.maxOutputBytes ?? 1024 * 1024;
    const startTime = Date.now();

    const args: string[] = [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=10",
      "-o", `ServerAliveInterval=${Math.floor(timeoutMs / 3000) || 10}`,
      "-o", "ServerAliveCountMax=3",
      "-p", String(this.port),
    ];

    let keyFile: string | undefined;
    if (this.privateKey) {
      keyFile = this.writeKeyFile(this.privateKey);
      args.push("-i", keyFile);
    }

    args.push(`${this.user}@${this.host}`);

    if (options?.workdir) {
      // Sanitize workdir to prevent command injection
      const safeWorkdir = options.workdir.replace(/[;&|`$(){}!#]/g, "");
      command = `cd '${safeWorkdir.replace(/'/g, "'\\''")}' 2>/dev/null; ${command}`;
    }

    if (options?.env && Object.keys(options.env).length > 0) {
      const envExports = Object.entries(options.env)
        .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
        .join(" && ");
      command = `${envExports} && ${command}`;
    }

    args.push(command);

    try {
      const { stdout, stderr, exitCode, timedOut } = await this.runSSH(
        args,
        timeoutMs,
        maxOutputBytes
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
    } finally {
      // Clean up private key file to prevent credential leakage
      if (keyFile) {
        try { require("fs").unlinkSync(keyFile); } catch { /* best effort */ }
      }
    }
  }

  async runScript(
    script: string,
    options?: { timeoutMs?: number; interpreter?: string }
  ): Promise<SSHSandboxResult> {
    const interpreter = options?.interpreter ?? "node";
    const command = `${interpreter} -e '${script.replace(/'/g, "'\\''")}'`;
    return this.execute(command, { timeoutMs: options?.timeoutMs });
  }

  dispose(): void {
    this.available = null;
  }

  private writeKeyFile(privateKey: string): string {
    const os = require("os") as typeof import("os");
    const fs = require("fs") as typeof import("fs");
    const tmpDir = os.tmpdir();
    const keyFile = require("path").join(tmpDir, `evoclaw-ssh-key-${crypto.randomBytes(4).toString("hex")}`);
    fs.writeFileSync(keyFile, privateKey, { mode: 0o600 });
    return keyFile;
  }

  private runSSH(
    args: string[],
    timeoutMs: number,
    maxOutputBytes: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn("ssh", args, {
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
          child.kill("SIGKILL");
        }
      }, timeoutMs);

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
        if (stdout.length > maxOutputBytes) {
          stdout = stdout.slice(0, maxOutputBytes) + "\n[output truncated]";
          child.kill("SIGTERM");
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
        if (stderr.length > maxOutputBytes) {
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
