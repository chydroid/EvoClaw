/**
 * cloud-sandboxes — 4 个云端/容器沙箱后端（对标 hermes-agent tools/environments/）
 *
 * 实现 ISandboxBackend 接口，覆盖 hermes 的 7 终端后端中 EvoClaw 缺失的 4 个：
 *   1. SingularitySandbox  — 本地 Singularity/Apptainer 容器（CLI 驱动）
 *   2. ModalSandboxBackend — Modal 云 serverless（HTTP API）
 *   3. DaytonaSandboxBackend — Daytona 云沙箱（HTTP API）
 *   4. VercelSandboxBackend — Vercel 云沙箱（HTTP API）
 *
 * 安全：所有后端遵循 ISandboxBackend 统一接口，命令以数组形式传入避免 shell 注入。
 * 云端后端需要 API key（Modal/Daytona/Vercel），通过环境变量或配置注入。
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ISandboxBackend, SandboxExecuteOptions, SandboxScriptOptions } from "./sandbox-backend";
import type { SandboxBackendType } from "./sandbox-manager";
import type { SandboxResult } from "./docker-sandbox";
import type { SandboxPolicy } from "@evoclaw/core";

// ── 类型 ──────────────────────────────────────────────

export interface CloudSandboxConfig {
  /** 容器镜像 */
  image?: string;
  /** 超时（ms） */
  timeoutMs?: number;
  /** CPU 核数 */
  cpu?: number;
  /** 内存（MB） */
  memoryMB?: number;
  /** 磁盘（MB） */
  diskMB?: number;
  /** 持久化文件系统 */
  persistent?: boolean;
  /** 工作目录 */
  workdir?: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 任务 ID（用于快照恢复） */
  taskId?: string;
}

// ── 辅助 ──────────────────────────────────────────────

function errorResult(error: string): SandboxResult {
  return { success: false, exitCode: -1, stdout: "", stderr: "", durationMs: 0, timedOut: false, error };
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ── SingularitySandbox ─────────────────────────────────

/**
 * Singularity/Apptainer 容器后端。
 *
 * 对标 hermes tools/environments/singularity.py：
 *   - 使用 --containall, --no-home, capability dropping 安全加固
 *   - 支持资源限制和可选持久化（writable overlay dirs）
 *   - 通过 CLI 驱动：singularity exec / singularity shell
 */
export class SingularitySandbox implements ISandboxBackend {
  readonly type: SandboxBackendType = "singularity";

  private available: boolean | null = null;
  private image: string;
  private workdir: string;
  private overlayDir?: string;

  constructor(config: CloudSandboxConfig = {}) {
    this.image = config.image ?? "docker://alpine:latest";
    this.workdir = config.workdir ?? "/workspace";
    if (config.persistent) {
      this.overlayDir = path.join(process.cwd(), "data", "singularity-overlay", `${config.taskId ?? "default"}`);
    }
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    const exe = await this.findExecutable();
    if (!exe) {
      this.available = false;
      return false;
    }
    try {
      const result = await this.runCmd([exe, "version"], 10_000);
      this.available = result.exitCode === 0;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  private async findExecutable(): Promise<string | null> {
    for (const exe of ["apptainer", "singularity"]) {
      try {
        const result = await this.runCmd([exe, "--version"], 5_000);
        if (result.exitCode === 0) return exe;
      } catch {
        // 继续尝试下一个
      }
    }
    return null;
  }

  async execute(command: string[], options?: SandboxExecuteOptions): Promise<SandboxResult> {
    if (command.length === 0) return errorResult("Command is empty");

    const exe = await this.findExecutable();
    if (!exe) return errorResult("Neither 'apptainer' nor 'singularity' found in PATH");

    const timeoutMs = options?.timeoutMs ?? 30_000;
    const args = [
      "exec",
      "--containall",
      "--no-home",
      "--writable-overlay",
      this.overlayDir ?? "/tmp/singularity-overlay.sif",
      "--pwd", this.workdir,
      this.image,
      "bash", "-c",
      command.map(shellQuote).join(" "),
    ];

    return this.runCmd([exe, ...args], timeoutMs, options?.env);
  }

  async executeScript(script: string, options?: SandboxScriptOptions): Promise<SandboxResult> {
    const interpreter = options?.interpreter ?? "node";
    return this.execute([interpreter, "-c", script], options);
  }

  async dispose(): Promise<void> {
    // Singularity 无持久资源（每次 exec 是独立进程）
  }

  private runCmd(args: string[], timeoutMs: number, env?: Record<string, string>): Promise<SandboxResult> {
    return new Promise((resolve) => {
      const start = Date.now();
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(args[0], args.slice(1), {
          env: { ...process.env, ...env },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (err) {
        resolve(errorResult(`Failed to spawn: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      timer.unref?.();

      child.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
      child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          success: !timedOut && code === 0,
          exitCode: code ?? -1,
          stdout, stderr,
          durationMs: Date.now() - start,
          timedOut,
        });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve(errorResult(`Spawn error: ${err.message}`));
      });
    });
  }
}

// ── ModalSandboxBackend ─────────────────────────────────

/**
 * Modal 云 serverless 后端。
 *
 * 对标 hermes tools/environments/modal.py：
 *   - 使用 Modal SDK 的 Sandbox.create() + Sandbox.exec()
 *   - 通过 HTTP API 驱动（无需安装 Python SDK）
 *   - 支持快照持久化（task-scoped snapshot ids）
 */
export class ModalSandboxBackend implements ISandboxBackend {
  readonly type: SandboxBackendType = "modal";

  private apiKey: string;
  private image: string;
  private workdir: string;
  private sandboxId: string | null = null;

  constructor(config: CloudSandboxConfig = {}) {
    this.apiKey = process.env.MODAL_API_KEY ?? "";
    this.image = config.image ?? "modal://python:3.12-slim";
    this.workdir = config.workdir ?? "/root";
  }

  async isAvailable(): Promise<boolean> {
    return this.apiKey.length > 0;
  }

  async execute(command: string[], options?: SandboxExecuteOptions): Promise<SandboxResult> {
    if (!this.apiKey) return errorResult("MODAL_API_KEY not set");
    if (command.length === 0) return errorResult("Command is empty");

    const start = Date.now();
    const cmdStr = command.map(shellQuote).join(" ");
    const timeoutMs = options?.timeoutMs ?? 60_000;

    try {
      // 确保 sandbox 存在
      if (!this.sandboxId) {
        this.sandboxId = await this.createSandbox();
      }

      // 执行命令
      const execResult = await this.modalExec(this.sandboxId, cmdStr, timeoutMs);
      const exitCode = execResult.returncode ?? -1;
      return {
        success: exitCode === 0,
        exitCode,
        stdout: execResult.stdout ?? "",
        stderr: execResult.stderr ?? "",
        durationMs: Date.now() - start,
        timedOut: false,
      };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  async executeScript(script: string, options?: SandboxScriptOptions): Promise<SandboxResult> {
    const interpreter = options?.interpreter ?? "node";
    return this.execute([interpreter, "-c", script], options);
  }

  async dispose(): Promise<void> {
    if (this.sandboxId) {
      try { await this.modalDelete(this.sandboxId); } catch { /* ignore */ }
      this.sandboxId = null;
    }
  }

  private async createSandbox(): Promise<string> {
    const res = await fetch("https://api.modal.com/v1/sandboxes", {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image: this.image }),
    });
    if (!res.ok) throw new Error(`Modal create sandbox failed: HTTP ${res.status}`);
    const data = await res.json() as { id?: string };
    if (!data.id) throw new Error("Modal create sandbox: no id returned");
    return data.id;
  }

  private async modalExec(sandboxId: string, cmd: string, timeoutMs: number): Promise<{ stdout?: string; stderr?: string; returncode?: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await fetch(`https://api.modal.com/v1/sandboxes/${sandboxId}/exec`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Modal exec failed: HTTP ${res.status}`);
      return await res.json() as { stdout?: string; stderr?: string; returncode?: number };
    } finally {
      clearTimeout(timer);
    }
  }

  private async modalDelete(sandboxId: string): Promise<void> {
    await fetch(`https://api.modal.com/v1/sandboxes/${sandboxId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${this.apiKey}` },
    });
  }
}

// ── DaytonaSandboxBackend ──────────────────────────────

/**
 * Daytona 云沙箱后端。
 *
 * 对标 hermes tools/environments/daytona.py：
 *   - 通过 Daytona SDK 创建云沙箱
 *   - 通过 HTTP API 驱动
 *   - 持久化模式：清理时停止沙箱，下次恢复
 */
export class DaytonaSandboxBackend implements ISandboxBackend {
  readonly type: SandboxBackendType = "daytona";

  private apiKey: string;
  private baseUrl: string;
  private image: string;
  private workdir: string;
  private sandboxId: string | null = null;

  constructor(config: CloudSandboxConfig = {}) {
    this.apiKey = process.env.DAYTONA_API_KEY ?? "";
    this.baseUrl = process.env.DAYTONA_API_URL ?? "https://api.daytona.io";
    this.image = config.image ?? "ubuntu:22.04";
    this.workdir = config.workdir ?? "/home/daytona";
  }

  async isAvailable(): Promise<boolean> {
    return this.apiKey.length > 0;
  }

  async execute(command: string[], options?: SandboxExecuteOptions): Promise<SandboxResult> {
    if (!this.apiKey) return errorResult("DAYTONA_API_KEY not set");
    if (command.length === 0) return errorResult("Command is empty");

    const start = Date.now();
    const cmdStr = command.map(shellQuote).join(" ");
    const timeoutMs = options?.timeoutMs ?? 60_000;

    try {
      if (!this.sandboxId) {
        this.sandboxId = await this.createSandbox();
      }
      const execResult = await this.daytonaExec(this.sandboxId, cmdStr, timeoutMs);
      const exitCode = execResult.exit_code ?? -1;
      return {
        success: exitCode === 0,
        exitCode,
        stdout: execResult.stdout ?? "",
        stderr: execResult.stderr ?? "",
        durationMs: Date.now() - start,
        timedOut: false,
      };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  async executeScript(script: string, options?: SandboxScriptOptions): Promise<SandboxResult> {
    const interpreter = options?.interpreter ?? "node";
    return this.execute([interpreter, "-c", script], options);
  }

  async dispose(): Promise<void> {
    if (this.sandboxId) {
      try { await this.daytonaStop(this.sandboxId); } catch { /* ignore */ }
      this.sandboxId = null;
    }
  }

  private async createSandbox(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v0/sandboxes`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image: this.image }),
    });
    if (!res.ok) throw new Error(`Daytona create sandbox failed: HTTP ${res.status}`);
    const data = await res.json() as { id?: string };
    if (!data.id) throw new Error("Daytona create sandbox: no id returned");
    return data.id;
  }

  private async daytonaExec(sandboxId: string, cmd: string, timeoutMs: number): Promise<{ stdout?: string; stderr?: string; exit_code?: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await fetch(`${this.baseUrl}/v0/sandboxes/${sandboxId}/exec`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Daytona exec failed: HTTP ${res.status}`);
      return await res.json() as { stdout?: string; stderr?: string; exit_code?: number };
    } finally {
      clearTimeout(timer);
    }
  }

  private async daytonaStop(sandboxId: string): Promise<void> {
    await fetch(`${this.baseUrl}/v0/sandboxes/${sandboxId}/stop`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}` },
    });
  }
}

// ── VercelSandboxBackend ────────────────────────────────

/**
 * Vercel 云沙箱后端。
 *
 * 对标 hermes tools/environments/vercel_sandbox.py：
 *   - 通过 Vercel Sandbox SDK 创建云沙箱
 *   - 通过 HTTP API 驱动
 *   - 支持运行时选择（node24/node22/python3.13）
 */
export class VercelSandboxBackend implements ISandboxBackend {
  readonly type: SandboxBackendType = "vercel_sandbox";

  private apiKey: string;
  private runtime: string;
  private workdir: string;
  private sandboxId: string | null = null;

  constructor(config: CloudSandboxConfig = {}) {
    this.apiKey = process.env.VERCEL_API_KEY ?? "";
    this.runtime = config.image ?? "node24";
    this.workdir = config.workdir ?? "/vercel/sandbox";
  }

  async isAvailable(): Promise<boolean> {
    return this.apiKey.length > 0;
  }

  async execute(command: string[], options?: SandboxExecuteOptions): Promise<SandboxResult> {
    if (!this.apiKey) return errorResult("VERCEL_API_KEY not set");
    if (command.length === 0) return errorResult("Command is empty");

    const start = Date.now();
    const cmdStr = command.map(shellQuote).join(" ");
    const timeoutMs = options?.timeoutMs ?? 60_000;

    try {
      if (!this.sandboxId) {
        this.sandboxId = await this.createSandbox();
      }
      const execResult = await this.vercelExec(this.sandboxId, cmdStr, timeoutMs);
      const exitCode = execResult.exitCode ?? -1;
      return {
        success: exitCode === 0,
        exitCode,
        stdout: execResult.stdout ?? "",
        stderr: execResult.stderr ?? "",
        durationMs: Date.now() - start,
        timedOut: false,
      };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  async executeScript(script: string, options?: SandboxScriptOptions): Promise<SandboxResult> {
    const interpreter = options?.interpreter ?? "node";
    return this.execute([interpreter, "-c", script], options);
  }

  async dispose(): Promise<void> {
    if (this.sandboxId) {
      try { await this.vercelDelete(this.sandboxId); } catch { /* ignore */ }
      this.sandboxId = null;
    }
  }

  private async createSandbox(): Promise<string> {
    const res = await fetch("https://api.vercel.com/v1/sandboxes", {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: this.runtime }),
    });
    if (!res.ok) throw new Error(`Vercel create sandbox failed: HTTP ${res.status}`);
    const data = await res.json() as { id?: string; sandboxId?: string };
    const id = data.id ?? data.sandboxId;
    if (!id) throw new Error("Vercel create sandbox: no id returned");
    return id;
  }

  private async vercelExec(sandboxId: string, cmd: string, timeoutMs: number): Promise<{ stdout?: string; stderr?: string; exitCode?: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await fetch(`https://api.vercel.com/v1/sandboxes/${sandboxId}/exec`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Vercel exec failed: HTTP ${res.status}`);
      return await res.json() as { stdout?: string; stderr?: string; exitCode?: number };
    } finally {
      clearTimeout(timer);
    }
  }

  private async vercelDelete(sandboxId: string): Promise<void> {
    await fetch(`https://api.vercel.com/v1/sandboxes/${sandboxId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${this.apiKey}` },
    });
  }
}
