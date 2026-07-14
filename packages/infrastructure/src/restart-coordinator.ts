/**
 * restart-coordinator.ts — Gateway 重启顶层编排器
 *
 * 对齐 openclaw-main 的 src/infra/restart.ts 中的 scheduleGatewaySigusr1Restart +
 * emitGatewayRestart + deferGatewayRestartUntilIdle。
 *
 * 职责：
 * - 协调多源重启请求（用户 RPC / 配置变更 / 自动更新 / 计划任务）
 * - 防抖 / 合并：未消费的重启信号会被新请求合并
 * - 冷却期：默认 30s 内不重复触发，防止重启风暴
 * - 延迟轮询：业务层注册 getPendingCount，编排器轮询直到 0 再触发
 * - intent 文件：触发前写入持久化 intent，便于新进程知道自己为何重启
 * - sentinel 授权：调用 sentinel.authorize() 后才允许执行
 * - supervisor 交接：当无 SIGUSR1 监听器时回退到 handoff
 *
 * 典型流程：
 *   schedule({ delayMs: 2000, reason: "config.reload", getPendingCount: () => pendingTasks })
 *     ↓ armPendingTimer
 *     ↓ [timer fire] → emitPreparedGatewayRestart
 *     ↓ [deferGatewayRestartUntilIdle] poll until pending=0
 *     ↓ writeGatewayRestartIntentSync
 *     ↓ sentinel.enterCycle() + sentinel.authorize()
 *     ↓ emitGatewayRestart: process.emit("SIGUSR1") || triggerGatewayRestart()
 */

import {
  type GatewayRestartIntent,
  writeGatewayRestartIntentSync,
  consumeGatewayRestartIntentSync,
  clearGatewayRestartIntentSync,
  type ConsumeIntentResult,
} from "./restart-intent";
import {
  RestartSentinel,
  getDefaultRestartSentinel,
} from "./restart-sentinel";
import {
  triggerGatewayRestart,
  type RestartAttempt,
} from "./restart-handoff";

const DEFAULT_DELAY_MS = 2000;
const MAX_DELAY_MS = 60_000;
const DEFAULT_DEFERRAL_POLL_MS = 500;
const DEFAULT_DEFERRAL_STILL_PENDING_WARN_MS = 30_000;
const DEFAULT_DEFERRAL_TIMEOUT_MS = 300_000;

/**
 * 重启审计信息。
 */
export interface RestartAuditInfo {
  actor?: string;
  deviceId?: string;
  clientIp?: string;
  changedPaths?: string[];
}

/**
 * 重启延迟 hooks — 业务层观察延迟状态。
 */
export interface RestartDeferralHooks {
  onDeferring?: (pending: number) => void;
  onStillPending?: (pending: number, elapsedMs: number) => void;
  onReady?: () => void;
  onTimeout?: (pending: number, elapsedMs: number) => void;
  onCheckError?: (err: unknown) => void;
}

/**
 * 重启 emit hooks — 业务层在 emit 前后执行副作用。
 */
export interface RestartEmitHooks {
  beforeEmit?: () => Promise<void>;
  afterEmitRejected?: () => Promise<void>;
}

/**
 * 调度结果。
 */
export interface ScheduledRestart {
  ok: boolean;
  pid: number;
  signal: "SIGUSR1";
  delayMs: number;
  reason?: string;
  mode: "emit" | "signal" | "supervisor";
  coalesced: boolean;
  cooldownMsApplied: number;
  emitHooksQueued: boolean;
}

/**
 * 重启协调器 — 单例。
 *
 * 状态：
 * - pendingRestartTimer: 延迟 emit 的 setTimeout 句柄
 * - pendingRestartDueAt: 计划 emit 时间
 * - pendingRestartReason: 计划重启原因
 * - pendingRestartEmitHooks: 业务层 hooks
 * - pendingRestartSkipDeferral: 是否跳过 deferral 轮询
 * - pendingRestartPreparing: 是否正在执行 beforeEmit
 * - activeDeferralPolls: 当前活跃的 deferral 轮询集合
 */
export class RestartCoordinator {
  private pendingRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRestartDueAt = 0;
  private pendingRestartReason: string | undefined;
  private pendingRestartEmitHooks: RestartEmitHooks | undefined;
  private pendingRestartSessionKey: string | undefined;
  private pendingRestartSkipDeferral = false;
  private pendingRestartPreparing = false;
  private readonly activeDeferralPolls = new Set<ReturnType<typeof setInterval>>();

  private readonly sentinel: RestartSentinel;
  private readonly nowFn: () => number;
  private readonly deferralPollMs: number;
  private readonly deferralStillPendingWarnMs: number;
  private readonly deferralTimeoutMs: number;

  constructor(opts?: {
    sentinel?: RestartSentinel;
    nowFn?: () => number;
    deferralPollMs?: number;
    deferralStillPendingWarnMs?: number;
    deferralTimeoutMs?: number;
  }) {
    this.sentinel = opts?.sentinel ?? getDefaultRestartSentinel();
    this.nowFn = opts?.nowFn ?? (() => Date.now());
    this.deferralPollMs = opts?.deferralPollMs ?? DEFAULT_DEFERRAL_POLL_MS;
    this.deferralStillPendingWarnMs =
      opts?.deferralStillPendingWarnMs ?? DEFAULT_DEFERRAL_STILL_PENDING_WARN_MS;
    this.deferralTimeoutMs = opts?.deferralTimeoutMs ?? DEFAULT_DEFERRAL_TIMEOUT_MS;
  }

  /**
   * 设置外部信号策略。
   */
  setExternalPolicy(allowExternal: boolean): void {
    this.sentinel.setExternalPolicy(allowExternal);
  }

  /**
   * 注册业务层的 deferral check — 返回当前 pending 数量。
   * 仅对后续 schedule() 调用生效。
   */
  setPreRestartDeferralCheck(fn: (() => number) | null): void {
    this.preRestartCheck = fn;
  }
  private preRestartCheck: (() => number) | null = null;

  /**
   * 调度一次 gateway 重启。
   *
   * 合并规则：
   * - 已有未消费的信号：返回 coalesced:true，不重新调度
   * - 已有 pending timer：根据 delayMs / skipDeferral 决定是否提前
   * - 新请求：arm 新 timer
   *
   * @param opts.delayMs 延迟毫秒（0-60000，默认 2000）
   * @param opts.reason 重启原因（trim + 截断 200）
   * @param opts.audit 审计信息
   * @param opts.emitHooks 业务层 hooks
   * @param opts.sessionKey 会话 key（防止跨会话覆盖）
   * @param opts.skipDeferral 跳过 deferral 轮询
   * @param opts.skipCooldown 跳过冷却期检查
   * @param opts.port 端口号（用于 supervisor handoff 前清理）
   */
  schedule(opts?: {
    delayMs?: number;
    reason?: string;
    audit?: RestartAuditInfo;
    emitHooks?: RestartEmitHooks;
    sessionKey?: string;
    skipDeferral?: boolean;
    skipCooldown?: boolean;
    port?: number;
  }): ScheduledRestart {
    const delayMsRaw =
      typeof opts?.delayMs === "number" && Number.isFinite(opts.delayMs)
        ? Math.floor(opts.delayMs)
        : DEFAULT_DELAY_MS;
    const delayMs = Math.min(Math.max(delayMsRaw, 0), MAX_DELAY_MS);
    const reason =
      typeof opts?.reason === "string" && opts.reason.trim()
        ? opts.reason.trim().slice(0, 200)
        : undefined;
    const skipCooldown = opts?.skipCooldown === true;
    const nowMs = this.nowFn();
    const cooldownMsApplied = skipCooldown
      ? 0
      : this.sentinel.remainingCooldownMs();
    const requestedDueAt = nowMs + delayMs + cooldownMsApplied;
    const skipDeferral = opts?.skipDeferral === true;

    const hasSigusr1Listener = process.listenerCount("SIGUSR1") > 0;
    const mode: "emit" | "signal" | "supervisor" =
      hasSigusr1Listener ? "emit" : process.platform === "win32" ? "supervisor" : "signal";

    // 1. 已有未消费信号 → 合并
    if (this.sentinel.hasUnconsumedSignal()) {
      return {
        ok: true,
        pid: process.pid,
        signal: "SIGUSR1",
        delayMs: 0,
        reason,
        mode,
        coalesced: true,
        cooldownMsApplied,
        emitHooksQueued: false,
      };
    }

    // 2. 已有 pending timer / preparing
    if (this.pendingRestartTimer || this.pendingRestartPreparing) {
      const remainingMs = this.pendingRestartPreparing
        ? 0
        : Math.max(0, this.pendingRestartDueAt - nowMs);

      // skipDeferral + 有活跃 deferral poll → 立即 bypass
      if (this.pendingRestartPreparing && skipDeferral && this.activeDeferralPolls.size > 0) {
        this.clearActiveDeferralPolls();
        this.pendingRestartReason = reason;
        this.pendingRestartEmitHooks = opts?.emitHooks;
        this.pendingRestartSessionKey = opts?.sessionKey;
        this.safeEmitPreparedGatewayRestart(undefined, reason, opts?.port);
        return {
          ok: true,
          pid: process.pid,
          signal: "SIGUSR1",
          delayMs: 0,
          reason,
          mode,
          coalesced: false,
          cooldownMsApplied,
          emitHooksQueued: opts?.emitHooks !== undefined,
        };
      }

      const shouldUpgradeToSkipDeferral = skipDeferral && !this.pendingRestartSkipDeferral;
      const shouldPullEarlier =
        !this.pendingRestartPreparing &&
        (requestedDueAt < this.pendingRestartDueAt || shouldUpgradeToSkipDeferral);

      if (shouldPullEarlier) {
        // 跨会话保护：不允许覆盖其他 session 的 pending
        if (!this.canReplacePendingEmitHooks(opts?.emitHooks, opts?.sessionKey)) {
          if (this.pendingRestartTimer) {
            clearTimeout(this.pendingRestartTimer);
          }
          this.pendingRestartTimer = null;
          this.pendingRestartDueAt = requestedDueAt;
          this.pendingRestartReason = reason;
          this.pendingRestartSkipDeferral = this.pendingRestartSkipDeferral || skipDeferral;
          this.armPendingRestartTimer(requestedDueAt, nowMs);
          return {
            ok: true,
            pid: process.pid,
            signal: "SIGUSR1",
            delayMs: Math.max(0, requestedDueAt - nowMs),
            reason,
            mode,
            coalesced: true,
            cooldownMsApplied,
            emitHooksQueued: false,
          };
        }
        this.clearPendingScheduledRestart();
      } else {
        // coalesce：更新 reason，可能更新 hooks
        if (this.shouldPreferRestartReason(reason, this.pendingRestartReason)) {
          this.pendingRestartReason = reason;
        }
        this.pendingRestartSkipDeferral = this.pendingRestartSkipDeferral || skipDeferral;
        const emitHooksQueued = this.updatePendingRestartEmitHooks(opts?.emitHooks, opts?.sessionKey);
        return {
          ok: true,
          pid: process.pid,
          signal: "SIGUSR1",
          delayMs: remainingMs,
          reason,
          mode,
          coalesced: true,
          cooldownMsApplied,
          emitHooksQueued,
        };
      }
    }

    // 3. 新请求：arm timer
    this.pendingRestartDueAt = requestedDueAt;
    this.pendingRestartReason = reason;
    this.pendingRestartEmitHooks = opts?.emitHooks;
    this.pendingRestartSessionKey = opts?.sessionKey;
    this.pendingRestartSkipDeferral = skipDeferral;
    this.armPendingRestartTimer(requestedDueAt, nowMs, opts?.port);
    return {
      ok: true,
      pid: process.pid,
      signal: "SIGUSR1",
      delayMs: Math.max(0, requestedDueAt - nowMs),
      reason,
      mode,
      coalesced: false,
      cooldownMsApplied,
      emitHooksQueued: opts?.emitHooks !== undefined,
    };
  }

  /**
   * 立即触发一次重启（绕过 deferral 与冷却期）。
   * 通常由 SIGUSR1 处理器在信号到达后调用。
   *
   * @returns true 已发出信号；false 因合并 / emit 失败未发出
   */
  emitGatewayRestart(
    reasonOverride?: string,
    intent?: GatewayRestartIntent,
    port?: number,
  ): boolean {
    if (this.sentinel.hasUnconsumedSignal()) {
      this.clearActiveDeferralPolls();
      this.clearPendingScheduledRestart();
      return false;
    }
    this.clearActiveDeferralPolls();
    this.clearPendingScheduledRestart();

    const reason = reasonOverride ?? intent?.reason ?? this.pendingRestartReason;
    // 写 intent 文件
    writeGatewayRestartIntentSync({
      targetPid: process.pid,
      intent: { ...intent, ...(reason ? { reason } : {}) },
      reason,
    });
    // 进入 cycle + 授权
    this.sentinel.enterCycle(reason);
    this.sentinel.authorize();

    try {
      if (process.listenerCount("SIGUSR1") > 0) {
        // 信号路径：run-loop 的 SIGUSR1 handler 驱动重启
        process.emit("SIGUSR1");
      } else if (process.platform === "win32") {
        // Windows 无 SIGUSR1 监听器 → 回退到 supervisor 交接
        const result = triggerGatewayRestart(port !== undefined ? { port } : undefined);
        if (!result.ok) {
          this.sentinel.rollbackEmission();
          clearGatewayRestartIntentSync();
          return false;
        }
        this.sentinel.consumeAuthorization();
        this.sentinel.markConsumed();
      } else {
        // Unix 无监听器 → 直接发送信号
        process.kill(process.pid, "SIGUSR1");
      }
    } catch {
      this.sentinel.rollbackEmission();
      clearGatewayRestartIntentSync();
      return false;
    }
    // 标记已发出信号 — 启动冷却期
    this.sentinel.markEmitted();
    return true;
  }

  /**
   * 消费持久化的 intent 文件（新进程启动时调用）。
   */
  consumeIntent(env?: NodeJS.ProcessEnv, now?: number): ConsumeIntentResult {
    return consumeGatewayRestartIntentSync(env, now);
  }

  /**
   * 清理 intent 文件。
   */
  clearIntent(env?: NodeJS.ProcessEnv): void {
    clearGatewayRestartIntentSync(env);
  }

  /**
   * 重置全部内存状态（仅用于测试或 in-process restart）。
   */
  resetInProcessRestartState(): void {
    this.clearActiveDeferralPolls();
    this.clearPendingScheduledRestart();
  }

  /**
   * 获取 sentinel 状态快照（用于诊断）。
   */
  getSentinelState() {
    return this.sentinel.getState();
  }

  // ─── 内部方法 ───

  private shouldPreferRestartReason(next?: string, current?: string): boolean {
    return next === "update.run" && current !== "update.run";
  }

  private canReplacePendingEmitHooks(
    hooks: RestartEmitHooks | undefined,
    sessionKey: string | undefined,
  ): boolean {
    if (!hooks) {
      return true;
    }
    return (
      this.pendingRestartSessionKey === undefined ||
      this.pendingRestartSessionKey === sessionKey
    );
  }

  private updatePendingRestartEmitHooks(
    hooks: RestartEmitHooks | undefined,
    sessionKey: string | undefined,
  ): boolean {
    if (!this.canReplacePendingEmitHooks(hooks, sessionKey)) {
      return false;
    }
    if (!hooks) {
      return false;
    }
    this.pendingRestartEmitHooks = hooks;
    if (sessionKey !== undefined) {
      this.pendingRestartSessionKey = sessionKey;
    }
    return true;
  }

  private clearPendingScheduledRestart(): void {
    if (this.pendingRestartTimer) {
      clearTimeout(this.pendingRestartTimer);
    }
    this.pendingRestartTimer = null;
    this.pendingRestartDueAt = 0;
    this.pendingRestartReason = undefined;
    this.pendingRestartEmitHooks = undefined;
    this.pendingRestartSessionKey = undefined;
    this.pendingRestartSkipDeferral = false;
    this.pendingRestartPreparing = false;
  }

  private clearActiveDeferralPolls(): void {
    for (const poll of this.activeDeferralPolls) {
      clearInterval(poll);
    }
    this.activeDeferralPolls.clear();
  }

  private armPendingRestartTimer(requestedDueAt: number, nowMs: number, port?: number): void {
    this.pendingRestartTimer = setTimeout(() => {
      const scheduledReason = this.pendingRestartReason;
      const scheduledSkipDeferral = this.pendingRestartSkipDeferral;
      this.pendingRestartTimer = null;
      this.pendingRestartDueAt = 0;
      this.pendingRestartReason = undefined;
      this.pendingRestartSkipDeferral = false;
      this.pendingRestartPreparing = true;
      const pendingCheck = this.preRestartCheck;
      if (scheduledSkipDeferral || !pendingCheck) {
        this.safeEmitPreparedGatewayRestart(undefined, scheduledReason, port);
        return;
      }
      this.deferGatewayRestartUntilIdle({
        getPendingCount: pendingCheck,
        maxWaitMs: this.deferralTimeoutMs,
        reason: scheduledReason,
        timeoutIntent: { force: true, ...(scheduledReason ? { reason: scheduledReason } : {}) },
        port,
      });
    }, Math.max(0, requestedDueAt - nowMs));
    // 不阻塞进程退出
    if (typeof this.pendingRestartTimer.unref === "function") {
      this.pendingRestartTimer.unref();
    }
  }

  private async emitPreparedGatewayRestart(
    hooks?: RestartEmitHooks,
    reasonOverride?: string,
    port?: number,
  ): Promise<void> {
    let nextHooks = hooks ?? this.pendingRestartEmitHooks;
    if (!hooks) {
      this.pendingRestartEmitHooks = undefined;
    }
    let preparedHooks: RestartEmitHooks | undefined;
    while (nextHooks) {
      if (preparedHooks) {
        await preparedHooks.afterEmitRejected?.().catch(() => undefined);
        preparedHooks = undefined;
      }
      try {
        await nextHooks.beforeEmit?.();
        preparedHooks = nextHooks;
      } catch {
        // beforeEmit 失败 → 继续重启，但跳过该 hook
      }
      if (hooks) {
        break;
      }
      nextHooks = this.pendingRestartEmitHooks;
      this.pendingRestartEmitHooks = undefined;
    }
    if (!hooks) {
      this.pendingRestartSessionKey = undefined;
    }
    const emitted = this.emitGatewayRestart(reasonOverride, undefined, port);
    if (!emitted) {
      await preparedHooks?.afterEmitRejected?.().catch(() => undefined);
    }
  }

  /**
   * 安全包装：调用 emitPreparedGatewayRestart 并吞掉异常，避免未捕获的 Promise 拒绝。
   * 之前 7 处 `this.safeEmitPreparedGatewayRestart(...)` 都是 fire-and-forget，
   * 若内部抛出（如 beforeEmit hook 异常未处理）会变成 unhandledRejection。
   */
  private safeEmitPreparedGatewayRestart(
    hooks?: RestartEmitHooks,
    reasonOverride?: string,
    port?: number,
  ): void {
    this.emitPreparedGatewayRestart(hooks, reasonOverride, port).catch((err) => {
      process.stderr.write(
        `[RestartCoordinator] emitPreparedGatewayRestart failed: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    });
  }

  private deferGatewayRestartUntilIdle(opts: {
    getPendingCount: () => number;
    hooks?: RestartDeferralHooks;
    emitHooks?: RestartEmitHooks;
    maxWaitMs?: number;
    pollMs?: number;
    reason?: string;
    timeoutIntent?: GatewayRestartIntent;
    port?: number;
  }): void {
    const pollMs = Math.max(10, Math.floor(opts.pollMs ?? this.deferralPollMs));
    const maxWaitMs =
      typeof opts.maxWaitMs === "number" && Number.isFinite(opts.maxWaitMs) && opts.maxWaitMs > 0
        ? Math.max(pollMs, Math.floor(opts.maxWaitMs))
        : undefined;

    let pending: number;
    try {
      pending = opts.getPendingCount();
    } catch (err) {
      opts.hooks?.onCheckError?.(err);
      this.safeEmitPreparedGatewayRestart(opts.emitHooks, opts.reason, opts.port);
      return;
    }
    if (pending <= 0) {
      opts.hooks?.onReady?.();
      this.safeEmitPreparedGatewayRestart(opts.emitHooks, opts.reason, opts.port);
      return;
    }

    opts.hooks?.onDeferring?.(pending);
    const startedAt = this.nowFn();
    let nextStillPendingAt = startedAt + this.deferralStillPendingWarnMs;
    const poll = setInterval(() => {
      let current: number;
      try {
        current = opts.getPendingCount();
      } catch (err) {
        clearInterval(poll);
        this.activeDeferralPolls.delete(poll);
        opts.hooks?.onCheckError?.(err);
        this.safeEmitPreparedGatewayRestart(opts.emitHooks, opts.reason, opts.port);
        return;
      }
      if (current <= 0) {
        clearInterval(poll);
        this.activeDeferralPolls.delete(poll);
        opts.hooks?.onReady?.();
        this.safeEmitPreparedGatewayRestart(opts.emitHooks, opts.reason, opts.port);
        return;
      }
      const elapsedMs = this.nowFn() - startedAt;
      if (this.nowFn() >= nextStillPendingAt) {
        opts.hooks?.onStillPending?.(current, elapsedMs);
        nextStillPendingAt = this.nowFn() + this.deferralStillPendingWarnMs;
      }
      if (maxWaitMs !== undefined && elapsedMs >= maxWaitMs) {
        clearInterval(poll);
        this.activeDeferralPolls.delete(poll);
        opts.hooks?.onTimeout?.(current, elapsedMs);
        this.safeEmitPreparedGatewayRestart(
          opts.emitHooks,
          opts.reason,
          opts.port,
        );
      }
    }, pollMs);
    if (typeof poll.unref === "function") {
      poll.unref();
    }
    this.activeDeferralPolls.add(poll);
  }
}

// ─── 默认单例 ───

let defaultCoordinator: RestartCoordinator | null = null;

export function getDefaultRestartCoordinator(): RestartCoordinator {
  if (!defaultCoordinator) {
    defaultCoordinator = new RestartCoordinator();
  }
  return defaultCoordinator;
}

export function resetDefaultRestartCoordinator(): void {
  defaultCoordinator = null;
}

// ─── 便捷导出 ───

export type {
  GatewayRestartIntent,
  ConsumeIntentResult,
} from "./restart-intent";
export type { RestartAttempt, RestartMethod } from "./restart-handoff";
export { RestartSentinel, getDefaultRestartSentinel, resetDefaultRestartSentinel } from "./restart-sentinel";
export { triggerGatewayRestart } from "./restart-handoff";
export {
  writeGatewayRestartIntentSync,
  consumeGatewayRestartIntentSync,
  clearGatewayRestartIntentSync,
  resolveDefaultStateDir,
  resolveRestartIntentPath,
  readGatewayRestartIntentPayloadSync,
} from "./restart-intent";
export {
  cleanStaleGatewayProcessesSync,
  findGatewayPidsOnPortSync,
  getSelfAndAncestorPidsSync,
  isGatewayArgv,
  terminateStaleProcessesSync,
  waitForPortFreeSync,
} from "./restart-stale-pids";
export type {
  TerminateResult,
  PollPortResult,
} from "./restart-stale-pids";

/**
 * 暴露内部常量给测试。
 */
export const __testing = {
  DEFAULT_DELAY_MS,
  MAX_DELAY_MS,
  DEFAULT_DEFERRAL_POLL_MS,
  DEFAULT_DEFERRAL_STILL_PENDING_WARN_MS,
  DEFAULT_DEFERRAL_TIMEOUT_MS,
};
