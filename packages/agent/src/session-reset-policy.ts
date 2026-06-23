/**
 * Session Reset Policy — 会话重置策略
 *
 * 借鉴 hermes-agent gateway/config.py SessionResetPolicy 设计：
 * - 多模式会话重置（daily / idle / both / none）
 * - 活动进程保护（有后台进程运行的会话不被重置）
 * - 按平台/会话类型覆盖策略
 *
 * 这些策略控制何时自动重置会话（清除上下文），
 * 避免长期运行的会话积累过多上下文导致性能下降或成本增加。
 */

// ── Types ─────────────────────────────────────────────────

export type SessionResetMode = "daily" | "idle" | "both" | "none";

export interface SessionResetPolicy {
  /** 重置模式 */
  mode: SessionResetMode;
  /** daily 模式：每天重置的小时（0-23） */
  atHour: number;
  /** idle 模式：空闲多少分钟后重置 */
  idleMinutes: number;
  /** 重置前是否通知用户 */
  notify: boolean;
  /** 不通知的平台列表（如 api_server、webhook） */
  notifyExcludePlatforms: string[];
}

export interface SessionResetCheck {
  /** 是否应重置 */
  shouldReset: boolean;
  /** 重置原因 */
  reason?: string;
}

// ── Defaults ──────────────────────────────────────────────

export const DEFAULT_RESET_POLICY: SessionResetPolicy = {
  mode: "both",
  atHour: 4,
  idleMinutes: 1440, // 24 小时
  notify: true,
  notifyExcludePlatforms: ["api_server", "webhook"],
};

// ── Session Info ──────────────────────────────────────────

export interface SessionResetInfo {
  /** 会话 ID */
  sessionId: string;
  /** 最后活动时间戳（ms） */
  lastActivityAt: number;
  /** 会话创建时间戳（ms） */
  createdAt: number;
  /** 是否有活跃的后台进程 */
  hasActiveProcesses: boolean;
  /** 平台名称 */
  platform?: string;
}

// ── Reset Checker ─────────────────────────────────────────

/**
 * 检查会话是否应被重置。
 *
 * 借鉴 hermes-agent gateway/session.py _is_session_expired：
 *   - daily 模式：检查是否过了当天的 atHour
 *   - idle 模式：检查空闲时间是否超过 idleMinutes
 *   - both 模式：两者取先（ whichever triggers first）
 *   - none 模式：永不自动重置
 *
 * 关键安全特性：有活跃后台进程的会话永不被重置，
 * 避免丢失正在执行的任务上下文。
 */
export function shouldResetSession(
  session: SessionResetInfo,
  policy: SessionResetPolicy = DEFAULT_RESET_POLICY,
  now: number = Date.now(),
): SessionResetCheck {
  // 活动进程保护 — 有后台进程运行的会话永不被重置
  if (session.hasActiveProcesses) {
    return { shouldReset: false };
  }

  if (policy.mode === "none") {
    return { shouldReset: false };
  }

  const idleMs = now - session.lastActivityAt;
  const idleMinutesElapsed = idleMs / 60_000;

  // idle 模式：空闲时间超过阈值
  if (policy.mode === "idle" || policy.mode === "both") {
    if (idleMinutesElapsed >= policy.idleMinutes) {
      return {
        shouldReset: true,
        reason: `Session idle for ${Math.round(idleMinutesElapsed)} minutes (threshold: ${policy.idleMinutes})`,
      };
    }
  }

  // daily 模式：过了当天的 atHour
  if (policy.mode === "daily" || policy.mode === "both") {
    const currentDate = new Date(now);
    const currentHour = currentDate.getHours();

    // 检查会话是否跨越了 atHour 时间点
    const sessionDate = new Date(session.createdAt);
    const sessionHour = sessionDate.getHours();

    // 如果会话创建于 atHour 之前，且当前时间已过 atHour，则重置
    // 或者会话创建于昨天或更早
    const dayDiff = Math.floor(
      (currentDate.setHours(0, 0, 0, 0) - sessionDate.setHours(0, 0, 0, 0)) / 86_400_000,
    );

    if (dayDiff > 0) {
      return {
        shouldReset: true,
        reason: `Session crossed daily reset boundary (atHour=${policy.atHour}, dayDiff=${dayDiff})`,
      };
    }

    // 同一天内：如果创建于 atHour 之前且当前已过 atHour
    if (sessionHour < policy.atHour && currentHour >= policy.atHour) {
      return {
        shouldReset: true,
        reason: `Session crossed daily reset boundary (atHour=${policy.atHour})`,
      };
    }
  }

  return { shouldReset: false };
}

/**
 * 判断是否应通知用户会话即将重置。
 */
export function shouldNotifyReset(
  session: SessionResetInfo,
  policy: SessionResetPolicy = DEFAULT_RESET_POLICY,
): boolean {
  if (!policy.notify) return false;
  if (session.platform && policy.notifyExcludePlatforms.includes(session.platform)) {
    return false;
  }
  return true;
}
