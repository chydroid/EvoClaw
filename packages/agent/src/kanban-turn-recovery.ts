/**
 * kanban-turn-recovery — Kanban worker 回合内恢复（对标 hermes-agent agent/kanban_turn_recovery.py）
 *
 * 问题：kanban worker 在 retryable 失败（provider stream 风暴等）时静默退出，
 * dispatcher 记为 protocol_violation 并从头重spawn——丢弃整个 session 上下文。
 *
 * 解决：在 worker 进程内原地恢复——同一 session、同一 conversation history、
 * 有界预算、显式退避、续跑 nudge 告诉模型用终端工具收尾。
 *
 * 关键规则（对标 hermes）：
 *   - 仅 retryable 失败可恢复（rate_limit/billing/upstream_rate_limit 不可恢复）
 *   - 恢复前证明 worker 仍拥有 claim lease（fail closed）
 *   - 终态结算（max_iterations_reached）不再恢复
 *   - partial/completed=False 不恢复（截断/压缩修复在 conversation loop 内处理）
 *   - 退避：15s / 45s / 90s（最后一条重复）
 *   - 最大恢复次数：3（可环境变量配置，clamp 到 [0, 10]）
 */

// ── 常量 ──────────────────────────────────────────────

/** 默认最大恢复次数 */
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3;

/** 恢复前退避（秒），最后一条重复 */
const RECOVERY_DELAYS_SECONDS: number[] = [15, 45, 90];

/** 不可恢复的失败原因（需要 dispatcher 的 cooldown/breaker 处理） */
const NON_RECOVERABLE_REASONS = new Set([
  "rate_limit",
  "billing",
  "upstream_rate_limit",
]);

/** 终态退出前缀（已通过 durable terminal settlement） */
const TERMINAL_TURN_EXIT_PREFIXES = ["max_iterations_reached"];

/** 关闭值集合 */
const OFF_VALUES = new Set(["0", "false", "no", "off"]);

// ── 类型 ──────────────────────────────────────────────

export interface KanbanRecoveryConfig {
  /** 最大恢复次数（默认 3） */
  maxRecoveryAttempts?: number;
  /** Kanban task ID（dispatcher 注入） */
  taskId?: string;
}

export interface KanbanTurnResult {
  /** 是否失败 */
  failed: boolean;
  /** 失败是否可重试 */
  failureRetryable: boolean;
  /** 失败原因 */
  failureReason?: string;
  /** 是否被中断 */
  interrupted?: boolean;
  /** 回合退出原因 */
  turnExitReason?: string;
}

// ── 函数 ──────────────────────────────────────────────

/**
 * 获取最大恢复次数（环境变量 HERMES_KANBAN_TURN_RECOVERY 或配置）。
 */
export function maxRecoveryAttempts(config: KanbanRecoveryConfig = {}): number {
  const raw = process.env.HERMES_KANBAN_TURN_RECOVERY?.trim();
  if (config.maxRecoveryAttempts !== undefined) return config.maxRecoveryAttempts;
  if (!raw) return DEFAULT_MAX_RECOVERY_ATTEMPTS;
  if (OFF_VALUES.has(raw.toLowerCase())) return 0;
  const value = parseInt(raw, 10);
  if (Number.isNaN(value)) return DEFAULT_MAX_RECOVERY_ATTEMPTS;
  return Math.max(0, Math.min(value, 10));
}

/**
 * 获取恢复前退避时间（秒）。
 */
export function recoveryDelaySeconds(attempt: number): number {
  const idx = Math.min(Math.max(attempt, 1) - 1, RECOVERY_DELAYS_SECONDS.length - 1);
  return RECOVERY_DELAYS_SECONDS[idx];
}

/**
 * 判断回合退出是否已通过终态结算。
 */
function isTerminalTurnExit(result: KanbanTurnResult): boolean {
  const reason = result.turnExitReason ?? "";
  return TERMINAL_TURN_EXIT_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

/**
 * 判断失败原因是否不可恢复。
 */
function isNonRecoverableReason(reason: string | undefined): boolean {
  return reason !== undefined && NON_RECOVERABLE_REASONS.has(reason);
}

/**
 * 判断 kanban worker 回合失败后是否应该原地恢复。
 *
 * 规则（全部满足才恢复）：
 * 1. 有 kanban task ID（worker 上下文）
 * 2. 恢复次数未超上限
 * 3. 回合确实失败
 * 4. 失败标记为可重试
 * 5. 失败原因不在不可恢复集合中
 * 6. 未被中断
 * 7. 未通过终态结算
 */
export function shouldRecoverTurn(
  result: KanbanTurnResult,
  attempt: number,
  config: KanbanRecoveryConfig = {},
): boolean {
  // 检查 kanban worker 上下文
  if (!config.taskId && !process.env.HERMES_KANBAN_TASK?.trim()) return false;

  if (attempt >= maxRecoveryAttempts(config)) return false;
  if (result.interrupted) return false;
  if (isTerminalTurnExit(result)) return false;
  if (!result.failed) return false;
  if (!result.failureRetryable) return false;
  if (isNonRecoverableReason(result.failureReason)) return false;
  return true;
}

/**
 * 构建 kanban 恢复续跑 nudge——告诉模型用终端工具收尾。
 *
 * 与 kanban-stop.ts 的 nudge 不同：这个 nudge 在失败后注入，
 * 告诉模型「上一次尝试失败了，请继续完成并用终端工具收尾」。
 */
export function buildKanbanRecoveryNudge(
  taskId: string,
  attempt: number,
  failureReason?: string,
): string {
  const reasonHint = failureReason
    ? ` The previous attempt failed with "${failureReason}". `
    : "";
  return (
    "[System: You are a kanban worker. Your previous attempt did not complete. " +
    reasonHint +
    "The task has not been handed off: no terminal board call " +
    "(kanban_complete / kanban_request_review / kanban_block) was made.\n\n" +
    `Task \`${taskId}\` recovery attempt ${attempt + 1}. ` +
    "Do this immediately in your next response:\n" +
    "1. Resume from where you left off — do not restart from scratch.\n" +
    "2. Finish any remaining deliverable (write the required file(s) now).\n" +
    "3. Call `kanban_complete(summary=..., artifacts=[...])` if done, " +
    "`kanban_request_review(summary=...)` if needs review, " +
    "OR `kanban_block(reason=...)` if blocked.\n\n" +
    "Never end a turn with only a promise of future action.]"
  );
}
