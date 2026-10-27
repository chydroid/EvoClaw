/**
 * OverloadRecovery — provider 瞬时过载的「自动恢复阶梯」
 *
 * 借鉴 hermes-agent agent/turn_recovery.py 的 auto-recovery 语义：
 *   - 同一 provider 出现**瞬时过载类**错误（429 限流 / 5xx / 超时 / 网络）时，
 *     不做「连续 N 次失败就切下一个 provider」的立即 failover，
 *     而是原地等待后重试：jittered backoff 15s → 上限 60s，最多 5 个周期；
 *   - provider 明确给出 Retry-After 契约时，优先尊重契约（上限 120s），
 *     避免违反契约导致反复 429；
 *   - 只在「本轮尚未产出内容」时触发（callLLMOnce 报错 ⇒ 本请求无内容，
 *     原地重试不改写已交付内容，不破坏 prompt 缓存前缀）。
 *
 * 设计取舍：纯策略模块，不持有运行状态——调用方（llm-caller 主循环）
 * 按 provider 维护计数，本模块只回答「是否还有资格重试」和「等多久」。
 */

import { jitteredBackoff } from "./retry-utils";

/** 同一 provider 的最大原地恢复周期数（2026-10-26 从 5 降为 3：
 *  实测 5 次 × 15-60s 等待 + 60s 超时 = 最多 375s，远超客户端超时。
 *  3 次在保留瞬时过载恢复能力的同时，2 次失败后即可 failover 到备用 provider。） */
export const OVERLOAD_RECOVERY_MAX = 3;
/** 首次等待基础值（ms，2026-10-26 从 15s 降为 5s：加快 failover 决策） */
export const OVERLOAD_RECOVERY_BASE_MS = 5_000;
/** 普通退避等待上限（ms，2026-10-26 从 60s 降为 30s：避免单次等待过长） */
export const OVERLOAD_RECOVERY_CAP_MS = 30_000;
/** Retry-After 契约等待上限（ms；超出上限仍等待，但封顶，避免无限挂起） */
export const RETRY_AFTER_CAP_MS = 60_000;

/**
 * 参与阶梯判断的最小结构化错误描述。
 * 与 error-classifier 的 ClassifiedError 结构兼容（只取需要的字段，
 * 避免本模块反向依赖 error-classifier）。
 */
export interface LadderErrorInfo {
  /** LLMErrorType 枚举值（字符串） */
  type: string;
  retryable: boolean;
  /** 是否有 Retry-After 契约（429 分支由 error-classifier 标注） */
  hasRetryAfterContract?: boolean;
  /** error-classifier 给出的退避值（含 Retry-After 解析结果） */
  backoffMs: number;
  /** failover-policy 判定：是否瞬时错误 */
  isTransient?: boolean;
  /** provider 失败原因（failover-policy 枚举值） */
  reason?: string;
}

/** 阶梯类型白名单：仅瞬时过载类错误原地重试（对齐 hermes 只对
 * {overloaded, server_error, timeout, rate_limit} 自动恢复） */
const LADDER_ERROR_TYPES = new Set([
  "rate_limit",
  "provider_error", // 5xx 瞬时服务端错误
  "timeout",
  "network",
]);

/**
 * 判断当前错误是否有资格进入「原地等待重试」阶梯。
 *
 * 全部满足才返回 true：
 * 1. 错误标记为可重试（retryable）
 * 2. 属于瞬时过载类白名单（限流 / 5xx / 超时 / 网络）
 * 3. 若 error-classifier 能判定瞬时性（isTransient），必须为瞬时
 *    （5xx 中夹带的请求验证错误 retryable=false 已在 1 排除）
 * 4. 该 provider 的恢复周期数未超上限
 *
 * @param info 结构化错误描述
 * @param attempts 该 provider 已使用的恢复周期数
 */
export function isOverloadLadderEligible(info: LadderErrorInfo, attempts: number): boolean {
  if (attempts >= OVERLOAD_RECOVERY_MAX) return false;
  if (!info.retryable) return false;
  if (!LADDER_ERROR_TYPES.has(info.type)) return false;
  if (info.isTransient === false) return false;
  return true;
}

/**
 * 计算第 N 个恢复周期的等待时长（1-based）。
 *
 * - 有 Retry-After 契约：尊重契约值（error-classifier 的 backoffMs 已含
 *   Retry-After 解析），封顶 RETRY_AFTER_CAP_MS；
 * - 无契约：jitteredBackoff(N, 15s, 60s)——指数退避 + 去相关抖动，
 *   并发会话重试同一 provider 时各自等待不同时长（避免 thundering herd）。
 *
 * @param attempt 当前周期序号（1-based，即第几次原地重试）
 * @param info 结构化错误描述
 */
export function computeOverloadWait(attempt: number, info: LadderErrorInfo): number {
  if (info.hasRetryAfterContract) {
    return Math.min(Math.max(info.backoffMs, 0), RETRY_AFTER_CAP_MS);
  }
  return jitteredBackoff(attempt, OVERLOAD_RECOVERY_BASE_MS, OVERLOAD_RECOVERY_CAP_MS, 0.5);
}
