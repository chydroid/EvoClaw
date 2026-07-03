/**
 * 沙箱后端统一抽象 —— ISandboxBackend 接口 + LocalSandboxBackend 实现。
 *
 * 背景：
 *   原有 3 个沙箱实现（DockerSandbox / SSHSandbox / SkillSandbox）各自为政，
 *   SandboxManager 只覆盖 docker + ssh，process 后端一直未实现（execute 直接返回
 *   "Process backend not yet supported"）。本模块补齐 process 后端，并定义统一
 *   接口，让所有后端都识别 SandboxPolicy（原来仅 SkillSandbox 消费）。
 *
 * 设计原则：
 *   1. 统一接口 —— ISandboxBackend 抽象 isAvailable / execute / executeScript / dispose
 *   2. 策略贯通 —— 所有 execute 调用接收可选 SandboxPolicy，后端尽力执行
 *   3. 诚实标注 —— LocalSandboxBackend 是"软沙箱"：能强制 timeout/memory/path 校验，
 *      但无法在无 OS 隔离的前提下真正阻断网络/子进程。硬隔离请用 docker/ssh 后端。
 *   4. 不破坏现有 API —— SandboxManager 增量支持 process 后端，不改 docker/ssh 行为
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import type { SandboxResult } from "./docker-sandbox";
import type { SandboxBackendType } from "./sandbox-manager";
import type { SandboxPolicy } from "@evoclaw/core";

// ── 接口定义 ──────────────────────────────────────────────

/** 沙箱执行选项 —— 所有后端通用 */
export interface SandboxExecuteOptions {
  /** 执行超时（ms） */
  timeoutMs?: number;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 工作目录 */
  workdir?: string;
  /** 最大输出字节数 */
  maxOutputBytes?: number;
  /** 安全策略：网络/文件系统/子进程开关 + 资源限额 */
  policy?: SandboxPolicy;
}

/** 脚本执行选项 */
export interface SandboxScriptOptions extends SandboxExecuteOptions {
  /** 脚本解释器 */
  interpreter?: "node" | "python" | "python3";
}

/**
 * 沙箱后端统一接口。
 *
 * 所有后端（local / docker / ssh）实现此接口，SandboxManager 通过此接口
 * 多态调用，不再为每个后端写 if-else 分支。
 */
export interface ISandboxBackend {
  /** 后端类型标识 */
  readonly type: SandboxBackendType;
  /** 检查后端是否可用（如 docker 是否安装、ssh 是否连通） */
  isAvailable(): Promise<boolean>;
  /** 执行命令（字符串数组形式，避免 shell 注入） */
  execute(command: string[], options?: SandboxExecuteOptions): Promise<SandboxResult>;
  /** 执行脚本（带解释器） */
  executeScript(script: string, options?: SandboxScriptOptions): Promise<SandboxResult>;
  /** 释放后端资源 */
  dispose(): Promise<void>;
}

// ── LocalSandboxBackend ───────────────────────────────────

/**
 * 本地子进程沙箱后端 —— "软沙箱"。
 *
 * 能强制执行的策略：
 *  - maxExecutionTime → spawn timeout + kill
 *  - maxMemoryMB → Node.js 通过 --max-old-space-size（Python 暂无进程级内存限额的跨平台方式）
 *  - allowedPaths → 命令参数路径校验，越界即拒绝
 *  - maxOutputBytes → stdout/stderr 截断
 *
 * 无法在无 OS 隔离前提下强制的策略（诚实标注）：
 *  - allowNetwork → 无法在进程级阻断（需 OS 网络命名空间/防火墙）
 *  - allowSubprocess → 无法阻止子进程再 spawn
 *  - allowFileSystem → 仅能校验显式路径参数，无法阻止通过 API 访问
 *  - allowedHosts → 同 allowNetwork
 *
 * 如需硬隔离，请使用 docker 或 ssh 后端。
 */
export class LocalSandboxBackend implements ISandboxBackend {
  readonly type: SandboxBackendType = "process";

  async isAvailable(): Promise<boolean> {
    // 本地后端始终可用（只要进程能 spawn）
    return true;
  }

  async execute(
    command: string[],
    options?: SandboxExecuteOptions,
  ): Promise<SandboxResult> {
    if (!command || command.length === 0) {
      return this.errorResult("Command is empty");
    }

    // 策略校验：路径越界检查
    const policyError = this.validatePolicy(command, options?.policy, options?.workdir);
    if (policyError) {
      return this.errorResult(policyError);
    }

    const timeoutMs = options?.timeoutMs ?? options?.policy?.maxExecutionTime ?? 30000;
    const maxOutputBytes = options?.maxOutputBytes ?? 1024 * 1024;
    const cwd = options?.workdir ?? process.cwd();

    if (!fs.existsSync(cwd)) {
      return this.errorResult(`Working directory does not exist: ${cwd}`);
    }

    // 内存限额：仅对 node 可执行文件通过 NODE_OPTIONS 注入 --max-old-space-size
    const env = { ...options?.env };
    if (options?.policy?.maxMemoryMB && command[0] === "node") {
      const existing = env.NODE_OPTIONS ?? "";
      env.NODE_OPTIONS = `${existing} --max-old-space-size=${options.policy.maxMemoryMB}`.trim();
    }

    return this.runSpawn(command, { cwd, timeoutMs, env, maxOutputBytes });
  }

  async executeScript(
    script: string,
    options?: SandboxScriptOptions,
  ): Promise<SandboxResult> {
    const interpreter = options?.interpreter ?? "node";
    // 将脚本写入临时文件，通过解释器执行
    const tmpFile = path.join(
      options?.workdir ?? process.cwd(),
      `.sandbox-script-${Date.now()}.${interpreter === "node" ? "mjs" : "py"}`,
    );
    try {
      fs.writeFileSync(tmpFile, script, { encoding: "utf-8" });
      const cmd = interpreter === "node" ? ["node", tmpFile] : [interpreter, tmpFile];
      return await this.execute(cmd, options);
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // 忽略清理失败
      }
    }
  }

  async dispose(): Promise<void> {
    // 本地后端无持久资源
  }

  // ── 内部方法 ────────────────────────────────────────────

  /**
   * 校验 SandboxPolicy：检查命令中的显式路径参数是否在 allowedPaths 内。
   * 返回错误消息字符串（校验失败）或 undefined（校验通过）。
   */
  private validatePolicy(
    command: string[],
    policy: SandboxPolicy | undefined,
    workdir: string | undefined,
  ): string | undefined {
    if (!policy) return undefined;

    // allowFileSystem=false 时，禁止任何显式路径参数（基础启发式）
    if (!policy.allowFileSystem) {
      const pathLike = command.filter((arg) => /^[./\\]|[A-Za-z]:[\\/]/.test(arg));
      if (pathLike.length > 0) {
        return `SandboxPolicy denies file system access, but command references paths: ${pathLike.join(", ")}`;
      }
    }

    // allowedPaths 非空时，显式路径参数必须在允许列表内
    if (policy.allowedPaths && policy.allowedPaths.length > 0) {
      const allowed = policy.allowedPaths.map((p) => path.resolve(p));
      for (const arg of command) {
        if (!/^[./\\]|[A-Za-z]:[\\/]/.test(arg)) continue; // 非路径参数跳过
        const resolved = path.resolve(workdir ?? process.cwd(), arg);
        const withinAllowed = allowed.some((ap) => {
          const rel = path.relative(ap, resolved);
          return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
        });
        if (!withinAllowed) {
          return `SandboxPolicy denies access to path outside allowedPaths: ${resolved}`;
        }
      }
    }

    return undefined;
  }

  private runSpawn(
    command: string[],
    opts: {
      cwd: string;
      timeoutMs: number;
      env?: Record<string, string>;
      maxOutputBytes: number;
    },
  ): Promise<SandboxResult> {
    return new Promise((resolve) => {
      const start = Date.now();
      const [executable, ...spawnArgs] = command;

      let child: ReturnType<typeof spawn>;
      try {
        const childEnv = { ...process.env, ...opts.env };
        child = spawn(executable, spawnArgs, {
          cwd: opts.cwd,
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (err) {
        resolve(this.errorResult(`Failed to spawn process: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let truncated = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length + chunk.length > opts.maxOutputBytes) {
          stdout += chunk.subarray(0, opts.maxOutputBytes - stdout.length);
          truncated = true;
          child.kill("SIGKILL");
          return;
        }
        stdout += chunk.toString("utf-8");
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length + chunk.length > opts.maxOutputBytes) {
          stderr += chunk.subarray(0, opts.maxOutputBytes - stderr.length);
          truncated = true;
          child.kill("SIGKILL");
          return;
        }
        stderr += chunk.toString("utf-8");
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
      timer.unref?.();

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          exitCode: -1,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          timedOut,
          error: `Spawn error: ${err.message}`,
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        const errMsg = truncated ? "Output truncated at maxOutputBytes limit" : undefined;
        resolve({
          success: !timedOut && code === 0,
          exitCode: code ?? -1,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          timedOut,
          error: errMsg,
        });
      });
    });
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
