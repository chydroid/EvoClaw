/**
 * 会话持久解释器 kernel（对齐 Hermes `tools/code_kernel.py`）。
 *
 * 问题：execute_code 进程后端当前每次调用 spawn 新解释器 → 变量不跨调用、
 * 重库（numpy/pandas 类）import 每次重付全价。Hermes 做法：每个
 * (owner, interpreter, cwd) 键一个常驻子进程，one code cell per call，
 * 状态（GLOBALS）跨调用存活，只是生命周期被拉长。
 *
 * 约束（继承 Hermes 文档三条）：
 * 1. 安全信封与 per-call 一致：同解释器、同 env（env 冻结在 spawn 时刻）、
 *    同输出截断、同超时语义——只有生命周期变宽。软沙箱拦不住用户代码
 *    再 spawn 子进程（弱隔离，结果 note 已向模型/用户标注），与 per-call 同。
 * 2. 卡死的 kernel 宁可死、绝不挂住 agent：超时 kill 进程树、丢弃注册表
 *    条目；状态丢失是刻意的（没有安全原地打断手段，下次调用重启新 kernel）。
 * 3. env 冻结在 spawn：reset=true 语义 = 换新进程重起（解释器内做不到）。
 *
 * Wire protocol（行协议，比 Hermes 的 SENTINEL 长度帧简单一档，安全性同论）：
 * - 请求：stdin 一行 `{"id","code"}`。
 * - 响应：stdout 一行 `__EVOCLAW_KERNEL_RESULT:{...payload, "sentinel"}`，
 *   payload 含该请求的 id 与递增执行计数；sentinel 每 kernel 随机，用户
 *   print 伪造帧最多自证自骗（攻击者已控制该 cell 执行，与 Hermes 同论）。
 * - 非帧行 = cell 原始 stdout 绕过（sys.__stdout__ / os.write），宿主端归属。
 * - 调用按 kernel 串行化（同 Hermes："calls are serialized per kernel"）。
 *
 * 生命周期：LRU 池（默认 N=4，键 owner|interpreter|cwd）；空闲超时回收；
 * 附着中的 cell 不被驱逐（Hermes 教训：teardown 撞在并发 spawn 会被踢死）；
 * 宿主进程任意死亡 → 子进程看门狗轮询 /proc/<parent-pid>（仅 Linux）消失即
 * os._exit；Windows 暂无线上看门，靠宿主退出钩子清理。遗留 staging 目录由
 * 低频 reaper 清扫（>7 天）。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** runner 侧单 cell 捕获上限（字符），宿主另施 100K 截断 */
export const RUNNER_CAPTURE_LIMIT = 1_000_000;
/** staging 目录残留清扫年龄阈值 */
export const STALE_DIR_AGE_MS = 7 * 86400_000;
/** 默认池大小 / 空闲回收阈值（对齐 Hermes DEFAULT_MAX_SESSION_KERNELS / DEFAULT_KERNEL_IDLE_TIMEOUT） */
export const DEFAULT_MAX_SESSION_KERNELS = 4;
export const DEFAULT_KERNEL_IDLE_TIMEOUT_MS = 1800_000;

const REPLY_PREFIX = "__EVOCLAW_KERNEL_RESULT:";
const TMPDIR_PREFIX = "evoclaw-kernel-";

/** runner 回传的 cell 载荷（Python 侧 run_cell 的产物） */
interface RunnerCellPayload {
  id?: string;
  status: "ok" | "exit" | "error";
  stdout: string;
  stderr: string;
  traceback: string;
  execution_count: number;
}

/**
 * 持久 Python runner（写入 kernel tmpdir 后执行；对应 Hermes KERNEL_RUNNER_SOURCE）。
 * 状态在 GLOBALS 字典内跨 cell 存活；SystemExit 即 kernel 终点。
 */
export const PYTHON_KERNEL_RUNNER_SOURCE = [
  '"""Auto-generated EvoClaw session kernel runner: one exec per request, GLOBALS persists.',
  'Wire: one JSON request per stdin line {"id","code"}; reply = one JSON line between',
  '__EVOCLAW_KERNEL_RESULT: and a line break, carrying sentinel + id + cell payload.',
  'A SystemExit in a cell ends the kernel.',
  '"""',
  "import contextlib",
  "import io",
  "import json",
  "import os",
  "import sys",
  "import threading",
  "import traceback",
  "",
  "_SENTINEL = os.environ[\"EVOCLAW_KERNEL_SENTINEL\"]",
  "_CAPTURE = int(os.environ.get(\"EVOCLAW_KERNEL_CAPTURE\", \"1000000\"))",
  "",
  "# 宿主死亡看门狗（POSIX 仅Linux）：轮询 /proc/<parent-pid>；宿主任意方式死亡",
  "# （含 SIGKILL / 崩溃）后节点消失，看门狗线程 os._exit(0) 清理孤儿 kernel。",
  "# 不用 PR_SET_PDEATHSIG（绑 spawn 线程而非进程）；不依赖 os.pipe（Node ≥20 已移除）。",
  "# 对齐 Hermes code_kernel.py watchdog 的意图；Windows 暂无线上方案，靠宿主退出钩子清理。",
  "_PARENT_PID = os.environ.get(\"EVOCLAW_KERNEL_PARENT_PID\", \"\")",
  "if _PARENT_PID and sys.platform.startswith(\"linux\") and os.path.isdir(\"/proc\"):",
  "    import time",
  "    _ppid = int(_PARENT_PID)",
  "    def _watch():",
  "        try:",
  "            while os.path.exists(\"/proc/%d\" % _ppid):",
  "                time.sleep(1.0)",
  "        except OSError:",
  "            pass",
  "        os._exit(0)",
  "    threading.Thread(target=_watch, name=\"evoclaw-kernel-parent-watchdog\", daemon=True).start()",
  "",
  "GLOBALS = {\"__name__\": \"__main__\", \"__builtins__\": __builtins__}",
  "",
  "",
  "def run_cell(request, execution_count):",
  "    out, err = io.StringIO(), io.StringIO()",
  "    status, trace = \"ok\", \"\"",
  "    try:",
  "        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):",
  "            exec(compile(request[\"code\"], \"<cell>\", \"exec\"), GLOBALS)",
  "    except SystemExit as exc:",
  "        status, trace = \"exit\", \"SystemExit: \" + repr(exc.code)",
  "    except BaseException:",
  "        status, trace = \"error\", traceback.format_exc()",
  "    return {",
  "        \"id\": request.get(\"id\", \"\"),",
  "        \"status\": status,",
  "        \"stdout\": out.getvalue()[:_CAPTURE],",
  "        \"stderr\": err.getvalue()[:_CAPTURE],",
  "        \"traceback\": trace,",
  "        \"execution_count\": execution_count,",
  "    }",
  "",
  "",
  "def main():",
  "    execution_count = 0",
  "    for raw_line in sys.stdin:",
  "        line = raw_line.strip()",
  "        if not line:",
  "            continue",
  "        try:",
  "            request = json.loads(line)",
  "        except ValueError:",
  "            continue",
  "        execution_count += 1",
  "        reply = run_cell(request, execution_count)",
  "        sys.stdout.write(\"__EVOCLAW_KERNEL_RESULT:\" + json.dumps({",
  "            \"__evoclaw_kernel_result\": reply, \"sentinel\": _SENTINEL",
  "        }, ensure_ascii=False) + \"\\n\")",
  "        sys.stdout.flush()",
  "        if reply[\"status\"] == \"exit\":",
  "            break",
  "",
  "",
  "if __name__ == \"__main__\":",
  "    main()",
  "",
].join("\n");

/** 单 cell 结果（供 shell-media-tools 拼装工具返回） */
export interface KernelCellResult {
  status: "success" | "error" | "timeout" | "exit" | "kernel-eof" | "spawn-error";
  exitCode: number;
  stdout: string;
  stderr: string;
  traceback?: string;
  timedOut: boolean;
  durationMs: number;
  /** 执行计数（runner 侧递增，隔着 kernel） */
  executionCount: number;
  /** 命中既有常驻进程（false = 本次新建/重启） */
  reused: boolean;
  /** 真因 reset 或旧进程死亡而换新（env/状态都是新的） */
  stateReset: boolean;
  error?: string;
  /** 实际解析到的解释器（candidate 探测） */
  interpreter?: string;
  /** 超时/EOF 类致命事件后该 kernel 已从注册表丢弃 */
  kernelDiscarded?: boolean;
}

export interface KernelExecuteOptions {
  owner: string;
  /** 请求解释器；按 [requested, "python3", "python"] 探测首个可用 */
  interpreter: string;
  cwd: string;
  code: string;
  timeoutMs: number;
  /** 换新进程（env 冻结语义的 reset：丢弃该键现进程） */
  reset?: boolean;
}

export interface KernelRegistryConfig {
  maxSessionKernels?: number;
  idleTimeoutMs?: number;
  /** reaper 开关（测试可关，dispose 必清） */
  enableReaper?: boolean;
}

/** 当前 in-flight cell 的 settle 通道（单 in-flight，角标挂 hang） */
interface CurrentCell {
  id: string;
  settled: boolean;
  settleFrame: (payload: RunnerCellPayload) => void;
  settleEof: (extra: string) => void;
}

/** 一个常驻解释器进程 + 串行化 cell 队列 + 输出归属缓冲 */
class SessionKernel {
  readonly key: string;
  readonly owner: string;
  readonly interpreter: string;
  readonly cwd: string;

  proc: ChildProcess | null = null;
  /** 并发首 cell 的 spawn 竞态防护（对齐沙箱会话缓存同型） */
  spawnPromise: Promise<void> | null = null;
  sentinel = "";
  tmpDir = "";
  lastUsedAt = Date.now();
  attached = 0;

  private stderrBuf = "";
  private rawBuf = "";
  private current: CurrentCell | null = null;
  /** 串行化排队链（同 kernel 的 cell 逐个执行） */
  private tail: Promise<unknown> = Promise.resolve();
  private spawnError: string | null = null;
  private resolvedInterpreter: string | null = null;
  private stopped = false;

  constructor(key: string, owner: string, interpreter: string, cwd: string) {
    this.key = key;
    this.owner = owner;
    this.interpreter = interpreter;
    this.cwd = cwd;
  }

  dead(): boolean {
    return this.proc !== null && (this.proc.exitCode !== null || this.proc.signalCode !== null);
  }

  pid(): number | null {
    return this.proc?.pid ?? null;
  }

  teardown(): void {
    if (this.stopped) return;
    this.stopped = true;
    const proc = this.proc;
    if (proc && !this.dead()) {
      // POSIX detached：kill 整个进程组（用户代码自 spawn 的子进程一并清除，
      // 同 Hermes _kill_process_group 语义，防树残留）；Windows 只杀直接进程。
      try {
        if (process.platform !== "win32" && proc.pid) {
          process.kill(-proc.pid, "SIGKILL");
        } else {
          proc.kill("SIGKILL");
        }
      } catch { /* 进程可能已退出 */ }
    }
    if (proc) {
      try { proc.stdin?.end(); } catch { /* ignore */ }
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
    }
    if (this.tmpDir) {
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
      this.tmpDir = "";
    }
  }

  /** 解释器 candidate 探测（spawnSync 版本探针，仅新 kernel 一次） */
  private resolveInterpreter(): string | null {
    if (this.resolvedInterpreter) return this.resolvedInterpreter;
    const candidates = Array.from(new Set([this.interpreter === "python" || this.interpreter === "python3" ? "python3" : this.interpreter, "python3", "python"]));
    for (const cmd of candidates) {
      try {
        const probe = spawnSync(cmd, ["-V"], { encoding: "utf-8", timeout: 10_000 });
        if (probe.status === 0) {
          this.resolvedInterpreter = cmd;
          return cmd;
        }
      } catch { /* 试下一个 candidate */ }
    }
    return null;
  }

  async ensureSpawned(): Promise<void> {
    if (this.proc || this.spawnPromise) return await (this.spawnPromise ?? Promise.resolve());
    this.spawnPromise = (async () => {
      if (!fs.existsSync(this.cwd)) {
        this.spawnError = `kernel cwd does not exist: ${this.cwd}`;
        return;
      }
      const resolved = this.resolveInterpreter();
      if (!resolved) {
        this.spawnError = `No Python interpreter found (tried: ${[this.interpreter, "python3", "python"].join(", ")})`;
        return;
      }
      this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), TMPDIR_PREFIX));
      this.sentinel = crypto.randomUUID();
      fs.writeFileSync(path.join(this.tmpDir, "kernel_runner.py"), PYTHON_KERNEL_RUNNER_SOURCE, "utf-8");

      const childEnv: Record<string, string | undefined> = {
        ...process.env,
        EVOCLAW_KERNEL_SENTINEL: this.sentinel,
        EVOCLAW_KERNEL_CAPTURE: String(RUNNER_CAPTURE_LIMIT),
        // 宿主死亡看门狗（仅 Linux）：runner 轮询 /proc/<this-pid>
        EVOCLAW_KERNEL_PARENT_PID: String(process.pid),
      };
      try {
        const stdio: Array<"pipe" | number> = ["pipe", "pipe", "pipe"];
        this.proc = spawn(resolved, [path.join(this.tmpDir, "kernel_runner.py")], {
          cwd: this.cwd,
          env: childEnv,
          stdio,
          detached: process.platform !== "win32",
          windowsHide: true,
        });
      } catch (err) {
        this.spawnError = err instanceof Error ? err.message : String(err);
        if (this.tmpDir) { fs.rmSync(this.tmpDir, { recursive: true, force: true }); }
        this.tmpDir = "";
        return;
      }
      this.attachListeners();
    })().finally(() => {
      this.spawnPromise = null;
    });
    return await this.spawnPromise;
  }

  private attachListeners(): void {
    const proc = this.proc!;
    let stdoutBuf = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf-8");
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        this.consumeStdoutLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      // stderr 归属当前 cell（cell 串行化），settle 时 drain
      if (this.stderrBuf.length < RUNNER_CAPTURE_LIMIT) {
        const room = RUNNER_CAPTURE_LIMIT - this.stderrBuf.length;
        this.stderrBuf += chunk.toString("utf-8").slice(0, room);
      }
    });
    proc.on("error", (err: Error) => {
      // ENOENT 等 spawn 失败：cell 进行中直接 settle；否则记为 spawnError
      if (this.current && !this.current.settled) {
        this.current.settleEof(`spawn error: ${err.message}`);
      } else {
        this.spawnError ??= err.message;
      }
    });
    proc.on("close", () => {
      if (this.current && !this.current.settled) {
        this.current.settleEof("kernel process exited before replying");
      }
      // 帧内联 stdout 再加溶解：无归属的不认领（同 Hermes 对无主输出的处理）
    });
  }

  private consumeStdoutLine(line: string): void {
    if (!line.startsWith(REPLY_PREFIX)) {
      if (this.rawBuf.length < RUNNER_CAPTURE_LIMIT) this.rawBuf += line + "\n";
      return;
    }
    let frame: { sentinel?: string; __evoclaw_kernel_result?: RunnerCellPayload } | null = null;
    try {
      const parsed = JSON.parse(line.slice(REPLY_PREFIX.length)) as { sentinel?: string; __evoclaw_kernel_result?: RunnerCellPayload };
      frame = parsed;
    } catch {
      this.rawBuf += line + "\n";
      return;
    }
    // sentinel 校验：非本 kernel 的帧按原始输出归属（伪造/串扰）
    if (frame?.sentinel !== this.sentinel || !frame?.__evoclaw_kernel_result) {
      this.rawBuf += line + "\n";
      return;
    }
    const current = this.current;
    if (current && !current.settled && frame!.__evoclaw_kernel_result!.id === current.id) {
      current.settleFrame(frame!.__evoclaw_kernel_result!);
    }
    // 乱序/重复帧：忽略（防伪造早停）
  }

  private drainRaw(): string {
    const raw = this.rawBuf;
    this.rawBuf = "";
    return raw;
  }

  private drainStderr(): string {
    const err = this.stderrBuf;
    this.stderrBuf = "";
    return err;
  }

  async runCell(code: string, timeoutMs: number, opts: { reused: boolean; stateReset: boolean }): Promise<KernelCellResult> {
    const start = Date.now();
    await this.ensureSpawned();
    if (this.spawnError) {
      return {
        status: "spawn-error", exitCode: -1,
        stdout: this.drainRaw(), stderr: this.drainStderr(),
        timedOut: false, durationMs: Date.now() - start,
        executionCount: 0, reused: opts.reused, stateReset: opts.stateReset,
        error: this.spawnError, interpreter: this.resolvedInterpreter ?? this.interpreter,
      };
    }
    // 串行化排队：tail 链保证单 in-flight
    const tail = this.tail;
    const run = tail.then(() => this.executeCellInner(code, Math.max(1000, timeoutMs), opts, start));
    this.tail = run.catch(() => {
      // 保险兜底（executeCellInner 自身不抛）：链不能断
      return { status: "kernel-eof" as const, exitCode: -1, stdout: "", stderr: "", timedOut: false, durationMs: Date.now() - start, executionCount: 0, reused: opts.reused, stateReset: opts.stateReset, error: "kernel cell runner crashed" };
    });
    return await run;
  }

  private executeCellInner(code: string, timeoutMs: number, opts: { reused: boolean; stateReset: boolean }, start: number): Promise<KernelCellResult> {
    return new Promise<KernelCellResult>((resolve) => {
      const proc = this.proc!;
      const id = crypto.randomUUID();
      const rawPrefix = this.drainRaw();
      let timer: NodeJS.Timeout | null = null;
      const cell: CurrentCell = { id, settled: false, settleFrame: () => {}, settleEof: () => {} };
      const finishFinal = (build: () => KernelCellResult): void => {
        if (cell.settled) return;
        cell.settled = true;
        if (timer) clearTimeout(timer);
        this.current = null;
        try { proc.stdin?.removeAllListeners("error"); } catch { /* ignore */ }
        resolve(build());
      };
      // 帧路径映射（payload → 归属拼接）
      cell.settleFrame = (payload: RunnerCellPayload) => {
        finishFinal(() => {
          const stderrText = this.drainStderr();
          const stdout = rawPrefix + payload.stdout + this.drainRaw();
          const base = {
            durationMs: Date.now() - start,
            executionCount: payload.execution_count,
            reused: opts.reused, stateReset: opts.stateReset,
            interpreter: this.resolvedInterpreter ?? this.interpreter,
          };
          if (payload.status === "ok") return { ...base, status: "success" as const, exitCode: 0, stdout, stderr: stderrText, timedOut: false };
          if (payload.status === "exit") return { ...base, status: "exit" as const, exitCode: -1, stdout, stderr: stderrText + (payload.traceback || ""), timedOut: false, error: payload.traceback || "kernel ended (SystemExit)" };
          return { ...base, status: "error" as const, exitCode: 1, stdout, stderr: stderrText + (payload.traceback || ""), traceback: payload.traceback || undefined, timedOut: false };
        });
      };
      cell.settleEof = (extra: string) => {
        finishFinal(() => ({
          status: "kernel-eof" as const, exitCode: proc.exitCode ?? -1,
          stdout: rawPrefix + this.drainRaw(),
          stderr: this.drainStderr() + (extra ? extra + "\n" : ""),
          timedOut: false, durationMs: Date.now() - start,
          executionCount: 0, reused: opts.reused, stateReset: opts.stateReset,
          error: extra || "kernel session ended unexpectedly",
          interpreter: this.resolvedInterpreter ?? this.interpreter,
        }));
      };
      timer = setTimeout(() => {
        // 卡死语义：宁可死，绝不挂住——kill 进程树、丢弃内核（状态丢失刻意）
        if (cell.settled) return;
        cell.settled = true;
        this.current = null;
        clearTimeout(timer!);
        this.teardown();
        resolve({
          status: "timeout" as const, exitCode: -1,
          stdout: rawPrefix + this.drainRaw(),
          stderr: this.drainStderr(),
          timedOut: true, durationMs: Date.now() - start,
          executionCount: 0, reused: opts.reused, stateReset: opts.stateReset,
          error: "cell timed out; the session kernel was killed and its state was lost. The next execute_code call starts a fresh kernel.",
          interpreter: this.resolvedInterpreter ?? this.interpreter,
        });
      }, timeoutMs);
      timer.unref?.();
      this.current = cell;
      proc.stdin?.on("error", () => {
        if (this.current === cell) cell.settleEof("stdin pipe broke; kernel exited");
      });
      try {
        proc.stdin?.write(JSON.stringify({ id, code }) + "\n");
      } catch {
        finishFinal(() => ({
          status: "spawn-error" as const, exitCode: -1, stdout: rawPrefix, stderr: this.drainStderr(),
          timedOut: false, durationMs: Date.now() - start,
          executionCount: 0, reused: opts.reused, stateReset: opts.stateReset,
          error: "failed to send cell request (kernel stdin closed)",
          interpreter: this.resolvedInterpreter ?? this.interpreter,
        }));
      }
    });
  }
}

/**
 * kernel 注册表 + LRU 池 + 空闲/残留回收（对应 Hermes KernelRegistry +
 * _acquire_kernel + _background_reaper）。
 *
 * Node 单线程模型下临界区无需锁：Map 增删与计数全部同步原子，
 * teardown（可能阻塞）放临界区外——与 Hermes "pop under the lock,
 * tear down outside it" 同构。
 */
export class CodeKernelRegistry {
  private kernels = new Map<string, SessionKernel>();
  readonly maxSessionKernels: number;
  readonly idleTimeoutMs: number;
  private reaperTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(config: KernelRegistryConfig = {}) {
    this.maxSessionKernels = Math.max(1, config.maxSessionKernels ?? DEFAULT_MAX_SESSION_KERNELS);
    this.idleTimeoutMs = Math.max(1000, config.idleTimeoutMs ?? DEFAULT_KERNEL_IDLE_TIMEOUT_MS);
    if (config.enableReaper !== false) this.startReaper();
  }

  private startReaper(): void {
    if (this.reaperTimer) return;
    const interval = Math.min(300_000, Math.max(30_000, this.idleTimeoutMs / 6));
    this.reaperTimer = setInterval(() => {
      try { this.sweepIdle(); this.sweepStaleDirs(); } catch { /* reaper 永不抛 */ }
    }, interval);
    this.reaperTimer.unref?.();
  }

  /** 空闲超时回收（对应 Hermes _pop_idle_expired + LRU cap 附着保护） */
  sweepIdle(now: number = Date.now()): void {
    for (const [key, kernel] of this.kernels) {
      if (kernel.attached === 0 && now - kernel.lastUsedAt > this.idleTimeoutMs) {
        this.kernels.delete(key);
        kernel.teardown();
      }
    }
    // LRU 上限：附着中不被驱逐
    const evictable = [...this.kernels.values()].filter((k) => k.attached === 0);
    if (evictable.length > this.maxSessionKernels) {
      evictable
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
        .slice(0, evictable.length - this.maxSessionKernels)
        .forEach((k) => {
          this.kernels.delete(k.key);
          k.teardown();
        });
    }
  }

  /** 清扫宿主死亡遗留的 staging 目录（>7 天；rmSync 不跟随符号链接） */
  sweepStaleDirs(now: number = Date.now()): number {
    let removed = 0;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(os.tmpdir());
    } catch {
      return 0;
    }
    for (const name of entries) {
      if (!name.startsWith(TMPDIR_PREFIX)) continue;
      const dir = path.join(os.tmpdir(), name);
      try {
        if (now - fs.statSync(dir).mtimeMs > STALE_DIR_AGE_MS) {
          fs.rmSync(dir, { recursive: true, force: true });
          removed++;
        }
      } catch { /* 忽略单目录失败，留给下轮 pass */ }
    }
    return removed;
  }

  /**
   * 取（或新建 + spawn）该键 kernel。reset / 旧进程死亡 → 换新。
   * attached>0 的死亡进程不在此 teardown（并发 cell 竞态）：由 executeCell
   * 收尾移除。
   */
  acquire(options: KernelExecuteOptions): { kernel: SessionKernel; reused: boolean; stateReset: boolean } {
    if (this.disposed) throw new Error("CodeKernelRegistry disposed");
    this.sweepIdle();
    const key = `${options.owner}|${options.interpreter}|${options.cwd}`;
    let kernel = this.kernels.get(key);
    let reused = false;
    let stateReset = false;
    if (kernel) {
      if (options.reset || kernel.dead()) {
        stateReset = true;
        this.kernels.delete(key);
        if (kernel.attached === 0) kernel.teardown();
        kernel = undefined;
      } else {
        reused = true;
      }
    }
    if (!kernel) {
      kernel = new SessionKernel(key, options.owner, options.interpreter, options.cwd);
      this.kernels.set(key, kernel);
    }
    kernel.lastUsedAt = Date.now();
    kernel.attached++;
    return { kernel, reused, stateReset };
  }

  release(kernel: SessionKernel): void {
    kernel.attached--;
    kernel.lastUsedAt = Date.now();
  }

  /**
   * 执行一个 cell（会话持久 kernel）。timeout / 意外 eof / exit 类结果会把
   * 该 kernel 从注册表移除（调用方可凭 kernelDiscarded 报告）。
   */
  async executeCell(options: KernelExecuteOptions): Promise<KernelCellResult> {
    const { kernel, reused, stateReset } = this.acquire(options);
    try {
      const result = await kernel.runCell(options.code, options.timeoutMs, { reused, stateReset });
      if (this.kernels.get(kernel.key) === kernel && result.status === "timeout") {
        this.kernels.delete(kernel.key);
        return { ...result, kernelDiscarded: true };
      }
      if (result.status === "exit" && this.kernels.get(kernel.key) === kernel) {
        // SystemExit = kernel 终点：同 Hermes cell exit → discard
        this.kernels.delete(kernel.key);
        return { ...result, kernelDiscarded: true };
      }
      if (result.status === "kernel-eof" && kernel.dead()) {
        this.kernels.delete(kernel.key);
      }
      return result;
    } finally {
      this.release(kernel);
    }
  }

  stats(): { count: number; capacity: number; alive: number } {
    let alive = 0;
    for (const k of this.kernels.values()) if (!k.dead()) alive++;
    return { count: this.kernels.size, capacity: this.maxSessionKernels, alive };
  }

  keys(): string[] {
    return [...this.kernels.keys()];
  }

  /** 某键当前进程 pid（测试用：验证 kill 清理） */
  pidOf(key: string): number | null {
    return this.kernels.get(key)?.pid() ?? null;
  }

  /** 关停：kill 指定 owner 或全部 kernel（/new / 会话关闭 / 进程退出边界） */
  shutdown(ownerFilter?: string): void {
    for (const [key, kernel] of this.kernels) {
      if (ownerFilter !== undefined && kernel.owner !== ownerFilter) continue;
      this.kernels.delete(key);
      kernel.teardown();
    }
  }

  shutdownAll(): void {
    this.shutdown();
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    this.reaperTimer = null;
    this.shutdownAll();
    this.disposed = true;
  }
}

/** 进程内默认注册表（服务注册用；测试创建独立实例） */
export const kernelRegistry = new CodeKernelRegistry();

/** 宿主 clean-exit 兜底：杀全部 kernel（崩溃场景靠子进程看门狗） */
process.on("exit", () => {
  try { kernelRegistry.shutdownAll(); } catch { /* exit 阶段尽力而为 */ }
});
