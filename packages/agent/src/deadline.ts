// EvoClaw 统一有界执行层（借鉴 hermes-agent deadline.py）
//
// hermes 的 deadline.py 是一个独立于事件循环计时器的 wall-clock 截止层：
//   - run_bounded_async / run_bounded_sync：任何后端（MCP/浏览器/aux/工具）
//     卡死时，整个 turn 不会无限期挂死
//   - clamp_timeout：巨大超时会溢出平台 time_t（macOS #83220）
//   - SuspectableBackend：超时后把后端标记为 suspect，复用前先健康检查
//   - 操作异常原样传播，只有超时被具象化为 DeadlineExpired
//
// EvoClaw 现状：只有 llm-caller 每个请求单独的 setTimeout abort，
// 没有共享截止层、没有 suspect-mark、没有卡死诊断。
// 这里移植核心语义（Node.js 用 AbortController + setTimeout；卡死诊断用
// grace-period 日志 + active-handles 概要）。

/** 平台安全超时上限（365 天，语义上的「无界」）。 */
export const MAX_SAFE_TIMEOUT_MS = 31_536_000_000;

/** 截止后若仍未结束，再给一段 grace 用于导出卡死诊断（hermes _LOOP_BLOCKED_DUMP_GRACE_S=5.0）。 */
const LOOP_BLOCKED_DUMP_GRACE_MS = 5_000;

/**
 * 有状态后端协议（hermes SuspectableBackend）。
 * 超时时标记为 suspect，复用前先健康检查。markSuspect 必须廉价、非阻塞、
 * 不得获取被守卫操作可能持有的锁。
 */
export interface SuspectableBackend {
  markSuspect(reason: string): void;
  ensureHealthy(): boolean;
}

/**
 * 本层自己的截止（不是 provider 的传输超时）。
 */
export class DeadlineExceeded extends Error {
  readonly _tag = "DeadlineExceeded";
  constructor(
    public readonly label: string,
    public readonly timeoutMs: number,
  ) {
    super(`deadline exceeded after ${timeoutMs}ms: ${label}`);
    this.name = "DeadlineExceeded";
  }
}

/**
 * 规范化超时：null / 非正数 / NaN → null（无界）；否则夹到安全上限。
 * Infinity 视为有效值，夹到 MAX_SAFE_TIMEOUT_MS（对齐 hermes clamp_timeout：
 * hermes 只把 NaN 判为无界，Infinity 会被 min(value, MAX_SAFE_TIMEOUT_S) 夹住）。
 */
export function clampTimeout(timeoutMs: number | null | undefined): number | null {
  if (timeoutMs == null) return null;
  const value = Number(timeoutMs);
  if (value !== value) return null; // NaN
  if (value <= 0) return null; // 非正数
  if (!Number.isFinite(value)) return MAX_SAFE_TIMEOUT_MS; // Infinity → 夹到上限
  return Math.min(value, MAX_SAFE_TIMEOUT_MS);
}

/** 最佳努力的 markSuspect；后端不实现该协议时静默跳过。 */
function markBackendSuspect(backend: SuspectableBackend | null | undefined, label: string, timeoutMs: number): void {
  if (!backend) return;
  try {
    const mark = (backend as { markSuspect?: (reason: string) => void }).markSuspect;
    if (typeof mark === "function") {
      mark(`${label} timed out after ${timeoutMs}ms`);
    }
  } catch {
    // markSuspect 失败不得影响主流程
  }
}

/** 最佳努力的 onAbandon 回调；失败只记日志。 */
async function runAbandonCleanup(fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // abandon 清理失败不得影响主流程
  }
}

/** 导出仍在活跃的异步句柄概要，供运维定位卡死的 socket / timer / 异步资源。 */
function dumpActiveHandles(): void {
  try {
    const getHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
    if (typeof getHandles !== "function") return;
    const handles = getHandles();
    const summary = handles
      .map((h) => (h as { constructor?: { name?: string } })?.constructor?.name)
      .filter((name): name is string => typeof name === "string")
      .reduce((acc, name) => {
        acc[name] = (acc[name] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>);
    process.stderr.write(`[deadline] active handles: ${JSON.stringify(summary)}\n`);
  } catch {
    // 诊断是 best-effort
  }
}

/**
 * 用 wall-clock 截止包裹一个异步操作。
 *
 * 语义（对齐 hermes run_bounded_async）：
 *   - 操作异常（含调用方取消）原样传播，只有**超时**被具象化为 DeadlineExceeded
 *   - 超时时放弃（abandon）被守卫的操作——不 await，避免 shielded scope 撑死
 *   - 超时后 markSuspect + onAbandon 各自独立执行
 *   - timeoutMs 为 null / 非正数 / NaN 时表示无界，直接调用 fn
 *
 * 实现：用 Promise.race 在 fn 与 deadline 之间竞赛——deadline 先触发时
 * fn 的 promise 被 abandon（不 await），与 hermes `asyncio.wait(FIRST_COMPLETED)`
 * + `_abandon(task)` 的语义一致。这样即使 fn 忽略 AbortSignal 也不会卡死。
 */
export async function withDeadline<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | null | undefined,
  options: {
    label?: string;
    onAbandon?: () => void | Promise<void>;
    backend?: SuspectableBackend | null;
    dumpOnBlockedLoop?: boolean;
  } = {},
): Promise<T> {
  const timeout = clampTimeout(timeoutMs);
  const label = options.label ?? "operation";
  if (timeout === null) {
    return fn(new AbortController().signal);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  if (options.dumpOnBlockedLoop !== false) {
    graceTimer = setTimeout(() => {
      // 截止已过 grace 仍未结束 → 大概率是被守卫作用域撑住的卡死
      process.stderr.write(
        `[deadline] ${label} still running ${LOOP_BLOCKED_DUMP_GRACE_MS}s after deadline — likely wedged; dumping diagnostics\n`,
      );
      dumpActiveHandles();
    }, timeout + LOOP_BLOCKED_DUMP_GRACE_MS);
  }

  let deadlineExceeded = false;
  const deadlinePromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => {
      deadlineExceeded = true;
      reject(new DeadlineExceeded(label, timeout));
    });
  });

  try {
    return await Promise.race([fn(controller.signal), deadlinePromise]);
  } catch (err) {
    if (deadlineExceeded) {
      // 超时：abandon 被守卫的操作，标记 suspect，执行 onAbandon
      markBackendSuspect(options.backend, label, timeout);
      if (options.onAbandon) {
        void runAbandonCleanup(options.onAbandon).catch(() => {});
      }
      throw err;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
  }
}

/** 有界执行的统一入口（异步 flavor），供工具执行 / aux 调用等场景使用。 */
export async function boundedAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | null | undefined,
  options: {
    label?: string;
    onAbandon?: () => void | Promise<void>;
    backend?: SuspectableBackend | null;
  } = {},
): Promise<T> {
  return withDeadline(fn, timeoutMs, options);
}

// ── 工具级 suspect 追踪（hermes SuspectableBackend 的 TS 移植） ────────────────

/**
 * 按工具名追踪 suspect 状态：某工具超时后被标记为 suspect，
 * 重试前先 ensureHealthy()——避免一个卡死的工具被无脑重试直到预算耗尽。
 * 对应 hermes 的 SuspectableBackend 协议 + mark_suspect / ensure_healthy。
 */
export class ToolSuspectTracker implements SuspectableBackend {
  private readonly suspect = new Map<string, { reason: string; at: number }>();
  /** suspect 状态 TTL（ms），过期自动恢复（对齐 hermes 的冷却期语义）。 */
  private readonly ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  markSuspect(reason: string): void {
    // 用 `${reason}:${Date.now()}` 作为 value，方便按 reason 分类；
    // key 只用工具名（由调用方拼接），这里只负责存储。
    this.suspect.set(reason, { reason, at: Date.now() });
  }

  ensureHealthy(): boolean {
    // 清理过期记录
    const now = Date.now();
    for (const [key, entry] of this.suspect) {
      if (now - entry.at > this.ttlMs) this.suspect.delete(key);
    }
    return this.suspect.size === 0;
  }

  /** 指定工具名是否被标记为 suspect */
  isSuspect(toolName: string): boolean {
    const entry = this.suspect.get(toolName);
    if (!entry) return false;
    if (Date.now() - entry.at > this.ttlMs) {
      this.suspect.delete(toolName);
      return false;
    }
    return true;
  }

  /** 标记指定工具为 suspect */
  markToolSuspect(toolName: string, reason: string): void {
    this.suspect.set(toolName, { reason, at: Date.now() });
  }

  /** 清空指定工具的 suspect 状态（重试成功后调用） */
  clearToolSuspect(toolName: string): void {
    this.suspect.delete(toolName);
  }

  /** 清空全部 */
  clearAll(): void {
    this.suspect.clear();
  }
}

/** 进程级单例（对齐 getProviderSkipList 的单例模式）。 */
let toolSuspectTrackerSingleton: ToolSuspectTracker | null = null;

export function getToolSuspectTracker(): ToolSuspectTracker {
  if (!toolSuspectTrackerSingleton) {
    toolSuspectTrackerSingleton = new ToolSuspectTracker();
  }
  return toolSuspectTrackerSingleton;
}