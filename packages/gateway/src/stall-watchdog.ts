/**
 * Armable stall watchdog — 可武装的传输空闲看门狗。
 *
 * 对照 openclaw-main 的 src/channels/transport/stall-watchdog.ts。
 *
 * 职责：
 *  - 监控长期运行的渠道传输（WebSocket/SSE/长轮询）是否进入静默卡死状态
 *  - 可武装（arm）/ 触摸（touch）/ 解除（disarm）/ 停止（stop）
 *  - 通过 setInterval 周期检查 lastActivityAt 与当前时间差
 *  - 超时后仅触发一次 onTimeout 回调，自动 disarm 防止二次触发
 *  - 支持 AbortSignal 联动（外部信号可立即停止 watchdog）
 *  - 计时器 unref()，不阻止进程退出
 *
 * 典型用法：
 * ```ts
 * const watchdog = createArmableStallWatchdog({
 *   label: "feishu-ws",
 *   timeoutMs: 60_000,       // 60 秒无活动视为卡死
 *   onTimeout: ({ idleMs }) => reconnect(),
 * });
 * watchdog.arm();             // 收到首条消息后 arm
 * transport.on("message", () => watchdog.touch());  // 每条消息 touch
 * transport.on("close", () => watchdog.stop());     // 关闭时 stop
 * ```
 */

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** 超时元信息（传递给 onTimeout 回调）。 */
export interface StallWatchdogTimeoutMeta {
  /** 实际空闲毫秒数 */
  idleMs: number;
  /** 配置的超时阈值（毫秒） */
  timeoutMs: number;
}

/** 可武装的 stall watchdog 公共控制接口。 */
export interface ArmableStallWatchdog {
  /** 武装 watchdog（开始监控空闲）。可重复调用以刷新 lastActivityAt。 */
  arm: (atMs?: number) => void;
  /** 触摸（更新 lastActivityAt，重置空闲计数）。 */
  touch: (atMs?: number) => void;
  /** 解除武装（停止监控，但实例仍可用，可再次 arm）。 */
  disarm: () => void;
  /** 永久停止（清理计时器与 abort 信号监听，不可再用）。 */
  stop: () => void;
  /** 当前是否已武装。 */
  isArmed: () => boolean;
}

/** 创建 stall watchdog 的参数。 */
export interface ArmableStallWatchdogParams {
  /** 标签（用于日志区分多个 watchdog 实例） */
  label: string;
  /** 超时阈值（毫秒）；超过此值未活动则触发 onTimeout */
  timeoutMs: number;
  /** 检查间隔（毫秒）；默认 min(5000, max(250, timeoutMs/6)) */
  checkIntervalMs?: number;
  /** 外部取消信号；aborted 时立即 stop */
  abortSignal?: AbortSignal;
  /** 可选日志函数（默认 console.error） */
  onError?: (msg: string) => void;
  /** 超时回调 */
  onTimeout: (meta: StallWatchdogTimeoutMeta) => void;
}

// ─── 内部工具 ─────────────────────────────────────────────────────────────────

/** 规范化超时值：必须为有限正数，否则回退到 defaultMs。 */
function resolveTimerTimeoutMs(value: number | undefined, defaultMs: number, minMs = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return defaultMs;
  }
  return Math.max(minMs, Math.floor(value));
}

// ─── 主函数 ───────────────────────────────────────────────────────────────────

/**
 * 创建一个可武装的 stall watchdog。
 *
 * 行为：
 *  - 初始状态为 disarmed（未武装）
 *  - 调用 arm() 后开始监控；touch() 重置空闲计数
 *  - arm/disarm 可多次切换；stop() 后实例不可用
 *  - 超时时：先 disarm（防止二次触发）→ 调用 onError 日志 → 调用 onTimeout
 *  - 计时器使用 unref() 不阻止进程退出
 *  - 若 abortSignal 已 aborted，则直接进入 stopped 状态
 */
export function createArmableStallWatchdog(params: ArmableStallWatchdogParams): ArmableStallWatchdog {
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  // 默认检查间隔：min(5000, max(250, timeoutMs/6))
  const defaultCheckIntervalMs = Math.min(5_000, Math.max(250, Math.floor(timeoutMs / 6)));
  const checkIntervalMs = resolveTimerTimeoutMs(
    params.checkIntervalMs,
    defaultCheckIntervalMs,
    100,
  );

  let armed = false;
  let stopped = false;
  let lastActivityAt = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const onError = params.onError ?? ((msg: string) => console.error(msg));

  /** 清理周期计时器。 */
  const clearTimer = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  /** 解除武装（不清理计时器，便于再次 arm）。 */
  const disarm = (): void => {
    armed = false;
  };

  /** 永久停止。 */
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    disarm();
    clearTimer();
    params.abortSignal?.removeEventListener("abort", stop);
  };

  /** 武装 watchdog。 */
  const arm = (atMs?: number): void => {
    if (stopped) return;
    lastActivityAt = atMs ?? Date.now();
    armed = true;
  };

  /** 触摸（更新活动时间）。 */
  const touch = (atMs?: number): void => {
    if (stopped) return;
    lastActivityAt = atMs ?? Date.now();
  };

  /** 周期检查空闲是否超过阈值。 */
  const check = (): void => {
    if (!armed || stopped) return;
    const now = Date.now();
    const idleMs = now - lastActivityAt;
    if (idleMs < timeoutMs) return;

    // 关键：在调用 onTimeout 之前先 disarm，
    // 防止重试/拆卸逻辑触发同一空闲区间的二次超时。
    disarm();
    const idleSec = Math.round(idleMs / 1000);
    const limitSec = Math.round(timeoutMs / 1000);
    onError(`[${params.label}] transport watchdog timeout: idle ${idleSec}s (limit ${limitSec}s)`);
    params.onTimeout({ idleMs, timeoutMs });
  };

  // 启动：若 abortSignal 已 aborted 则直接 stop；否则注册监听 + 启动计时器
  if (params.abortSignal?.aborted) {
    stop();
  } else {
    params.abortSignal?.addEventListener("abort", stop, { once: true });
    timer = setInterval(check, checkIntervalMs);
    // unref：计时器不阻止进程退出
    timer.unref?.();
  }

  return {
    arm,
    touch,
    disarm,
    stop,
    isArmed: () => armed,
  };
}
