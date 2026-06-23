/**
 * CrossSessionRateGuard — 跨会话速率限制守卫
 *
 * 借鉴 hermes-agent agent/nous_rate_guard.py：
 *
 * 核心问题：
 *   retry amplification — 每个 429 触发最多 9 次 API 调用（3 SDK retries × 3 Hermes retries），
 *   每次都计入 RPH（Requests Per Hour），导致配额快速耗尽。
 *
 * 解决方案：
 *   - 基于文件的跨会话共享状态（CLI、gateway、cron、auxiliary 共享同一文件）
 *   - 首次 429 记录状态，后续调用前检查
 *   - 消除 retry amplification
 *
 * 关键设计：
 *   - _MIN_RESET_FOR_BREAKER_SECONDS = 60 — 短窗口视为瞬时
 *   - is_genuine_rate_limit — 区分账号配额耗尽 vs 上游瞬时容量不足
 *   - _parse_reset_seconds — 优先级：x-ratelimit-reset-requests-1h > x-ratelimit-reset-requests > retry-after
 *   - 原子写入（遵循 AGENTS.md 的 atomicWriteFile 规则）
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface CrossSessionRateLimitState {
  /** provider 名称 */
  provider: string;
  /** 首次 429 的时间戳 */
  recordedAt: number;
  /** 预计重置时间戳 */
  resetAt: number;
  /** 重置秒数（原始值） */
  resetSeconds: number;
  /** 是否为真正的配额耗尽（vs 瞬时容量不足） */
  isGenuine: boolean;
  /** 触发的状态码 */
  statusCode: number;
}

export interface RateGuardConfig {
  /** 状态文件目录 */
  stateDir?: string;
  /** 最小重置时间（秒），小于此值视为瞬时 */
  minResetForBreakerSeconds: number;
  /** 状态文件 TTL（毫秒），超过后视为过期 */
  stateTtlMs: number;
}

export const DEFAULT_RATE_GUARD_CONFIG: RateGuardConfig = {
  minResetForBreakerSeconds: 60,
  stateTtlMs: 3600_000, // 1 小时
};

// ── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 解析重置秒数。
 * 借鉴 hermes-agent _parse_reset_seconds：
 *   优先级：x-ratelimit-reset-requests-1h > x-ratelimit-reset-requests > retry-after
 *
 * @param headers 响应头
 * @returns 重置秒数，或 null 如果无法解析
 */
export function parseResetSeconds(headers: Record<string, string | string[] | undefined>): number | null {
  const getHeader = (name: string): string | undefined => {
    const value = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };

  // 优先级 1: x-ratelimit-reset-requests-1h
  const reset1h = getHeader("x-ratelimit-reset-requests-1h");
  if (reset1h) {
    const seconds = parseDuration(reset1h);
    if (seconds !== null) return seconds;
  }

  // 优先级 2: x-ratelimit-reset-requests
  const resetRequests = getHeader("x-ratelimit-reset-requests");
  if (resetRequests) {
    const seconds = parseDuration(resetRequests);
    if (seconds !== null) return seconds;
  }

  // 优先级 3: retry-after
  const retryAfter = getHeader("retry-after");
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds) && seconds > 0) return seconds;
    // 可能是 HTTP 日期格式
    const date = Date.parse(retryAfter);
    if (!isNaN(date)) {
      return Math.max(0, Math.ceil((date - Date.now()) / 1000));
    }
  }

  return null;
}

/**
 * 解析持续时间字符串。
 * 支持：数字（秒）、"60s"、"5m"、"1h"、"30ms" 等。
 */
function parseDuration(value: string): number | null {
  const trimmed = value.trim().toLowerCase();

  // 纯数字（秒）
  const pureNumber = parseInt(trimmed, 10);
  if (!isNaN(pureNumber) && trimmed === String(pureNumber)) {
    return pureNumber;
  }

  // 带单位
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!match) return null;

  const num = parseFloat(match[1]);
  const unit = match[2] || "s";

  switch (unit) {
    case "ms": return num / 1000;
    case "s": return num;
    case "m": return num * 60;
    case "h": return num * 3600;
    case "d": return num * 86400;
    default: return num;
  }
}

/**
 * 原子写入文件。
 * 遵循 AGENTS.md 的 atomicWriteFile 规则：temp + rename。
 */
function atomicWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, content, "utf8");
  try {
    renameSync(tmpPath, filePath);
  } catch {
    // rename 失败，尝试直接写入
    try {
      writeFileSync(filePath, content, "utf8");
    } catch {
      // 最终失败，忽略
    }
  }
}

// ── 主类 ────────────────────────────────────────────────────────────────────

/**
 * 跨会话速率限制守卫。
 *
 * 借鉴 hermes-agent agent/nous_rate_guard.py。
 */
export class CrossSessionRateGuard {
  private config: RateGuardConfig;
  private stateDir: string;
  private cache: Map<string, CrossSessionRateLimitState> = new Map();
  private cacheLoaded = false;

  constructor(config: Partial<RateGuardConfig> = {}) {
    this.config = { ...DEFAULT_RATE_GUARD_CONFIG, ...config };
    this.stateDir = this.config.stateDir ?? join(homedir(), ".evoclaw", "rate-limits");
  }

  /**
   * 记录速率限制事件。
   *
   * 借鉴 hermes-agent record_nous_rate_limit：
   *   1. 解析响应头获取重置时间
   *   2. 判断是否为真正的配额耗尽
   *   3. 写入共享文件
   *
   * @param provider provider 名称
   * @param statusCode HTTP 状态码
   * @param headers 响应头
   */
  recordRateLimit(
    provider: string,
    statusCode: number,
    headers: Record<string, string | string[] | undefined>,
  ): CrossSessionRateLimitState {
    const resetSeconds = parseResetSeconds(headers) ?? 3600; // 默认 1 小时
    const now = Date.now();

    const state: CrossSessionRateLimitState = {
      provider,
      recordedAt: now,
      resetAt: now + resetSeconds * 1000,
      resetSeconds,
      isGenuine: this.isGenuineRateLimit(resetSeconds, statusCode),
      statusCode,
    };

    // 更新缓存
    this.cache.set(provider, state);

    // 持久化到文件
    this.saveState(provider, state);

    return state;
  }

  /**
   * 检查是否仍在速率限制冷却期。
   *
   * 借鉴 hermes-agent nous_rate_limit_remaining：
   *   返回剩余冷却毫秒数，0 表示可以继续。
   */
  getRemainingCooldown(provider: string): number {
    this.ensureCacheLoaded();
    const state = this.cache.get(provider);
    if (!state) return 0;

    const now = Date.now();

    // 检查状态是否过期
    if (now - state.recordedAt > this.config.stateTtlMs) {
      this.cache.delete(provider);
      this.deleteState(provider);
      return 0;
    }

    // 检查是否已过重置时间
    if (now >= state.resetAt) {
      this.cache.delete(provider);
      this.deleteState(provider);
      return 0;
    }

    return state.resetAt - now;
  }

  /**
   * 检查是否应该跳过请求（仍在冷却期）。
   */
  shouldSkipRequest(provider: string): boolean {
    return this.getRemainingCooldown(provider) > 0;
  }

  /**
   * 区分账号配额耗尽 vs 上游瞬时容量不足。
   *
   * 借鉴 hermes-agent is_genuine_nous_rate_limit：
   *   - resetSeconds >= minResetForBreakerSeconds → 真正的配额耗尽
   *   - resetSeconds < minResetForBreakerSeconds → 瞬时容量不足（可重试）
   */
  isGenuineRateLimit(resetSeconds: number, statusCode: number): boolean {
    // 非 429 状态码不算配额耗尽
    if (statusCode !== 429) return false;

    // 重置时间短于阈值，视为瞬时
    if (resetSeconds < this.config.minResetForBreakerSeconds) {
      return false;
    }

    return true;
  }

  /**
   * 清除指定 provider 的速率限制状态。
   */
  clearRateLimit(provider: string): void {
    this.cache.delete(provider);
    this.deleteState(provider);
  }

  /**
   * 清除所有速率限制状态。
   */
  clearAll(): void {
    for (const provider of this.cache.keys()) {
      this.deleteState(provider);
    }
    this.cache.clear();
  }

  /**
   * 获取所有活跃的速率限制状态。
   */
  getAllStates(): CrossSessionRateLimitState[] {
    this.ensureCacheLoaded();
    const now = Date.now();
    const active: CrossSessionRateLimitState[] = [];
    for (const [provider, state] of this.cache.entries()) {
      if (now < state.resetAt && now - state.recordedAt < this.config.stateTtlMs) {
        active.push(state);
      } else {
        // 过期，清理
        this.cache.delete(provider);
        this.deleteState(provider);
      }
    }
    return active;
  }

  // ── 内部方法 ──

  private ensureCacheLoaded(): void {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;

    try {
      if (!existsSync(this.stateDir)) return;
      const { readdirSync } = require("fs") as typeof import("fs");
      for (const file of readdirSync(this.stateDir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const filePath = join(this.stateDir, file);
          const content = readFileSync(filePath, "utf8");
          const state = JSON.parse(content) as CrossSessionRateLimitState;
          if (state && state.provider) {
            this.cache.set(state.provider, state);
          }
        } catch {
          // 跳过损坏的文件
        }
      }
    } catch {
      // 目录不存在或无法访问
    }
  }

  private saveState(provider: string, state: CrossSessionRateLimitState): void {
    const filePath = this.getStatePath(provider);
    try {
      atomicWriteFile(filePath, JSON.stringify(state, null, 2));
    } catch {
      // 写入失败不影响主流程
    }
  }

  private deleteState(provider: string): void {
    const filePath = this.getStatePath(provider);
    try {
      const { unlinkSync } = require("fs") as typeof import("fs");
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch {
      // 删除失败不影响主流程
    }
  }

  private getStatePath(provider: string): string {
    // 安全的文件名：替换非字母数字字符
    const safeName = provider.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.stateDir, `${safeName}.json`);
  }
}

// ── 单例 ────────────────────────────────────────────────────────────────────

let singleton: CrossSessionRateGuard | null = null;

export function getCrossSessionRateGuard(config?: Partial<RateGuardConfig>): CrossSessionRateGuard {
  if (!singleton) {
    singleton = new CrossSessionRateGuard(config);
  }
  return singleton;
}

export function resetCrossSessionRateGuard(): void {
  singleton = null;
}
