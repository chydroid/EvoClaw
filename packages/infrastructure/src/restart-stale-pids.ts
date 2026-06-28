/**
 * restart-stale-pids.ts — 跨平台陈旧 gateway 进程检测与清理
 *
 * 对齐 openclaw-main 的 src/infra/restart-stale-pids.ts。
 *
 * 设计意图：
 * - 重启前清理占用端口的陈旧 gateway 进程，防止 EADDRINUSE
 * - 永不杀掉当前进程及其祖先（防止级联自杀）
 * - Unix 用 lsof / ps；Windows 用 netstat / taskkill
 * - 提供 waitForPortFreeSync 阻塞等待端口释放
 *
 * 安全保证：
 * - 严格排除 self + ancestors
 * - 验证 PID 真的是 gateway 进程（通过命令行包含 "evoclaw" 关键字）
 * - 所有外部 spawn 都有超时限制
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const SPAWN_TIMEOUT_MS = 2000;
const POLL_SPAWN_TIMEOUT_MS = 400;
const STALE_SIGTERM_WAIT_MS = 600;
const STALE_SIGKILL_WAIT_MS = 400;
const PORT_FREE_POLL_INTERVAL_MS = 50;
const PORT_FREE_TIMEOUT_MS = 2000;
const MAX_ANCESTOR_WALK_DEPTH = 32;

/**
 * 进程终止结果。
 */
export interface TerminateResult {
  killed: number[];
  errors: Array<{ pid: number; error: string }>;
}

/**
 * 端口空闲检测结果。
 */
export type PollPortResult =
  | { free: true }
  | { free: false }
  | { free: null; permanent: boolean };

/**
 * 收集当前进程及其所有祖先 PID（防止级联自杀）。
 *
 * Linux: 读 /proc/<pid>/status
 * macOS: 调用 ps -o ppid= -p <pid>
 * Windows: 仅 process.ppid（不递归）
 */
export function getSelfAndAncestorPidsSync(spawnTimeoutMs = SPAWN_TIMEOUT_MS): Set<number> {
  const pids = new Set<number>([process.pid]);
  const immediateParent = process.ppid;
  if (!Number.isFinite(immediateParent) || immediateParent <= 0) {
    return pids;
  }
  pids.add(immediateParent);

  const readTransitiveParent =
    process.platform === "linux"
      ? readParentPidFromProc
      : process.platform === "darwin"
        ? (pid: number) => readParentPidFromPs(pid, spawnTimeoutMs)
        : null;

  if (!readTransitiveParent) {
    return pids;
  }

  let current = immediateParent;
  for (let depth = 0; depth < MAX_ANCESTOR_WALK_DEPTH; depth++) {
    const parent = readTransitiveParent(current);
    if (parent == null || parent <= 0 || pids.has(parent)) {
      break;
    }
    pids.add(parent);
    current = parent;
  }
  return pids;
}

function readParentPidFromProc(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^PPid:\s*(\d+)/m);
    if (!match) {
      return null;
    }
    const parsed = Number.parseInt(match[1] ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function readParentPidFromPs(pid: number, spawnTimeoutMs: number): number | null {
  try {
    const res = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: spawnTimeoutMs,
    });
    if (res.error || res.status !== 0 || !res.stdout.trim()) {
      return null;
    }
    const parsed = Number.parseInt(res.stdout.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 判断进程命令行是否为 evoclaw gateway 进程。
 * 关键字匹配：包含 "evoclaw" 或 "gateway"。
 */
export function isGatewayArgv(args: string[]): boolean {
  if (!Array.isArray(args) || args.length === 0) {
    return false;
  }
  const joined = args.join(" ").toLowerCase();
  return joined.includes("evoclaw") || joined.includes("gateway");
}

/**
 * Unix: 通过 /proc/<pid>/cmdline 或 ps 读取进程命令行。
 */
function readUnixProcessArgsSync(pid: number, spawnTimeoutMs: number): string[] | null {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const args = raw.split("\0").filter(Boolean);
      if (args.length > 0) {
        return args;
      }
    } catch {
      // fall through to ps
    }
  }
  try {
    const res = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: spawnTimeoutMs,
    });
    if (res.error || res.status !== 0 || !res.stdout.trim()) {
      return null;
    }
    return parsePsCommandLine(res.stdout.trim());
  } catch {
    return null;
  }
}

function parsePsCommandLine(raw: string): string[] {
  const args: string[] = [];
  for (const match of raw.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) {
      args.push(value);
    }
  }
  return args;
}

/**
 * Windows: 通过 netstat 找出端口监听 PID。
 */
function findWindowsListeningPidsOnPortSync(port: number, spawnTimeoutMs = POLL_SPAWN_TIMEOUT_MS): number[] {
  try {
    const res = spawnSync("netstat", ["-ano", "-p", "TCP"], {
      encoding: "utf8",
      timeout: spawnTimeoutMs,
      windowsHide: true,
    });
    if (res.error || res.status !== 0) {
      return [];
    }
    const pids = new Set<number>();
    const lines = res.stdout.split(/\r?\n/);
    const portPattern = new RegExp(`[:.]${port}\\s+\\d+\\.\\d+\\.\\d+\\.\\d+:\\d+\\s+LISTENING\\s+(\\d+)`, "i");
    for (const line of lines) {
      const match = line.match(portPattern);
      if (match && match[1]) {
        const pid = Number.parseInt(match[1], 10);
        if (Number.isFinite(pid) && pid > 0) {
          pids.add(pid);
        }
      }
    }
    return Array.from(pids);
  } catch {
    return [];
  }
}

/**
 * Windows: 通过 wmic 读取进程命令行。
 */
function readWindowsProcessArgsSync(pid: number, spawnTimeoutMs = POLL_SPAWN_TIMEOUT_MS): string[] | null {
  try {
    const res = spawnSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CommandLine"], {
      encoding: "utf8",
      timeout: spawnTimeoutMs,
      windowsHide: true,
    });
    if (res.error || res.status !== 0) {
      return null;
    }
    // wmic 输出格式：第一行 CommandLine 标题，后续行才是真实命令行
    const lines = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) {
      return null;
    }
    const cmdline = lines.slice(1).join(" ");
    if (!cmdline) {
      return null;
    }
    return parsePsCommandLine(cmdline);
  } catch {
    return null;
  }
}

/**
 * lsof -Fpc 输出中的一条记录（pid + 可选的 cmd 名）。
 */
export interface LsofEntry {
  pid: number;
  cmd?: string;
}

/**
 * 解析 lsof -Fpc 输出为 {pid, cmd} 对数组（纯解析，不做过滤）。
 *
 * lsof -Fpc 输出格式：
 *   p12345
 *   cnode
 *   p67890
 *   cpython
 *
 * 其中 p 行是 PID，c 行是进程命令名（不是完整 argv）。
 */
export function parseLsofEntries(stdout: string): LsofEntry[] {
  const entries: LsofEntry[] = [];
  let currentPid: number | undefined;
  let currentCmd: string | undefined;
  const flush = () => {
    if (currentPid != null) {
      entries.push({ pid: currentPid, ...(currentCmd ? { cmd: currentCmd } : {}) });
    }
  };
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith("p")) {
      flush();
      const parsed = Number.parseInt(line.slice(1), 10);
      currentPid = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      currentCmd = undefined;
    } else if (line.startsWith("c")) {
      currentCmd = line.slice(1);
    }
  }
  flush();
  return entries;
}

/**
 * 从 lsof 条目中过滤出 gateway PID（排除自身及祖先）。
 * - cmd 包含 "evoclaw" 或 "gateway" → 直接接受
 * - 否则尝试通过 ps/proc 验证 argv
 */
function filterGatewayPidsFromLsof(entries: LsofEntry[], spawnTimeoutMs: number): number[] {
  const excluded = getSelfAndAncestorPidsSync(spawnTimeoutMs);
  const pids: number[] = [];
  for (const entry of entries) {
    if (excluded.has(entry.pid)) {
      continue;
    }
    const cmd = entry.cmd?.toLowerCase() ?? "";
    if (cmd.includes("evoclaw") || cmd.includes("gateway")) {
      pids.push(entry.pid);
      continue;
    }
    // 回退：通过 ps / /proc 验证 argv
    if (verifyGatewayPidByArgvSync(entry.pid, spawnTimeoutMs)) {
      pids.push(entry.pid);
    }
  }
  return Array.from(new Set(pids));
}

/**
 * 通过 ps / /proc 验证 PID 是否为 gateway 进程。
 */
function verifyGatewayPidByArgvSync(pid: number, spawnTimeoutMs: number): boolean {
  const args = readUnixProcessArgsSync(pid, spawnTimeoutMs);
  return args != null && isGatewayArgv(args);
}

/**
 * Unix: 使用 lsof 查找端口监听 PID。
 */
function findUnixListeningPidsOnPortSync(port: number, spawnTimeoutMs = SPAWN_TIMEOUT_MS): number[] {
  try {
    const res = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
      encoding: "utf8",
      timeout: spawnTimeoutMs,
    });
    if (res.error || (res.status !== 0 && res.status !== 1)) {
      return [];
    }
    const entries = parseLsofEntries(res.stdout || "");
    return filterGatewayPidsFromLsof(entries, spawnTimeoutMs);
  } catch {
    return [];
  }
}

/**
 * 查找占用端口的 gateway 进程 PID（不包括自身及祖先）。
 */
export function findGatewayPidsOnPortSync(port: number, spawnTimeoutMs = SPAWN_TIMEOUT_MS): number[] {
  if (process.platform === "win32") {
    const candidates = findWindowsListeningPidsOnPortSync(port, spawnTimeoutMs);
    return filterVerifiedWindowsGatewayPids(candidates);
  }
  return findUnixListeningPidsOnPortSync(port, spawnTimeoutMs);
}

/**
 * Windows: 过滤验证 gateway PID。
 */
function filterVerifiedWindowsGatewayPids(rawPids: number[]): number[] {
  const excluded = getSelfAndAncestorPidsSync();
  const verified: number[] = [];
  for (const pid of rawPids) {
    if (!Number.isFinite(pid) || pid <= 0 || excluded.has(pid)) {
      continue;
    }
    const args = readWindowsProcessArgsSync(pid);
    if (args != null && isGatewayArgv(args)) {
      verified.push(pid);
    }
  }
  return Array.from(new Set(verified));
}

/**
 * 同步等待进程退出（轮询 process.kill(pid, 0)）。
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 同步睡眠。使用 Atomics.wait 实现真正阻塞（不消耗 CPU）。
 */
function sleepSync(ms: number): void {
  const timeoutMs = Math.max(0, Math.floor(ms));
  if (timeoutMs <= 0) {
    return;
  }
  try {
    const lock = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(lock, 0, 0, timeoutMs);
  } catch {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // best-effort fallback
    }
  }
}

/**
 * 终止陈旧进程。
 * Unix: SIGTERM → 等 600ms → SIGKILL（仍存活则）
 * Windows: taskkill /T → 等 → taskkill /F /T
 */
export function terminateStaleProcessesSync(pids: number[]): TerminateResult {
  if (!Array.isArray(pids) || pids.length === 0) {
    return { killed: [], errors: [] };
  }
  if (process.platform === "win32") {
    return terminateStaleProcessesWindows(pids);
  }
  return terminateStaleProcessesUnix(pids);
}

function terminateStaleProcessesUnix(pids: number[]): TerminateResult {
  const killed: number[] = [];
  const errors: Array<{ pid: number; error: string }> = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch (err) {
      errors.push({ pid, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (killed.length === 0) {
    return { killed, errors };
  }
  sleepSync(STALE_SIGTERM_WAIT_MS);
  for (const pid of killed) {
    try {
      process.kill(pid, 0);
      // 仍存活 — SIGKILL
      process.kill(pid, "SIGKILL");
    } catch {
      // 已退出
    }
  }
  sleepSync(STALE_SIGKILL_WAIT_MS);
  return { killed, errors };
}

function terminateStaleProcessesWindows(pids: number[]): TerminateResult {
  const killed: number[] = [];
  const errors: Array<{ pid: number; error: string }> = [];
  const taskkillPath = path.win32.join(
    process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
  for (const pid of pids) {
    const graceful = safeSpawnSync(taskkillPath, ["/T", "/PID", String(pid)], 5000);
    const gracefulOk =
      graceful.error == null && (graceful.status ?? 0) === 0 && !isProcessAlive(pid);
    if (gracefulOk) {
      killed.push(pid);
      continue;
    }
    sleepSync(STALE_SIGTERM_WAIT_MS);
    if (!isProcessAlive(pid)) {
      killed.push(pid);
      continue;
    }
    const forced = safeSpawnSync(taskkillPath, ["/F", "/T", "/PID", String(pid)], 5000);
    if (forced.error != null || (forced.status ?? 0) !== 0) {
      errors.push({
        pid,
        error: `taskkill failed: status=${forced.status ?? "null"} err=${formatSpawnError(forced.error)}`,
      });
      continue;
    }
    sleepSync(STALE_SIGKILL_WAIT_MS);
    if (!isProcessAlive(pid)) {
      killed.push(pid);
    } else {
      errors.push({ pid, error: "process still alive after SIGKILL" });
    }
  }
  return { killed, errors };
}

function safeSpawnSync(cmd: string, args: string[], timeoutMs: number): SpawnSyncReturns<string> {
  try {
    return spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return {
      error: err as Error,
      status: null,
      stdout: "",
      stderr: "",
      pid: -1,
      output: [],
      signal: null,
    } as unknown as SpawnSyncReturns<string>;
  }
}

function formatSpawnError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown error";
  }
}

/**
 * 单次轮询端口是否空闲。
 */
function pollPortOnce(port: number): PollPortResult {
  try {
    if (process.platform === "win32") {
      const pids = findWindowsListeningPidsOnPortSync(port, POLL_SPAWN_TIMEOUT_MS);
      return pids.length === 0 ? { free: true } : { free: false };
    }
    const res = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
      encoding: "utf8",
      timeout: POLL_SPAWN_TIMEOUT_MS,
    });
    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code;
      const permanent = code === "ENOENT" || code === "EACCES" || code === "EPERM";
      return { free: null, permanent };
    }
    if (res.status === 1) {
      // lsof 标准"无匹配进程"退出码
      if (res.stdout) {
        const entries = parseLsofEntries(res.stdout);
        const pids = filterGatewayPidsFromLsof(entries, POLL_SPAWN_TIMEOUT_MS);
        return pids.length === 0 ? { free: true } : { free: false };
      }
      return { free: true };
    }
    if (res.status !== 0) {
      return { free: null, permanent: false };
    }
    const entries = parseLsofEntries(res.stdout || "");
    const pids = filterGatewayPidsFromLsof(entries, POLL_SPAWN_TIMEOUT_MS);
    return pids.length === 0 ? { free: true } : { free: false };
  } catch {
    return { free: null, permanent: false };
  }
}

/**
 * 阻塞等待端口释放。
 * - { free: true } 立即返回
 * - { free: null, permanent: true } 立即返回（lsof 不可用）
 * - { free: false } 或 transient：sleep + retry
 * - 超时：警告并返回（让调用方继续重启）
 */
export function waitForPortFreeSync(port: number): void {
  const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = pollPortOnce(port);
    if (result.free === true) {
      return;
    }
    if (result.free === null && result.permanent) {
      return;
    }
    sleepSync(PORT_FREE_POLL_INTERVAL_MS);
  }
  // 超时：仍占用，警告但继续
}

/**
 * 检测并清理占用端口的陈旧 gateway 进程。
 *
 * 返回被杀掉的 PID 列表。
 */
export function cleanStaleGatewayProcessesSync(port: number): number[] {
  try {
    if (!Number.isFinite(port) || port <= 0) {
      return [];
    }
    const stalePids = findGatewayPidsOnPortSync(port);
    if (stalePids.length === 0) {
      return [];
    }
    const result = terminateStaleProcessesSync(stalePids);
    // 即使 killed 为空也等待端口释放（进程退出但 socket TIME_WAIT）
    waitForPortFreeSync(port);
    return result.killed;
  } catch {
    return [];
  }
}

/**
 * 暴露内部常量给测试。
 */
export const __testing = {
  SPAWN_TIMEOUT_MS,
  POLL_SPAWN_TIMEOUT_MS,
  STALE_SIGTERM_WAIT_MS,
  STALE_SIGKILL_WAIT_MS,
  PORT_FREE_POLL_INTERVAL_MS,
  PORT_FREE_TIMEOUT_MS,
  MAX_ANCESTOR_WALK_DEPTH,
  sleepSync,
  parsePsCommandLine,
  readUnixProcessArgsSync,
  readWindowsProcessArgsSync,
  findWindowsListeningPidsOnPortSync,
  pollPortOnce,
  filterGatewayPidsFromLsof,
};
