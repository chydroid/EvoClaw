/**
 * 会话收割：检测并回收过期的 cron 会话。
 *
 * 灵感来自 openclaw-main 的 src/cron/session-reaper.ts。
 *
 * 当 cron 任务执行完成后，会话可能因异常而残留（未正常关闭）。
 * 此模块定期扫描并清理：
 *  1. 超过 maxAge 的会话 → close
 *  2. 状态为 "running" 但实际已超 maxRunningMs → kill
 *  3. 状态为 "running" 且 lastActivityAt 超过 maxIdleMs → kill（疑似僵尸）
 *  4. 状态为 "failed" 且已过 failedRetentionMs → archive
 *  5. 其他情况 → keep
 *
 * 设计原则：
 *  - 评估与执行解耦：evaluate 只输出决策，reap 调用回调执行
 *  - 不直接持有会话状态，由调用方提供
 *  - 所有阈值可配置，默认值参考 openclaw-main
 */

/** 收割器所看到的会话视图。 */
export interface ReaperSession {
  /** 会话 ID。 */
  id: string;
  /** 关联的 cron 任务 ID（可选）。 */
  jobId?: string;
  /** 会话状态。 */
  status: "running" | "completed" | "failed" | "cancelled";
  /** 启动时间。 */
  startedAt: Date;
  /** 最后活动时间（心跳/日志/进度更新等）。 */
  lastActivityAt: Date;
  /** 进程 ID（用于检测进程是否已退出，可选）。 */
  pid?: number;
}

/** 单个会话的回收决策。 */
export interface ReaperDecision {
  /** 会话 ID。 */
  sessionId: string;
  /** 回收动作。 */
  action: "kill" | "close" | "archive" | "keep";
  /** 决策原因（人类可读）。 */
  reason: string;
}

/** 收割器配置选项。 */
export interface SessionReaperOptions {
  /** 最大存活时长（默认 24h）。超过此值的会话无条件 close。 */
  maxAgeMs?: number;
  /** 最大空闲时长（默认 1h）。running 状态下 lastActivityAt 超过此值视为僵尸。 */
  maxIdleMs?: number;
  /** failed 状态保留期（默认 7d）。超过此值 archive。 */
  failedRetentionMs?: number;
  /** running 状态最大时长（默认 6h）。超过此值 kill。 */
  maxRunningMs?: number;
}

/** 默认值常量。 */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;          // 24h
const DEFAULT_MAX_IDLE_MS = 60 * 60 * 1000;               // 1h
const DEFAULT_FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;  // 7d
const DEFAULT_MAX_RUNNING_MS = 6 * 60 * 60 * 1000;        // 6h

/** 回收动作的处理器集合。 */
export interface ReaperHandlers {
  /** kill 一个正在运行（但僵尸或超时）的会话。 */
  kill?: (sessionId: string, reason: string) => Promise<void>;
  /** close 一个已结束但已过期的会话（释放资源）。 */
  close?: (sessionId: string, reason: string) => Promise<void>;
  /** archive 一个 failed 且过保留期的会话（归档而非删除）。 */
  archive?: (sessionId: string, reason: string) => Promise<void>;
}

/**
 * 会话收割器：评估会话状态并产生回收决策。
 *
 * 用法：
 *  const reaper = new SessionReaper();
 *  const decisions = reaper.evaluateAll(sessions);
 *  await reaper.reap(sessions, handlers);
 */
export class SessionReaper {
  private maxAgeMs: number;
  private maxIdleMs: number;
  private failedRetentionMs: number;
  private maxRunningMs: number;

  constructor(opts?: SessionReaperOptions) {
    this.maxAgeMs = opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.maxIdleMs = opts?.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
    this.failedRetentionMs = opts?.failedRetentionMs ?? DEFAULT_FAILED_RETENTION_MS;
    this.maxRunningMs = opts?.maxRunningMs ?? DEFAULT_MAX_RUNNING_MS;
  }

  /**
   * 评估单个会话的回收决策。
   *
   * 决策优先级（先匹配先返回）：
   *  1. running + 运行时长 > maxRunningMs → kill（运行超时）
   *  2. running + 空闲时长 > maxIdleMs → kill（僵尸）
   *  3. failed + (now - startedAt) > failedRetentionMs → archive
   *  4. 任意状态 + (now - startedAt) > maxAgeMs → close
   *  5. 其他 → keep
   */
  evaluate(session: ReaperSession, now: Date = new Date()): ReaperDecision {
    const nowMs = now.getTime();
    const startedMs = session.startedAt.getTime();
    const lastActivityMs = session.lastActivityAt.getTime();
    const totalAgeMs = nowMs - startedMs;
    const idleMs = nowMs - lastActivityMs;
    const runningMs = nowMs - startedMs;

    // 1. running 超过最大运行时长 → kill
    if (session.status === "running" && runningMs > this.maxRunningMs) {
      return {
        sessionId: session.id,
        action: "kill",
        reason: `running session exceeded maxRunningMs (${Math.floor(runningMs)}ms > ${this.maxRunningMs}ms)`,
      };
    }

    // 2. running 且空闲超过 maxIdleMs → kill（疑似僵尸）
    if (session.status === "running" && idleMs > this.maxIdleMs) {
      return {
        sessionId: session.id,
        action: "kill",
        reason: `running session idle for ${Math.floor(idleMs)}ms (> maxIdleMs ${this.maxIdleMs}ms), likely zombie`,
      };
    }

    // 3. failed 且超过保留期 → archive
    if (session.status === "failed" && totalAgeMs > this.failedRetentionMs) {
      return {
        sessionId: session.id,
        action: "archive",
        reason: `failed session exceeded retention (${Math.floor(totalAgeMs)}ms > ${this.failedRetentionMs}ms)`,
      };
    }

    // 4. 任意状态超过 maxAgeMs → close
    if (totalAgeMs > this.maxAgeMs) {
      return {
        sessionId: session.id,
        action: "close",
        reason: `session age ${Math.floor(totalAgeMs)}ms exceeds maxAgeMs ${this.maxAgeMs}ms`,
      };
    }

    // 5. 否则保留
    return {
      sessionId: session.id,
      action: "keep",
      reason: "within all retention limits",
    };
  }

  /**
   * 批量评估会话。返回所有非 keep 决策（keep 的也包含，便于审计）。
   */
  evaluateAll(sessions: ReaperSession[], now: Date = new Date()): ReaperDecision[] {
    return sessions.map((s) => this.evaluate(s, now));
  }

  /**
   * 执行回收：对每个非 keep 决策调用对应处理器。
   *
   * 处理器是可选的：若某动作没有对应处理器，会跳过并记录 reason。
   * 返回所有非 keep 决策（包括未执行的）。
   */
  async reap(
    sessions: ReaperSession[],
    handlers: ReaperHandlers,
    now: Date = new Date(),
  ): Promise<ReaperDecision[]> {
    const decisions = this.evaluateAll(sessions, now);
    const actionable = decisions.filter((d) => d.action !== "keep");

    // 顺序执行避免并发副作用（如资源争用）
    for (const decision of actionable) {
      try {
        if (decision.action === "kill" && handlers.kill) {
          await handlers.kill(decision.sessionId, decision.reason);
        } else if (decision.action === "close" && handlers.close) {
          await handlers.close(decision.sessionId, decision.reason);
        } else if (decision.action === "archive" && handlers.archive) {
          await handlers.archive(decision.sessionId, decision.reason);
        }
        // 若没有对应处理器，跳过（不视为错误）
      } catch (err) {
        // 处理器抛错时不中断后续回收，记录到 stderr
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[SessionReaper] handler for ${decision.action} on ${decision.sessionId} failed: ${msg}\n`,
        );
      }
    }

    return actionable;
  }

  /**
   * 更新配置（运行时调整）。
   */
  configure(opts: Partial<SessionReaperOptions>): void {
    if (opts.maxAgeMs !== undefined) this.maxAgeMs = opts.maxAgeMs;
    if (opts.maxIdleMs !== undefined) this.maxIdleMs = opts.maxIdleMs;
    if (opts.failedRetentionMs !== undefined) this.failedRetentionMs = opts.failedRetentionMs;
    if (opts.maxRunningMs !== undefined) this.maxRunningMs = opts.maxRunningMs;
  }

  /** 暴露当前配置（用于测试和审计）。 */
  get config(): Readonly<Required<SessionReaperOptions>> {
    return {
      maxAgeMs: this.maxAgeMs,
      maxIdleMs: this.maxIdleMs,
      failedRetentionMs: this.failedRetentionMs,
      maxRunningMs: this.maxRunningMs,
    };
  }
}

/**
 * 工具函数：判断会话是否为"僵尸"状态（running 但长时间无活动）。
 *
 * 与 evaluate 不同，此函数只判断僵尸状态，不产生回收决策。
 */
export function isZombieSession(session: ReaperSession, idleThresholdMs: number, now: Date = new Date()): boolean {
  if (session.status !== "running") return false;
  const idleMs = now.getTime() - session.lastActivityAt.getTime();
  return idleMs > idleThresholdMs;
}
