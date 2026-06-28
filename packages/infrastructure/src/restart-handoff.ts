/**
 * restart-handoff.ts — Supervisor 交接
 *
 * 对齐 openclaw-main 的 src/infra/restart.ts 中的 triggerOpenClawRestart。
 *
 * 设计意图：
 * - 当 SIGUSR1 路径不可用（无监听器 / Windows）时，回退到 supervisor 交接
 * - 跨平台：Linux systemd / macOS launchctl / Windows schtasks
 * - 在交接前清理陈旧 gateway 进程（防止端口冲突）
 * - 提供 RestartAttempt 结构化结果，便于审计与重试
 *
 * 平台支持矩阵：
 * - Linux: systemctl --user / systemctl (system)
 * - macOS: launchctl kickstart -k / launchctl bootstrap
 * - Windows: schtasks /End → schtasks /Run
 * - 其他：返回 unsupported
 */

import { spawnSync } from "node:child_process";
import {
  cleanStaleGatewayProcessesSync,
} from "./restart-stale-pids";

const SPAWN_TIMEOUT_MS = 2000;
const LAUNCHCTL_ALREADY_LOADED_EXIT_CODE = 37;

/**
 * 重启方法。
 */
export type RestartMethod = "systemd" | "launchctl" | "schtasks" | "supervisor" | "test-mode";

/**
 * 重启尝试结果。
 */
export interface RestartAttempt {
  ok: boolean;
  method: RestartMethod;
  detail?: string;
  tried: string[];
}

/**
 * 默认 systemd 服务名。
 */
const DEFAULT_SYSTEMD_UNIT = "evoclaw-gateway.service";

/**
 * 默认 launchd label。
 */
const DEFAULT_LAUNCHD_LABEL = "ai.evoclaw.gateway";

/**
 * 默认 Windows 计划任务名。
 */
const DEFAULT_SCHTASKS_NAME = "EvoclawGateway";

/**
 * 解析 systemd 服务单元名。
 */
function normalizeSystemdUnit(raw?: string, profile?: string): string {
  const unit = raw?.trim();
  if (!unit) {
    if (profile && profile.trim()) {
      return `evoclaw-gateway-${profile.trim()}.service`;
    }
    return DEFAULT_SYSTEMD_UNIT;
  }
  return unit.endsWith(".service") ? unit : `${unit}.service`;
}

/**
 * 解析 launchd label。
 */
function resolveLaunchdLabel(profile?: string): string {
  if (profile && profile.trim()) {
    return `ai.evoclaw.gateway.${profile.trim()}`;
  }
  return DEFAULT_LAUNCHD_LABEL;
}

/**
 * 解析 schtasks 任务名。
 */
function resolveSchtasksName(env: NodeJS.ProcessEnv): string {
  const fromEnv = typeof env.EVOCLAW_SCHTASKS_NAME === "string" ? env.EVOCLAW_SCHTASKS_NAME.trim() : "";
  return fromEnv || DEFAULT_SCHTASKS_NAME;
}

/**
 * 格式化 spawnSync 错误详情。
 */
function formatSpawnDetail(result: {
  error?: unknown;
  status?: number | null;
  stdout?: string | null;
  stderr?: string | null;
}): string {
  const clean = (value: string | null | undefined) => {
    const text = typeof value === "string" ? value : "";
    return text.replace(/\s+/g, " ").trim();
  };
  if (result.error) {
    if (result.error instanceof Error) {
      return result.error.message;
    }
    if (typeof result.error === "string") {
      return result.error;
    }
    try {
      return JSON.stringify(result.error);
    } catch {
      return "unknown error";
    }
  }
  const stderr = clean(typeof result.stderr === "string" ? result.stderr : "");
  if (stderr) {
    return stderr;
  }
  const stdout = clean(typeof result.stdout === "string" ? result.stdout : "");
  if (stdout) {
    return stdout;
  }
  if (typeof result.status === "number") {
    return `exit ${result.status}`;
  }
  return "unknown error";
}

/**
 * 触发 supervisor 交接重启。
 *
 * @param opts 可选参数：
 *   - port: 用于清理陈旧进程的端口号（默认不清理）
 *   - env: 环境变量（用于测试覆盖）
 *   - skipStaleCleanup: 跳过陈旧进程清理
 */
export function triggerGatewayRestart(opts?: {
  port?: number;
  env?: NodeJS.ProcessEnv;
  skipStaleCleanup?: boolean;
}): RestartAttempt {
  const env = opts?.env ?? process.env;

  // 测试模式：直接返回成功，不执行任何外部命令
  if (env.VITEST === "1" || env.NODE_ENV === "test" || process.env.VITEST === "1") {
    return { ok: true, method: "test-mode", tried: [] };
  }

  // 1. 清理陈旧 gateway 进程
  if (!opts?.skipStaleCleanup && typeof opts?.port === "number" && opts.port > 0) {
    try {
      cleanStaleGatewayProcessesSync(opts.port);
    } catch {
      // 清理失败不阻断重启流程
    }
  }

  // 2. 平台分发
  const tried: string[] = [];
  if (process.platform === "linux") {
    return restartLinux(env, tried);
  }
  if (process.platform === "darwin") {
    return restartDarwin(env, tried);
  }
  if (process.platform === "win32") {
    return restartWindows(env, tried);
  }
  return {
    ok: false,
    method: "supervisor",
    detail: `unsupported platform: ${process.platform}`,
    tried,
  };
}

function restartLinux(env: NodeJS.ProcessEnv, tried: string[]): RestartAttempt {
  const unit = normalizeSystemdUnit(
    typeof env.EVOCLAW_SYSTEMD_UNIT === "string" ? env.EVOCLAW_SYSTEMD_UNIT : undefined,
    typeof env.EVOCLAW_PROFILE === "string" ? env.EVOCLAW_PROFILE : undefined,
  );
  // 先尝试 --user 实例
  const userArgs = ["--user", "restart", unit];
  tried.push(`systemctl ${userArgs.join(" ")}`);
  const userRestart = spawnSync("systemctl", userArgs, {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (!userRestart.error && userRestart.status === 0) {
    return { ok: true, method: "systemd", tried };
  }
  // 回退到 system 实例
  const systemArgs = ["restart", unit];
  tried.push(`systemctl ${systemArgs.join(" ")}`);
  const systemRestart = spawnSync("systemctl", systemArgs, {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (!systemRestart.error && systemRestart.status === 0) {
    return { ok: true, method: "systemd", tried };
  }
  return {
    ok: false,
    method: "systemd",
    detail: `user: ${formatSpawnDetail(userRestart)}; system: ${formatSpawnDetail(systemRestart)}`,
    tried,
  };
}

function restartDarwin(env: NodeJS.ProcessEnv, tried: string[]): RestartAttempt {
  const label =
    typeof env.EVOCLAW_LAUNCHD_LABEL === "string" && env.EVOCLAW_LAUNCHD_LABEL.trim()
      ? env.EVOCLAW_LAUNCHD_LABEL.trim()
      : resolveLaunchdLabel(
          typeof env.EVOCLAW_PROFILE === "string" ? env.EVOCLAW_PROFILE : undefined,
        );
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const domain = uid !== undefined ? `gui/${uid}` : "gui/501";
  const target = `${domain}/${label}`;
  const args = ["kickstart", "-k", target];
  tried.push(`launchctl ${args.join(" ")}`);
  const res = spawnSync("launchctl", args, {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (!res.error && res.status === 0) {
    return { ok: true, method: "launchctl", tried };
  }
  // 回退到 bootstrap
  const home = (typeof env.HOME === "string" ? env.HOME.trim() : "") || "";
  const plistPath = `${home || ""}/Library/LaunchAgents/${label}.plist`;
  const bootstrapArgs = ["bootstrap", domain, plistPath];
  tried.push(`launchctl ${bootstrapArgs.join(" ")}`);
  const boot = spawnSync("launchctl", bootstrapArgs, {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (
    boot.error ||
    (boot.status !== 0 &&
      boot.status !== LAUNCHCTL_ALREADY_LOADED_EXIT_CODE &&
      boot.status !== null)
  ) {
    return {
      ok: false,
      method: "launchctl",
      detail: formatSpawnDetail(boot),
      tried,
    };
  }
  if (boot.status === 0) {
    return { ok: true, method: "launchctl", tried };
  }
  // 已加载 → 再 kickstart 一次
  const retryArgs = ["kickstart", target];
  tried.push(`launchctl ${retryArgs.join(" ")}`);
  const retry = spawnSync("launchctl", retryArgs, {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (!retry.error && retry.status === 0) {
    return { ok: true, method: "launchctl", tried };
  }
  return {
    ok: false,
    method: "launchctl",
    detail: formatSpawnDetail(retry),
    tried,
  };
}

function restartWindows(env: NodeJS.ProcessEnv, tried: string[]): RestartAttempt {
  const taskName = resolveSchtasksName(env);
  // 先 /End 终止当前任务实例
  const endArgs = ["/End", "/TN", taskName];
  tried.push(`schtasks ${endArgs.join(" ")}`);
  spawnSync("schtasks", endArgs, {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    windowsHide: true,
  });
  // /Run 启动新实例
  const runArgs = ["/Run", "/TN", taskName];
  tried.push(`schtasks ${runArgs.join(" ")}`);
  const run = spawnSync("schtasks", runArgs, {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    windowsHide: true,
  });
  if (!run.error && run.status === 0) {
    return { ok: true, method: "schtasks", tried };
  }
  return {
    ok: false,
    method: "schtasks",
    detail: formatSpawnDetail(run),
    tried,
  };
}

/**
 * 暴露内部常量与函数给测试。
 */
export const __testing = {
  SPAWN_TIMEOUT_MS,
  LAUNCHCTL_ALREADY_LOADED_EXIT_CODE,
  DEFAULT_SYSTEMD_UNIT,
  DEFAULT_LAUNCHD_LABEL,
  DEFAULT_SCHTASKS_NAME,
  normalizeSystemdUnit,
  resolveLaunchdLabel,
  resolveSchtasksName,
  formatSpawnDetail,
};
