/**
 * verify/runner — 项目验证运行器。
 *
 * 对标 hermes-agent agent/verify/runner.py（ported from grok-cli）：
 *   按配方顺序执行 bootstrap → build → test → start in background →
 *   readiness loop → teardown，验证项目是否真的能跑起来。
 *
 * 安全说明：命令来自项目自身的配方，以 shell=True 执行——
 * 开发者工具在自己的 checkout 里跑项目自己的 build 命令，与 terminal 工具同信任级别。
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import * as path from "node:path";
import type { Recipe } from "./recipes";

const DEFAULT_PHASE_TIMEOUT_MS = 600_000; // 10 min
const DEFAULT_READY_TIMEOUT_MS = 60_000; // 1 min
const TAIL_CHARS = 2000;
const PHASE_ORDER = ["bootstrap", "build", "test"] as const;

// ── 类型 ──────────────────────────────────────────────

export interface PhaseResult {
  phase: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
  timedOut: boolean;
}

/** 判断阶段结果是否成功 */
export function phaseOk(r: PhaseResult): boolean {
  return r.exitCode === 0 && !r.timedOut;
}

/** 创建 PhaseResult（自动不含 ok 字段，用 phaseOk() 判断） */
function makePhaseResult(phase: string, command: string, exitCode: number | null, durationMs: number, outputTail: string, timedOut: boolean): PhaseResult {
  return { phase, command, exitCode, durationMs, outputTail, timedOut };
}

export interface ReadinessResult {
  url: string;
  ready: boolean;
  statusCode: number | null;
  durationMs: number;
  error: string | null;
  outputTail: string;
}

export interface VerifyResult {
  recipeName: string;
  phases: PhaseResult[];
  readiness: ReadinessResult | null;
}

// ── 辅助函数 ─────────────────────────────────────────

function tail(text: string, limit: number = TAIL_CHARS): string {
  return text.length > limit ? text.slice(-limit) : text;
}

/**
 * 执行单个阶段命令（同步等待完成）。
 */
function runPhaseCommand(
  phase: string,
  command: string,
  root: string,
  timeoutMs: number,
  onOutput?: (output: string) => void,
): Promise<PhaseResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(command, {
      cwd: root,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(makePhaseResult(phase, command, -1, Date.now() - start, tail(`${stdout}\n${stderr}\n${err.message}`), timedOut));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const output = stdout + (stderr ? `\n${stderr}` : "");
      if (onOutput && output) onOutput(output);
      resolve(makePhaseResult(phase, command, code, Date.now() - start, tail(output), timedOut));
    });
  });
}

/**
 * 轮询 readiness URL，直到超时或服务器响应。
 */
function pollReadiness(url: string, timeoutMs: number, intervalMs: number = 1000): Promise<{ ready: boolean; status: number | null; error: string | null }> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let lastError: string | null = null;

    const attempt = () => {
      if (Date.now() > deadline) {
        resolve({ ready: false, status: null, error: lastError });
        return;
      }
      const req = http.get(url, { timeout: 5000 }, (res) => {
        res.resume(); // 消耗响应体
        // HTTP 错误码也算服务器已启动
        resolve({ ready: true, status: res.statusCode ?? null, error: null });
      });
      req.on("error", (err) => {
        lastError = err.message;
        setTimeout(attempt, intervalMs);
      });
      req.on("timeout", () => {
        req.destroy();
        lastError = "request timeout";
        setTimeout(attempt, intervalMs);
      });
    };
    attempt();
  });
}

/**
 * 终止进程组（SIGTERM → 10s → SIGKILL）。
 */
function terminateProcessGroup(proc: ChildProcess): void {
  if (proc.killed || proc.exitCode !== null) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    return;
  }
  const killTimer = setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch { /* ignore */ }
  }, 10_000);
  killTimer.unref?.();
  proc.once("close", () => clearTimeout(killTimer));
}

/**
 * 执行 start 阶段：后台启动服务器，轮询 readiness，然后清理。
 */
async function runStartPhase(
  recipe: Recipe,
  root: string,
  readyTimeoutMs: number,
  portOverride?: number,
): Promise<ReadinessResult> {
  const port = portOverride ?? recipe.port ?? 8000;
  const url = `http://127.0.0.1:${port}${recipe.readinessPath}`;
  const start = Date.now();
  const proc = spawn(recipe.start!, { cwd: root, shell: true, stdio: ["ignore", "pipe", "pipe"] });

  let output = "";
  proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  proc.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  try {
    const { ready, status, error } = await pollReadiness(url, readyTimeoutMs);
    return { url, ready, statusCode: status, durationMs: Date.now() - start, error, outputTail: tail(output) };
  } finally {
    terminateProcessGroup(proc);
  }
}

// ── compose 安全检查 ──────────────────────────────────

/**
 * 检查 docker compose 项目是否已有运行中的容器。
 * 如果有，拒绝执行 build/up——会替换现有容器，丢失容器本地状态。
 */
async function composeLiveStateReason(root: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("docker compose ps --status running --format {{.Name}}", {
      cwd: root, shell: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve("docker compose ps timed out after 15s; live containers cannot be ruled out"); }, 15_000);
    timer.unref?.();
    proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("error", () => { resolve(null); }); // docker 不存在 → 不阻止
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = (stderr || stdout).trim().split("\n").filter(Boolean).pop() ?? "no output";
        resolve(`docker compose ps failed (exit ${code}): ${detail}`);
        return;
      }
      const names = stdout.split("\n").filter((l) => l.trim());
      resolve(names.length > 0 ? `this compose project already has running container(s): ${names.join(", ")}` : null);
    });
  });
}

// ── 主入口 ────────────────────────────────────────────

export interface RunVerifyOptions {
  /** 要执行的阶段；默认全部（bootstrap, build, test, start） */
  phases?: string[];
  /** 每阶段超时（ms），默认 600s */
  phaseTimeoutMs?: number;
  /** readiness 超时（ms），默认 60s */
  readyTimeoutMs?: number;
  /** 跳过 start 阶段 */
  skipStart?: boolean;
  /** 端口覆盖 */
  portOverride?: number;
  /** 失败即停 */
  stopOnFailure?: boolean;
  /** 输出回调 */
  onOutput?: (output: string) => void;
}

/**
 * 运行验证：按配方顺序执行各阶段，最后 boot 服务器并检查 readiness。
 */
export async function runVerify(
  root: string,
  recipe: Recipe,
  options: RunVerifyOptions = {},
): Promise<VerifyResult> {
  const selected = options.phases ?? [...PHASE_ORDER, "start"];
  const phaseTimeoutMs = options.phaseTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const stopOnFailure = options.stopOnFailure ?? true;

  const result: VerifyResult = { recipeName: recipe.name, phases: [], readiness: null };

  // compose 安全检查：有运行中容器时拒绝
  const mutating = selected.includes("build") || (selected.includes("start") && !options.skipStart);
  if (recipe.kind === "compose" && mutating) {
    const reason = await composeLiveStateReason(root);
    if (reason) {
      result.phases.push(makePhaseResult(
        "build",
        recipe.build[0] ?? "docker compose build",
        1,
        0,
        `Refusing to run: ${reason}. \`docker compose build\` + \`up\` would replace live containers on an image-hash change, destroying any container-local state they carry. If you intend to rebuild this live deployment, run \`docker compose build\`/\`up\` yourself.`,
        false,
      ));
      return result;
    }
  }

  // 执行 bootstrap → build → test
  for (const phase of PHASE_ORDER) {
    if (!selected.includes(phase)) continue;
    const commands = recipe[phase as "bootstrap" | "build" | "test"];
    for (const command of commands) {
      const phaseResult = await runPhaseCommand(phase, command, root, phaseTimeoutMs, options.onOutput);
      result.phases.push(phaseResult);
      if (!phaseOk(phaseResult) && stopOnFailure) return result;
    }
  }

  // 执行 start 阶段
  if (!options.skipStart && selected.includes("start") && recipe.start && result.phases.every(phaseOk)) {
    result.readiness = await runStartPhase(recipe, root, readyTimeoutMs, options.portOverride);
  }

  return result;
}

// ── verifyOk ───────────────────────────────────────────

export function verifyOk(r: VerifyResult): boolean {
  return r.phases.every(phaseOk) && (r.readiness === null || r.readiness.ready);
}
