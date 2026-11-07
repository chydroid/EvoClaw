/**
 * ProcessTreeKiller — 跨平台进程树终止
 *
 * 借鉴 hermes-agent tools/process_registry.py（1760 行）的进程树终止逻辑：
 *
 * 核心机制：
 *   - POSIX：递归获取所有子进程 PID，逐个终止
 *   - Windows：使用 taskkill /T /F 终止进程树
 *   - PID 存在性检查（Windows bpo-14484 陷阱：已死 PID 可能被复用）
 *
 * 安全：
 *   - PID 0/1 永不终止（系统进程）
 *   - 当前进程 PID 永不终止（自杀保护）
 *   - 终止前先 SIGTERM，超时后 SIGKILL
 *   - 所有错误捕获，永不抛出异常
 *
 * 使用场景：
 *   - agent 启动的子进程失控
 *   - 超时任务清理
 *   - 会话重置时清理活跃进程
 */

import { spawn, exec, ChildProcess } from "child_process";
import { platform } from "os";

const isWindows = platform() === "win32";

// ── 幸存者复查（对齐 Hermes process_registry_termination.py._post_kill_survivors）──
// killProcessTree 在一轮信号杀完、settle 复查后，KillResult 携带 survivors（仍存活
// 的进程）。调用方据此 fail-closed（不写 killed 收据、会话保留在 running）。
// 复查覆盖：grace 期间新 spawn 的孤儿（reparent 到 init 之前的短窗口内仍可被
// /proc children 抓到）、惰性 exit（killPid 的 100ms 兜底验证可能错过）。
// 存活探测可注入（KillOptions.isAlive，默认 pidExists → process.kill(pid,0)）。
// settle 参数：20 步 × 50ms = 1.0s，对齐 Hermes _KILL_SETTLE_SECONDS 0.05s 探针节奏。
const KILL_SETTLE_STEPS = 20; // 对齐 Hermes _KILL_SETTLE_SECONDS = 1.0
const KILL_SETTLE_STEP_MS = 50; // 对齐 Hermes 0.05s 探针间隔

const logger = {
  debug(msg: string, data?: Record<string, unknown>): void {
    if (process.env.EVOCLAW_DEBUG === "1" || process.env.LOG_LEVEL === "debug") {
      console.debug(`[process-tree-killer] ${msg}`, data ?? "");
    }
  },
  warn(msg: string, data?: Record<string, unknown>): void {
    console.warn(`[process-tree-killer] ${msg}`, data ?? "");
  },
};

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface KillOptions {
  /** SIGTERM 后等待 SIGKILL 的超时（毫秒），默认 5000 */
  gracePeriodMs?: number;
  /** 是否强制终止（跳过 SIGTERM，直接 SIGKILL），默认 false */
  force?: boolean;
  /** 是否递归终止子进程，默认 true */
  recursive?: boolean;
  /** 存活探测（可注入；默认 pidExists）。测试用注入桩控制幸存者验证；
   *  prob 抛异常按 survive 处理（fail-closed）。 */
  isAlive?: (pid: number) => Promise<boolean>;
  /** 幸存者复查 settle 总时长（毫秒），默认 KILL_SETTLE_STEPS × KILL_SETTLE_STEP_MS = 1.0s */
  killSettleMs?: number;
}

export interface KillResult {
  success: boolean;
  killedPids: number[];
  failedPids: number[];
  /** 复查后仍存活的进程（fail-closed：调用方据此不写 killed 收据、保留会话在 running）。
   * 与 failedPids 同一集合，显式命名供语义区分（幸存者验证）。 */
  survivors?: number[];
  error?: string;
}

// ── 安全检查 ────────────────────────────────────────────────────────────────

/**
 * 受保护的 PID 集合：永不终止。
 *
 * 借鉴 hermes-agent _PROTECTED_PIDS：
 *   - PID 0：内核调度器（Linux）/ System Idle Process（Windows）
 *   - PID 1：init/systemd（Linux）/ System（Windows）
 */
const PROTECTED_PIDS = new Set([0, 1]);

/**
 * 检查 PID 是否安全可终止。
 */
function isSafeToKill(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (PROTECTED_PIDS.has(pid)) return false;
  // 永不终止当前进程
  if (pid === process.pid) return false;
  // 永不终止父进程
  if (pid === process.ppid) return false;
  return true;
}

// ── POSIX 进程树获取 ────────────────────────────────────────────────────────

/**
 * 获取 POSIX 系统下指定 PID 的所有子进程 PID（递归）。
 *
 * 借鉴 hermes-agent _get_child_pids_posix：
 *   使用 psutil 风格的递归 children 获取。
 *   EvoClaw 实现使用 ps 命令（无需 Python 依赖）。
 *
 * 策略：
 *   1. 读取 /proc/<pid>/task/<pid>/children（Linux，最快）
 *   2. 回退到 ps -o pid --ppid <pid>（跨 POSIX）
 *   3. 递归收集所有后代
 */
async function getChildPidsPosix(parentPid: number): Promise<number[]> {
  const children: number[] = [];
  const visited = new Set<number>();
  const queue = [parentPid];

  while (queue.length > 0) {
    const currentPid = queue.shift()!;
    if (visited.has(currentPid)) continue;
    visited.add(currentPid);

    let directChildren: number[] = [];

    // 方法 1：读取 /proc/<pid>/task/<pid>/children（Linux 专用，最快）
    if (process.platform === "linux") {
      try {
        const { readFileSync } = require("fs") as typeof import("fs");
        const childrenContent = readFileSync(`/proc/${currentPid}/task/${currentPid}/children`, "utf8");
        directChildren = childrenContent.trim().split(/\s+/).filter(Boolean).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
      } catch {
        // 文件不存在或无权限，回退到 ps
      }
    }

    // 方法 2：ps 命令（跨 POSIX 回退）
    if (directChildren.length === 0) {
      directChildren = await getPidsViaPs(currentPid);
    }

    for (const childPid of directChildren) {
      if (!visited.has(childPid) && isSafeToKill(childPid)) {
        children.push(childPid);
        queue.push(childPid);
      }
    }
  }

  return children;
}

/**
 * 通过 ps 命令获取子进程 PID。
 */
async function getPidsViaPs(parentPid: number): Promise<number[]> {
  return new Promise((resolve) => {
    // ps -o pid --ppid <parentPid> --noheaders
    const proc = spawn("ps", ["-o", "pid", "--ppid", String(parentPid), "--noheaders"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.on("error", () => resolve([]));
    proc.on("close", () => {
      const pids = stdout.trim().split("\n")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && isSafeToKill(n));
      resolve(pids);
    });
  });
}

// ── Windows 进程树获取 ──────────────────────────────────────────────────────

/**
 * 获取 Windows 下指定 PID 的所有子进程 PID（递归）。
 *
 * 借鉴 hermes-agent _get_child_pids_windows：
 *   使用 wmic 或 PowerShell Get-CimInstance。
 */
async function getChildPidsWindows(parentPid: number, maxDepth = 10): Promise<number[]> {
  return new Promise((resolve) => {
    // 深度限制，防止深进程树导致栈溢出或大量 PowerShell 进程
    if (maxDepth <= 0) {
      resolve([]);
      return;
    }
    // 验证 parentPid 为纯数字，防止命令注入
    if (!/^\d+$/.test(String(parentPid))) {
      resolve([]);
      return;
    }
    // 使用 PowerShell 获取子进程
    const cmd = `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${parentPid} } | Select-Object -ExpandProperty ProcessId`;
    const proc = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.on("error", () => resolve([]));
    proc.on("close", () => {
      const directChildren = stdout.trim().split("\n")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && isSafeToKill(n));

      if (directChildren.length === 0) {
        resolve([]);
        return;
      }

      // 递归获取子进程的子进程
      const allChildren = [...directChildren];
      const promises = directChildren.map((pid) => getChildPidsWindows(pid, maxDepth - 1));
      Promise.all(promises).then((nested) => {
        for (const children of nested) {
          allChildren.push(...children);
        }
        resolve(allChildren);
      }).catch(() => resolve(allChildren));
    });
  });
}

// ── PID 存在性检查 ──────────────────────────────────────────────────────────

/**
 * 检查 PID 是否存在（进程是否在运行）。
 *
 * 借鉴 hermes-agent _pid_exists：
 *   Windows bpo-14484 陷阱：
 *   - Windows 上 process.kill(pid, 0) 对已死 PID 可能返回 true
 *   - 因为 PID 可能被复用
 *   - 解决方案：使用 OpenProcess 检查，或接受这个限制
 *
 * EvoClaw 实现：
 *   - POSIX：process.kill(pid, 0) 可靠
 *   - Windows：使用 tasklist /FI "PID eq <pid>" 检查
 */
export async function pidExists(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (PROTECTED_PIDS.has(pid)) return true;

  if (isWindows) {
    return new Promise((resolve) => {
      const proc = spawn("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.on("error", () => resolve(false));
      proc.on("close", () => {
        // tasklist 输出：如果 PID 存在，输出 "ImageName","PID","SessionName",...
        // 如果不存在，输出 "信息: 没有运行的任务匹配指定标准。"
        resolve(stdout.includes(`"${pid}"`));
      });
    });
  }

  // POSIX：使用 process.kill(pid, 0)
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── 低层信号 ──────────────────────────────────────────────────────────────────

/**
 * 发送信号（永不抛出：ESRCH/无权限 → false = 无法送达（进程已退出））。
 */
function sendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

// ── 单进程终止 ───────────────────────────────────────────────────────────────

/**
 * 终止单个进程。
 *
 * 借鉴 hermes-agent _kill_pid：
 *   - 先 SIGTERM（除非 force）
 *   - 等待 grace period
 *   - 仍存活则 SIGKILL
 */
async function killPid(pid: number, options: KillOptions, probe?: (pid: number) => Promise<boolean>): Promise<boolean> {
  if (!isSafeToKill(pid)) return false;
  const isAlive = probe ?? ((p: number) => pidExists(p));
  const gracePeriodMs = options.gracePeriodMs ?? 5000;
  const force = options.force ?? false;

  if (isWindows) {
    // Windows：使用 taskkill
    // /T = 终止子进程，/F = 强制
    return new Promise((resolve) => {
      const args = options.recursive !== false ? ["/T", "/F", "/PID", String(pid)] : ["/F", "/PID", String(pid)];
      const proc = spawn("taskkill", args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => {
        resolve(code === 0);
      });
    });
  }

  // POSIX
  try {
    if (!force) {
      // 先 SIGTERM
      sendSignal(pid, "SIGTERM");

      // 等待 grace period
      const startTime = Date.now();
      while (Date.now() - startTime < gracePeriodMs) {
        await sleep(100);
        if (!(await isAlive(pid))) {
          return true;
        }
      }

      // 仍存活，SIGKILL
      if (await isAlive(pid)) {
        sendSignal(pid, "SIGKILL");
      }
    } else {
      // 直接 SIGKILL
      sendSignal(pid, "SIGKILL");
    }

    // 验证已终止
    await sleep(100);
    return !(await isAlive(pid));
  } catch (err) {
    logger.debug("killPid failed", { pid, error: (err as Error).message });
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

// ── 主函数 ──────────────────────────────────────────────────────────────────

/**
 * 终止进程树（包括所有子进程）。
 *
 * 借鉴 hermes-agent ProcessRegistry.kill_process_tree + ProcessTerminationMixin：
 *   1. 信号前快照子进程（term 前先抓一遍 /proc children）；
 *   2. 先向父进程发送 SIGTERM，在 grace 窗口内
 *      **父进程仍存活时反复重扫子进程**（grace 期间新 spawn 的后代在
 *      reparent 到 init 之前仍挂在父进程 children 下，重扫把它们一网打尽并信号）；
 *   3. grace 结束后仍存活 → SIGKILL 升级（父 + 全部已知后代）；
 *   4. 幸存者复查：KILL_SETTLE_STEPS × KILL_SETTLE_STEP_MS = 1.0s 的 settle 窗口内
 *      对全部已知 PID 探测存活（父存活时再重扫一次新 children），
 *      复查后仍存活者记为 survivors → 调用方 fail-closed（不写 killed 收据、保留会话在 running）。
 *      探测异常按存活处理（fail-closed：不可验证 = 幸存者）。
 *
 * @param pid 根进程 PID
 * @param options 终止选项
 */
export async function killProcessTree(
  pid: number,
  options: KillOptions = {},
): Promise<KillResult> {
  if (!isSafeToKill(pid)) {
    return {
      success: false,
      killedPids: [],
      failedPids: [],
      survivors: [],
      error: "unsafe pid (protected or self)",
    };
  }

  const force = options.force ?? false;
  // 存活探测注入（默认 pidExists）；probe 抛异常 → 按存活处理（fail-closed）
  const isAlive = options.isAlive ?? ((p: number) => pidExists(p));
  const alive = async (p: number): Promise<boolean> => {
    try {
      return await isAlive(p);
    } catch {
      return true;
    };
  };

  const seen = new Set<number>([pid]); // 已确认的树内 PID
  const killedPids: number[] = [];
  const failedPids: number[] = [];

  try {
    // Windows：taskkill /T /F 一次性终止整个树
    if (isWindows) {
      const success = await killPid(pid, { ...options, recursive: true }, isAlive);
      const survivors = (await alive(pid)) ? [pid] : [];
      if (success) {
        killedPids.push(pid);
      } else {
        failedPids.push(pid);
      }
      return {
        success: failedPids.length === 0,
        killedPids,
        failedPids,
        survivors: survivors.length > 0 ? survivors : undefined,
      };
    }

    // ── POSIX ──
    // 1) 信号前快照子进程（recursive=false 时不扩张后代集）
    if (options.recursive !== false) {
      for (const c of await getChildPidsPosix(pid)) seen.add(c);
    }
    logger.debug("found child processes", { parentPid: pid, childCount: seen.size - 1 });

    // 2) 父进程先 SIGTERM；grace 窗口内父存活时每 100ms 重扫 children
    //    并信号（对齐 Hermes _terminate_tree 的"存活时重扫"语义）。
    if (!force) {
      sendSignal(pid, "SIGTERM");
      const gracePeriodMs = options.gracePeriodMs ?? 5000;
      const graceDeadline = Date.now() + gracePeriodMs;
      while (Date.now() < graceDeadline) {
        if (!(await alive(pid))) break;
        if (options.recursive !== false) {
          // 重扫捕获 grace 期间新 spawn 的后代（在 reparent 前的短暂窗口仍可见）
          for (const c of await getChildPidsPosix(pid)) {
            if (!seen.has(c)) {
              seen.add(c);
              sendSignal(c, "SIGTERM");
            }
          }
        }
        const remaining = graceDeadline - Date.now();
        await sleep(remaining <= 100 ? Math.max(1, remaining) : 100);
      }

      // 3) 升级：仍存活的父 + 全部已知后代 → SIGKILL
      if (await alive(pid)) {
        sendSignal(pid, "SIGKILL");
      }
      for (const c of seen) {
        if (c !== pid && (await alive(c))) sendSignal(c, "SIGKILL");
      }
    } else {
      // force：直接 SIGKILL（先快照已知后代再一并信号）
      sendSignal(pid, "SIGKILL");
      if (options.recursive !== false) {
        for (const c of await getChildPidsPosix(pid)) {
          if (!seen.has(c)) {
            seen.add(c);
            sendSignal(c, "SIGKILL");
          }
        }
      }
    }

    // 4) 幸存者复查（Hermes _post_kill_survivors 语义）：
    //    settle 窗口内反复探测全部已知 PID；父进程仍存活时再重扫新 children；
    //    窗口结束后仍存活者 = survivors（fail-closed）。
    const settleMs = options.killSettleMs ?? KILL_SETTLE_STEPS * KILL_SETTLE_STEP_MS;
    const settleDeadline = Date.now() + settleMs;
    let survivors: number[] = [];
    do {
      // 父存活时重扫新后代（复查窗口可能还有晚生进程挂着链表尾）
      if ((await alive(pid)) && options.recursive !== false) {
        for (const c of await getChildPidsPosix(pid)) {
          if (!seen.has(c)) {
            seen.add(c);
            sendSignal(c, "SIGKILL"); // 晚生存活者直接强杀
          }
        }
      }
      const still: number[] = [];
      if (await alive(pid)) still.push(pid);
      for (const c of seen) {
        if (c !== pid && (await alive(c))) still.push(c);
      }
      survivors = Array.from(new Set(still)).sort((a, b) => a - b);
      if (survivors.length === 0) break;
      const remaining = Math.max(1, settleDeadline - Date.now());
      await sleep(Math.min(KILL_SETTLE_STEP_MS, remaining));
    } while (Date.now() < settleDeadline);

    for (const p of Array.from(seen).sort((a, b) => a - b)) {
      if (survivors.includes(p)) {
        failedPids.push(p);
      } else {
        killedPids.push(p);
      }
    }

    return {
      success: failedPids.length === 0,
      killedPids,
      failedPids,
      survivors,
    };
  } catch (err) {
    logger.warn("killProcessTree exception", { pid, error: (err as Error).message });
    // exception 路径不甘心跳过验证：对仍存活者按幸存者上报（fail-closed）
    const s: number[] = [];
    if (await alive(pid)) s.push(pid);
    for (const c of seen) {
      if (c !== pid && (await alive(c))) s.push(c);
    }
    return {
      success: false,
      killedPids,
      failedPids,
      survivors: Array.from(new Set(s)).sort((a, b) => a - b),
      error: (err as Error).message,
    };
  }
}

/**
 * 终止 ChildProcess 及其进程树。
 *
 * 便捷方法：从 ChildProcess 对象获取 PID 并终止。
 */
export async function killChildProcessTree(
  childProcess: ChildProcess,
  options: KillOptions = {},
): Promise<KillResult> {
  const pid = childProcess.pid;
  if (!pid) {
    return {
      success: false,
      killedPids: [],
      failedPids: [],
      error: "child process has no pid",
    };
  }
  return killProcessTree(pid, options);
}

/**
 * 通过进程名查找 PID（跨平台）。
 *
 * 借鉴 hermes-agent find_pids_by_name：
 *   用于在只知道进程名时终止进程。
 */
export async function findPidsByName(name: string): Promise<number[]> {
  if (!name) return [];

  return new Promise((resolve) => {
    if (isWindows) {
      const proc = spawn("tasklist", ["/FO", "CSV", "/NH"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.on("error", () => resolve([]));
      proc.on("close", () => {
        const pids: number[] = [];
        for (const line of stdout.split("\n")) {
          // 格式："ImageName","PID","SessionName",...
          const match = line.match(/^"([^"]+)","(\d+)"/);
          if (match) {
            const imageName = match[1].toLowerCase();
            const pid = parseInt(match[2], 10);
            if (imageName.includes(name.toLowerCase()) && isSafeToKill(pid)) {
              pids.push(pid);
            }
          }
        }
        resolve(pids);
      });
    } else {
      let settled = false;
      const proc = spawn("pgrep", ["-f", name], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.on("error", () => {
        if (settled) return;
        settled = true;
        // pgrep 不可用，回退到 ps
        const psProc = spawn("ps", ["-eo", "pid,comm"], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let psStdout = "";
        psProc.stdout.on("data", (d: Buffer) => { psStdout += d.toString(); });
        psProc.on("error", () => resolve([]));
        psProc.on("close", () => {
          const pids: number[] = [];
          for (const line of psStdout.split("\n").slice(1)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const parts = trimmed.split(/\s+/);
            const pid = parseInt(parts[0], 10);
            const comm = parts.slice(1).join(" ").toLowerCase();
            if (!isNaN(pid) && comm.includes(name.toLowerCase()) && isSafeToKill(pid)) {
              pids.push(pid);
            }
          }
          resolve(pids);
        });
      });
      proc.on("close", () => {
        if (settled) return;
        settled = true;
        const pids = stdout.trim().split("\n")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n) && isSafeToKill(n));
        resolve(pids);
      });
    }
  });
}
