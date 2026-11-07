/**
 * Process-registry — 后台进程注册表 + watch pattern 限速 + 断路器 + PID 复用保护。
 *
 * 对标 Hermes `tools/process_registry.py`：
 *   追踪通过 terminal(background=true) 启动的后台进程，提供：
 *   - 输出缓冲（200KB 滚动窗口）
 *   - 状态轮询与日志检索
 *   - 阻塞等待（带中断支持）
 *   - 进程杀死（进程树终止 + 幸存者验证，Hermes ProcessTerminationMixin）
 *   - 崩溃恢复（JSON checkpoint）
 *   - 会话级 watch pattern 限速 + 全局断路器
 *   - PID 复用保护（host_start_time 内核 tick）
 *   - wait policy 静默等待策略（连续静默 2 轮后转让完成通知，Hermes _PROMOTE_AFTER）
 *
 * 限速策略：
 *   - per-session: 至少 15s 间隔一次 watch 通知，3 次连续 strike 后降级为 notify_on_complete
 *   - 全局: 10s 窗口内最多 15 次命中，超限后 30s 冷却
 */

import { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { killProcessTree } from "./process-tree-killer";
import type { KillOptions } from "./process-tree-killer";
import { WaitPolicyTracker } from "./process-wait-policy";

// ── 常量 ────────────────────────────────────────────────────

const MAX_OUTPUT_CHARS = 200_000; // 200KB 滚动输出缓冲
const FINISHED_TTL_SECONDS = 1800; // 完成进程保留 30 分钟
const MAX_PROCESSES = 64; // 最大并发追踪进程（LRU 剪枝）

const WATCH_MIN_INTERVAL_SECONDS = 15; // per-session watch 通知最小间隔
const WATCH_STRIKE_LIMIT = 3; // 连续 strike 上限 → 禁用 watch

const WATCH_GLOBAL_MAX_PER_WINDOW = 15; // 全局 10s 窗口最大命中数
const WATCH_GLOBAL_WINDOW_SECONDS = 10;
const WATCH_GLOBAL_COOLDOWN_SECONDS = 30;

/** 静默晋升停轮注（对齐 Hermes process_registry._STOP_NOTE）：
 *  通知模型不要继续紧密轮询此静默进程——输出无变化时完成通知已接管。 */
const STOP_NOTE = "该进程连续两轮轮询输出无变化，已转为完成后主动通知模式；不再需要紧密轮询。";

/** wait 阻塞等待的事件门控步长（对齐 Hermes completion_event.wait(timeout≤1.0) 的 1s 节奏） */
const WAIT_TICK_MS = 1000;

// ── 类型定义 ────────────────────────────────────────────────

export type CompletionReason = "exited" | "killed" | "lost" | "failed_start" | "already_exited";
export type TerminationSource = "process.kill" | "kill_all" | "backend_lost" | "failed_start";
export type PidScope = "host" | "sandbox";

export interface ProcessSession {
  /** 唯一会话 ID（"proc_xxxxxxxxxxxx"） */
  id: string;
  /** 原始命令字符串 */
  command: string;
  /** 任务/沙箱隔离 key */
  taskId: string;
  /** 网关会话 key（用于 reset 保护） */
  sessionKey: string;
  /** OS 进程 ID */
  pid: number | null;
  /** ChildProcess 句柄（仅本地） */
  process: ChildProcess | null;
  /** 工作目录 */
  cwd: string | null;
  /** 启动时间（time.time() 等价） */
  startedAt: number;
  /** 完成时间戳（markCompleted 时设置；null 表示仍在运行）。
   *  pruneExpired 用此字段而非 startedAt 算 TTL，避免长任务一完成就被清理。 */
  finishedAt: number | null;
  /** 内核启动 ticks — PID 复用保护（/proc/<pid>/stat f22） */
  hostStartTime: number | null;
  /** 是否已完成 */
  exited: boolean;
  /** 退出码（运行中为 null） */
  exitCode: number | null;
  /** 完成原因 */
  completionReason: CompletionReason;
  /** 终止来源 */
  terminationSource: TerminationSource | "";
  /** 滚动输出缓冲（最后 MAX_OUTPUT_CHARS 字符） */
  outputBuffer: string;
  /** 累计输出字符数（spawn 时从 0 单调递增）— wait policy 静默判定依据
   * （对齐 Hermes ProcessSession.total_output_chars） */
  totalOutputChars: number;
  /** wait policy 晋升停轮注（对齐 Hermes _STOP_NOTE）：告知模型不再需要紧密轮询 */
  stopNote: string;
  /** 最大输出字符数 */
  maxOutputChars: number;
  /** 是否从崩溃恢复（无管道） */
  detached: boolean;
  /** PID 范围：host / sandbox */
  pidScope: PidScope;
  /** watcher 平台 */
  watcherPlatform: string;
  /** watcher chat id */
  watcherChatId: string;
  /** watcher user id */
  watcherUserId: string;
  /** watcher thread id */
  watcherThreadId: string;
  /** watcher 消息 id（reply anchor） */
  watcherMessageId: string;
  /** watcher 轮询间隔（0 = 无 watcher） */
  watcherInterval: number;
  /** 进程退出时排队通知 agent */
  notifyOnComplete: boolean;
  /** watch 模式列表 — 输出匹配任一模式时触发通知 */
  watchPatterns: string[];
}

/** watch 通知事件 */
export interface WatchEvent {
  sessionId: string;
  type: "watch_match" | "completion";
  match?: string;
  output?: string;
  exitCode?: number;
  timestamp: number;
}

// ── 内部状态（per-session 限速） ───────────────────────────

interface WatchRateLimitState {
  lastEmitAt: number;
  cooldownUntil: number;
  strikeCandidate: boolean;
  consecutiveStrikes: number;
  hits: number;
  suppressed: number;
  disabled: boolean;
}

// ── ProcessRegistry 类 ─────────────────────────────────────

/**
 * 后台进程注册表（单例）。
 *
 * 线程安全（通过方法同步保证）。被以下方访问：
 *   - Executor 线程（terminal_tool, process tool handlers）
 *   - 网关事件循环（watcher tasks, session reset checks）
 *   - 清理线程（沙箱 reaping 协调）
 */
export class ProcessRegistry {
  private running: Map<string, ProcessSession> = new Map();
  private finished: Map<string, ProcessSession> = new Map();
  private watchState: Map<string, WatchRateLimitState> = new Map();
  private completionQueue: WatchEvent[] = [];
  private completionConsumed: Set<string> = new Set();
  private pollObserved: Set<string> = new Set();
  /** wait policy 静默计数器（对齐 Hermes process_registry_wait_policy） */
  private waitPolicy = new WaitPolicyTracker();

  // 全局 watch 断路器
  private globalWindowStart = 0;
  private globalWindowHits = 0;
  private globalTrippedUntil = 0;
  private globalSuppressedDuringTrip = 0;

  private static instance: ProcessRegistry | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;

  /** 定时清理过期会话（每 5 分钟）。unref 避免阻止进程退出。 */
  constructor() {
    this.pruneTimer = setInterval(() => this.pruneExpired(), 5 * 60 * 1000);
    this.pruneTimer.unref?.();
  }

  /** 单例访问 */
  static getInstance(): ProcessRegistry {
    if (!ProcessRegistry.instance) {
      ProcessRegistry.instance = new ProcessRegistry();
    }
    return ProcessRegistry.instance;
  }

  /** 停止定时清理（用于关闭/测试） */
  dispose(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  /**
   * 注册一个后台进程。
   *
   * @param opts 进程信息
   */
  register(opts: {
    command: string;
    taskId?: string;
    sessionKey?: string;
    pid?: number | null;
    process?: ChildProcess | null;
    cwd?: string | null;
    hostStartTime?: number | null;
    watchPatterns?: string[];
    notifyOnComplete?: boolean;
    pidScope?: PidScope;
  }): ProcessSession {
    const id = `proc_${randomUUID()}`;
    const session: ProcessSession = {
      id,
      command: opts.command,
      taskId: opts.taskId ?? "",
      sessionKey: opts.sessionKey ?? "",
      pid: opts.pid ?? null,
      process: opts.process ?? null,
      cwd: opts.cwd ?? null,
      startedAt: Date.now(),
      finishedAt: null,
      hostStartTime: opts.hostStartTime ?? null,
      exited: false,
      exitCode: null,
      completionReason: "exited",
      terminationSource: "",
      outputBuffer: "",
      totalOutputChars: 0,
      stopNote: "",
      maxOutputChars: MAX_OUTPUT_CHARS,
      detached: false,
      pidScope: opts.pidScope ?? "host",
      watcherPlatform: "",
      watcherChatId: "",
      watcherUserId: "",
      watcherThreadId: "",
      watcherMessageId: "",
      watcherInterval: 0,
      notifyOnComplete: opts.notifyOnComplete ?? false,
      watchPatterns: opts.watchPatterns ?? [],
    };

    // LRU 剪枝
    if (this.running.size >= MAX_PROCESSES) {
      this.pruneOldestRunning();
    }

    this.running.set(id, session);
    if (session.watchPatterns.length > 0) {
      this.watchState.set(id, {
        lastEmitAt: 0,
        cooldownUntil: 0,
        strikeCandidate: false,
        consecutiveStrikes: 0,
        hits: 0,
        suppressed: 0,
        disabled: false,
      });
    }

    return session;
  }

  /**
   * 追加输出到会话的滚动缓冲。
   */
  appendOutput(sessionId: string, chunk: string): void {
    const session = this.running.get(sessionId);
    if (!session) return;
    const trimmedChunk = this.stripShellNoise(chunk);
    // wait policy 计数器：累计吞入字符数（log buffer 滚动丢弃早期字符不影响，
    // 静默判定基于"自上次轮询起是否有新输出"）
    session.totalOutputChars += trimmedChunk.length;
    session.outputBuffer = (session.outputBuffer + trimmedChunk).slice(-session.maxOutputChars);

    // 检查 watch patterns
    if (session.watchPatterns.length > 0 && !session.exited) {
      this.checkWatchPatterns(sessionId, trimmedChunk);
    }
  }

  /** 剥离 shell 启动噪声 */
  private stripShellNoise(text: string): string {
    const noiseSubstrings = [
      "bash: cannot set terminal process group",
      "bash: no job control in this shell",
      "no job control in this shell",
      "cannot set terminal process group",
      "tcsetattr: Inappropriate ioctl for device",
    ];
    let result = text;
    for (const noise of noiseSubstrings) {
      while (result.includes(noise)) {
        const idx = result.indexOf(noise);
        const lineEnd = result.indexOf("\n", idx);
        if (lineEnd < 0) {
          result = result.slice(0, idx);
        } else {
          result = result.slice(0, idx) + result.slice(lineEnd + 1);
        }
      }
    }
    return result;
  }

  /**
   * 标记会话为已完成。
   * wait policy：退出即 forget（静默计数失效）。
   */
  markCompleted(sessionId: string, exitCode: number | null, reason: CompletionReason = "exited", source: TerminationSource | "" = ""): void {
    const session = this.running.get(sessionId);
    if (!session) return;
    session.exited = true;
    session.exitCode = exitCode;
    session.completionReason = reason;
    session.terminationSource = source;
    session.finishedAt = Date.now();
    this.waitPolicy.forget(sessionId);

    // 移到 finished 表
    this.running.delete(sessionId);
    this.finished.set(sessionId, session);

    // 排队完成通知
    if (session.notifyOnComplete && !this.completionConsumed.has(sessionId)) {
      this.completionQueue.push({
        sessionId,
        type: "completion",
        exitCode: exitCode ?? undefined,
        output: session.outputBuffer.slice(-2000),
        timestamp: Date.now(),
      });
    }
  }

  /**
   * 轮询会话状态（只读，不消费通知）。
   * wait policy：poll 是观察行为 → 静默计数推进（连续 2 轮无输出晋升完成通知接管）。
   */
  poll(sessionId: string): ProcessSession | null {
    const session = this.running.get(sessionId) ?? this.finished.get(sessionId);
    if (session) {
      this.pollObserved.add(sessionId);
      this.waitPolicy.sawObserver(sessionId);
      if (!session.exited) {
        this.observeWaiting(sessionId, session, "poll");
      }
    }
    return session ?? null;
  }

  /**
   * 读取会话日志。
   */
  readLog(sessionId: string, tailBytes?: number): string {
    const session = this.running.get(sessionId) ?? this.finished.get(sessionId);
    if (!session) return "";
    const buf = session.outputBuffer;
    if (tailBytes && tailBytes > 0 && buf.length > tailBytes) {
      return buf.slice(-tailBytes);
    }
    return buf;
  }

  /**
   * 杀死进程。
   * 对已退出的进程 kill() 会抛 ESRCH；捕获后仍标记完成，避免僵尸会话驻留。
   *
   * 挂接进程树终止 + 幸存者验证（对齐 Hermes ProcessTerminationMixin fail-closed）：
   *   SIGTERM 后 settle 复查有幸存者 → 不写 killed 收据、会话保留在 running，返回 false。
   */
  async kill(sessionId: string, killOpts?: KillOptions): Promise<boolean> {
    const session = this.running.get(sessionId);
    if (!session || !session.process) return false;
    let alreadyExited = false;
    try {
      session.process.kill("SIGTERM");
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      // ESRCH (No such process) / ENOENT (Windows 等价) → 进程已退出
      if (code === "ESRCH" || code === "ENOENT") {
        alreadyExited = true;
      } else {
        return false;
      }
    }

    // 进程树终止 + 幸存者验证（grace 上限 2s；无真实 pid 时跳过复查）。
    // killOpts 透传（测试注入 isAlive stub / 缩短 settle）。
    const pid = session.process.pid ?? session.pid;
    if (pid) {
      const tree = await killProcessTree(pid, {
        gracePeriodMs: killOpts?.gracePeriodMs ?? 2000,
        killSettleMs: killOpts?.killSettleMs,
        isAlive: killOpts?.isAlive,
      });
      if ((tree.survivors?.length ?? 0) > 0) {
        // fail-closed：无法确认整棵树终止 → 不写 killed 收据、会话保留在 running
        console.warn("[process-registry] kill 幸存者验证失败，会话保留在 running", {
          sessionId,
          pid,
          survivors: tree.survivors,
        });
        return false;
      }
    }

    this.markCompleted(
      sessionId,
      null,
      alreadyExited ? "already_exited" : "killed",
      "process.kill",
    );
    return true;
  }

  /**
   * 杀死所有运行中的进程（用于 session reset）。
   */
  async killAll(sessionKey?: string): Promise<number> {
    // 先快照待杀死的 id，避免迭代 Map 时 kill()->markCompleted()->running.delete
    // 修改 Map 导致迭代器跳过条目。
    const ids = Array.from(this.running.entries())
      .filter(([, session]) => !sessionKey || session.sessionKey === sessionKey)
      .map(([id]) => id);
    let killed = 0;
    for (const id of ids) {
      if (await this.kill(id)) killed++;
    }
    return killed;
  }

  /**
   * 阻塞等待会话结束或超时。
   *
   * 对齐 Hermes wait policy（process_registry_wait_policy.py）：
   *   - 节奏：≤1s 事件门控轮询（sleep 而非空转；WAIT_TICK_MS 对齐 Hermes 1.0s 上限）；
   *   - 超时歧义：等待期间输出无变化 → 该次等待计一次静默轮；连续 2 次静默后晋升
   *     ——notify_on_complete 接管 + stop note 告知模型不再紧密轮询（Hermes _STOP_NOTE 语义）；
   *   - 进程已退出 → 计数器 forget，返回快照（调用方可选 drainNotifications）。
   */
  async wait(sessionId: string, timeoutMs: number = 1000): Promise<ProcessSession | null> {
    const existing = this.running.get(sessionId) ?? this.finished.get(sessionId);
    if (!existing) return null;
    this.waitPolicy.sawObserver(sessionId);

    // 事件门控节奏轮询（Hermes completion_event.wait(timeout≤1.0) 语义）
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(WAIT_TICK_MS, remaining));
      if (existing.exited) break; // 同一对象引用：markCompleted 置位 exited 即可提前退出等待
    }

    const session = this.running.get(sessionId) ?? this.finished.get(sessionId);
    if (!session) return null;
    if (session.exited) {
      this.waitPolicy.forget(sessionId); // 退出 → 计数失效
      return session;
    }
    // 本次 wait 的静默观察（超时仍在运行）→ 静默计数推进 / 晋升
    const observed = this.waitPolicy.observeAction(sessionId, "wait", session.totalOutputChars, true);
    if (observed.promoted) {
      session.notifyOnComplete = true;
      session.stopNote = STOP_NOTE;
    }
    return session;
  }

  /**
   * 会话是否已被 wait policy 晋升（测试/诊断用）。
   */
  isWaitPromoted(sessionId: string): boolean {
    return this.waitPolicy.isPromoted(sessionId);
  }

  /**
   * 读取会话静默晋升 stop note（测试/诊断用）。
   */
  getStopNote(sessionId: string): string {
    const s = this.running.get(sessionId) ?? this.finished.get(sessionId);
    return s?.stopNote ?? "";
  }

  // ── wait policy 观察辅助 ──────────────────────────────────

  /**
   * 一次 wait/poll 观察 → 静默计数推进；晋升时执行副作用
   * （notify_on_complete 接管 + stop note，Hermes _STOP_NOTE 语义）。
   */
  private observeWaiting(sessionId: string, session: ProcessSession, action: "wait" | "poll"): void {
    const observed = this.waitPolicy.observeAction(sessionId, action, session.totalOutputChars, !session.exited);
    if (observed.promoted) {
      session.notifyOnComplete = true;
      session.stopNote = STOP_NOTE;
    }
  }

  /** 等待用 sleep（unref 不阻止进程退出——wait() 自身驱动等待不受其影响） */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, Math.max(1, ms));
      t.unref?.();
    });
  }

  /**
   * 排空通知队列。
   */
  drainNotifications(): WatchEvent[] {
    const events = [...this.completionQueue];
    this.completionQueue = [];
    return events;
  }

  /**
   * 标记通知已被消费（agent 通过 wait/log 已获取）。
   */
  markConsumed(sessionId: string): void {
    this.completionConsumed.add(sessionId);
  }

  // ── watch pattern 限速 ───────────────────────────────────

  /**
   * 检查输出是否匹配 watch patterns，命中时排队通知（受限于限速）。
   */
  private checkWatchPatterns(sessionId: string, chunk: string): void {
    const session = this.running.get(sessionId);
    if (!session || session.watchPatterns.length === 0) return;

    const state = this.watchState.get(sessionId);
    if (!state || state.disabled) return;

    // 全局断路器
    const now = Date.now();
    if (now < this.globalTrippedUntil) {
      this.globalSuppressedDuringTrip++;
      state.suppressed++;
      return;
    }

    // 检查是否在 cooldown 内
    if (now < state.cooldownUntil) {
      if (state.strikeCandidate) {
        // 已经是 candidate 的窗口内又命中 → strike
      } else {
        state.strikeCandidate = true;
        state.consecutiveStrikes++;
        state.suppressed++;

        if (state.consecutiveStrikes >= WATCH_STRIKE_LIMIT) {
          state.disabled = true;
          // 降级为 notify_on_complete
          session.notifyOnComplete = true;
        }
      }
      return;
    }

    // cooldown 已过期：重置 strike 状态（与 Hermes _check_watch_patterns 一致，
    // 健康窗口过后清零 consecutiveStrikes，避免偶发命中累计导致永久降级）
    // 仅当上一窗口未产生 strike_candidate（即无 match）时重置 consecutiveStrikes，
    // 保持 strike 序列的连续性语义。
    if (!state.strikeCandidate) {
      state.consecutiveStrikes = 0;
    }
    state.strikeCandidate = false;

    // 实际匹配检测（逐行 substring，与 Hermes _check_watch_patterns 一致；
    // 避免 regex 元字符误匹配 + 防 ReDoS）
    let matchedPattern: string | null = null;
    const lines = chunk.split("\n");
    outer: for (const line of lines) {
      for (const pattern of session.watchPatterns) {
        if (line.includes(pattern)) {
          matchedPattern = pattern;
          break outer;
        }
      }
    }
    if (!matchedPattern) return;

    // 全局窗口检查
    if (now - this.globalWindowStart > WATCH_GLOBAL_WINDOW_SECONDS * 1000) {
      this.globalWindowStart = now;
      this.globalWindowHits = 0;
    }
    this.globalWindowHits++;
    if (this.globalWindowHits > WATCH_GLOBAL_MAX_PER_WINDOW) {
      this.globalTrippedUntil = now + WATCH_GLOBAL_COOLDOWN_SECONDS * 1000;
      this.globalSuppressedDuringTrip = 0;
      state.suppressed++;
      return;
    }

    // 通过限速 → 排队通知
    state.lastEmitAt = now;
    state.cooldownUntil = now + WATCH_MIN_INTERVAL_SECONDS * 1000;
    state.strikeCandidate = false; // 重置 strike candidate
    state.consecutiveStrikes = 0; // 成功 emit 重置连续 strike
    state.hits++;

    this.completionQueue.push({
      sessionId,
      type: "watch_match",
      match: matchedPattern,
      output: chunk.slice(-500),
      timestamp: now,
    });
  }

  /**
   * 获取 watch 限速统计。
   */
  getWatchStats(sessionId: string): {
    hits: number;
    suppressed: number;
    disabled: boolean;
    consecutiveStrikes: number;
  } | null {
    const state = this.watchState.get(sessionId);
    if (!state) return null;
    return {
      hits: state.hits,
      suppressed: state.suppressed,
      disabled: state.disabled,
      consecutiveStrikes: state.consecutiveStrikes,
    };
  }

  // ── 清理 ─────────────────────────────────────────────────

  /**
   * 清理过期的已完成会话（超过 FINISHED_TTL_SECONDS）。
   * 用 finishedAt 而非 startedAt 算 age：长任务一完成就立即清理会丢失日志读取窗口。
   */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [id, session] of this.finished.entries()) {
      // 用 finishedAt（若存在）作为 TTL 起点；否则回退到 startedAt
      const baseTime = session.finishedAt ?? session.startedAt;
      const ageSeconds = (now - baseTime) / 1000;
      if (ageSeconds > FINISHED_TTL_SECONDS) {
        this.finished.delete(id);
        this.watchState.delete(id);
        this.completionConsumed.delete(id);
        this.pollObserved.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * LRU 剪枝最旧的运行中会话。
   * kill() 为异步（树终止 + 幸存者验证）：fire-and-forget；markCompleted 成功时
   * 会话已移入 finished表；验证失败/无句柄时在此移除以维持 MAX_PROCESSES 上限。
   */
  private pruneOldestRunning(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, session] of this.running.entries()) {
      if (session.startedAt < oldestTime) {
        oldestTime = session.startedAt;
        oldestId = id;
      }
    }
    if (oldestId) {
      const session = this.running.get(oldestId);
      if (session) {
        void this.kill(oldestId).then((ok) => {
          if (!ok) this.running.delete(oldestId);
        });
      }
    }
  }

  /**
   * 列出所有运行中会话。
   */
  listRunning(): ProcessSession[] {
    return Array.from(this.running.values());
  }

  /**
   * 列出所有已完成会话。
   */
  listFinished(): ProcessSession[] {
    return Array.from(this.finished.values());
  }

  /**
   * PID 复用保护：检查 PID 是否仍指向同一进程。
   *
   * 通过比较 hostStartTime（内核启动 ticks）判断。
   * 若 hostStartTime 不同，说明 PID 已被复用，原进程已死。
   */
  isPidReused(sessionId: string, currentHostStartTime: number): boolean {
    const session = this.running.get(sessionId) ?? this.finished.get(sessionId);
    if (!session || session.hostStartTime === null) return false;
    return session.hostStartTime !== currentHostStartTime;
  }

  // ── 崩溃恢复（checkpoint） ───────────────────────────────

  /**
   * 持久化 checkpoint 到文件（用于崩溃恢复）。
   *
   * 注意：调用方需使用 atomicWriteFile 写入（项目硬约束）。
   * 本方法返回 JSON 字符串，由调用方负责原子写入。
   */
  serializeCheckpoint(): string {
    const sessions = [...this.running.values(), ...this.finished.values()].map((s) => ({
      id: s.id,
      command: s.command,
      taskId: s.taskId,
      sessionKey: s.sessionKey,
      pid: s.pid,
      cwd: s.cwd,
      startedAt: s.startedAt,
      hostStartTime: s.hostStartTime,
      exited: s.exited,
      exitCode: s.exitCode,
      completionReason: s.completionReason,
      detached: true, // 恢复后无管道
      pidScope: s.pidScope,
      totalOutputChars: s.totalOutputChars,
    }));
    return JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      sessions,
    }, null, 2);
  }

  /**
   * 从 checkpoint 恢复。
   */
  restoreFromCheckpoint(json: string): number {
    try {
      const data = JSON.parse(json) as {
        sessions: Array<Partial<ProcessSession> & { id: string }>;
      };
      if (!data.sessions || !Array.isArray(data.sessions)) return 0;

      let restored = 0;
      for (const s of data.sessions) {
        if (!s.id || !s.command) continue;
        const session: ProcessSession = {
          id: s.id,
          command: s.command,
          taskId: s.taskId ?? "",
          sessionKey: s.sessionKey ?? "",
          pid: s.pid ?? null,
          process: null,
          cwd: s.cwd ?? null,
          startedAt: s.startedAt ?? Date.now(),
          finishedAt: s.finishedAt ?? null,
          hostStartTime: s.hostStartTime ?? null,
          exited: s.exited ?? false,
          exitCode: s.exitCode ?? null,
          completionReason: s.completionReason ?? "exited",
          terminationSource: "",
          outputBuffer: "",
          totalOutputChars: s.totalOutputChars ?? 0,
          stopNote: "",
          maxOutputChars: MAX_OUTPUT_CHARS,
          detached: true,
          pidScope: s.pidScope ?? "host",
          watcherPlatform: "",
          watcherChatId: "",
          watcherUserId: "",
          watcherThreadId: "",
          watcherMessageId: "",
          watcherInterval: 0,
          notifyOnComplete: false,
          watchPatterns: [],
        };

        if (session.exited) {
          this.finished.set(session.id, session);
        } else {
          // 恢复的运行中进程已无管道，标记为 detached
          this.running.set(session.id, session);
        }
        restored++;
      }
      return restored;
    } catch {
      return 0;
    }
  }
}

/** 单例便捷访问 */
export const processRegistry = ProcessRegistry.getInstance();

/**
 * 格式化运行时间。
 */
export function formatUptimeShort(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  if (mins < 60) {
    if (secs === 0) return `${mins}m`;
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(mins / 60);
  const minsRem = mins % 60;
  if (minsRem === 0) return `${hours}h`;
  return `${hours}h ${minsRem}m`;
}
