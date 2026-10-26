/**
 * TurnPreflight — API 调用前的压缩门控 + 工具后压缩决策（对标 hermes-agent agent/turn_preflight.py）
 *
 * 在每次 API 调用前测量请求压力后运行：
 *   1. 延迟压缩（noisy estimate 时等待真实 usage）
 *   2. 失败冷却跳过（summary-LLM 冷却期间不压缩）
 *   3. should_compress 判断（超过阈值时压缩）
 *   4. 压缩后退款（api_call_count 不因压缩而虚增）
 *   5. 压缩超时终态（progress-aware timeout，退款并停止）
 *   6. 阻塞去重警告（cooldown/lock 时发去重警告）
 *   7. 工具后压缩（prompt_tokens 压力 + 工具结果裁剪）
 *
 * 设计原则：
 *   - 压缩路径永不到达 provider → 必须退款（否则 api_call_count 虚增）
 *   - 锁/临时阻塞 → 退款 + 保留 progress blocker
 *   - Provider 溢出强制压缩 → 任何门控阻塞都 fail closed（llama.cpp 可能静默截断）
 */

// ─── 类型 ──────────────────────────────────────────────────

export type PreflightAction =
  | "fallthrough"    // 直接调用 API
  | "continue"       // 窗口扩展或压缩完成，重新进入 turn loop
  | "break"          // turn 结束（压缩超时或不可操作的 compaction handoff）
  | "return";        // 返回结果（provider 溢出恢复耗尽等）

export interface PreflightGateVerdict {
  action: PreflightAction;
  /** 压缩尝试次数 */
  compressionAttempts: number;
  /** 是否失败 */
  failed: boolean;
  /** 最终响应（break/return 时设置） */
  finalResponse?: string;
  /** turn 退出原因 */
  turnExitReason?: string;
  /** 是否压缩超时耗尽 */
  compressionTimeoutExhausted: boolean;
  /** 是否预检压缩被阻塞 */
  preflightCompressionBlocked: boolean;
  /** 是否 provider 溢出恢复待处理 */
  providerOverflowRecoveryPending: boolean;
  /** 上次预检压力（仅压缩 pass 重新武装） */
  lastPreflightPressure: number | null;
  /** 返回结果（return 时设置） */
  result?: Record<string, unknown>;
}

export interface CompressAfterToolResultVerdict {
  /** 是否结束 turn（reference-only handoff 不可操作） */
  endTurn: boolean;
  /** 压缩尝试次数 */
  compressionAttempts: number;
  /** 最终响应 */
  finalResponse?: string;
  /** turn 退出原因 */
  turnExitReason?: string;
}

export interface RunPreflightCompressionOptions {
  compressionEnabled: boolean;
  messagesCount: number;
  compressionAttempts: number;
  maxCompressionAttempts: number;
  requestPressureTokens: number;
  compressorThresholdTokens: number;
  compressorContextLength: number;
  hasRefreshToken: boolean;
  reviewForkFirstRequestPending: boolean;
  preflightCompressionBlocked: boolean;
  deferPreflight: (tokens: number) => boolean;
  compressionCooldown: boolean;
  shouldCompress: (tokens: number) => boolean;
  /** 是否 provider 溢出强制预检 */
  providerOverflowPreflight: boolean;
}

export interface RunPreflightCompressionDeps {
  /** 压缩上下文（返回新的 messages） */
  compressContext: () => {
    messages: unknown[];
    changed: boolean;
    timedOut: boolean;
  };
  /** 退款 api_call_count */
  refundApiCall: () => void;
  /** 记录压缩尝试 */
  onCompressionAttempt: (attempt: number, maxAttempts: number, tokens: number, threshold: number) => void;
  /** 重置重试状态 */
  resetRetryState: () => void;
  /** 检查是否应该跳过模型调用（reference-only handoff） */
  shouldSkipModelCallForHandoff: (messages: unknown[]) => boolean;
}

// ─── 常量 ──────────────────────────────────────────────────

export const COMPRESSION_TIMEOUT_FINAL_RESPONSE =
  "⚠️ **Context compression timed out.** The conversation history was too large " +
  "to compress within the time limit.\n\n" +
  "→ Start a new session with `/new`";

export const HANDOFF_SKIP_FINAL_RESPONSE =
  "ℹ️ This message was a reference handoff — no further action was needed.";

// ─── 核心函数 ──────────────────────────────────────────────

/**
 * 运行预检压缩门控。
 *
 * 决策链：
 *   1. 无压缩资格（禁用 / 单消息 / 达到上限）→ 跳过
 *   2. 延迟压缩（noisy estimate）→ fallthrough
 *   3. 失败冷却 → 跳过
 *   4. should_compress → 压缩
 *   5. 压缩后退款 + 继续
 *   6. 压缩超时 → break
 *   7. 锁/临时阻塞 → 退款 + fallthrough
 *   8. Provider 溢出 + 压缩被阻塞 → fail closed
 */
export function runPreflightCompression(
  opts: RunPreflightCompressionOptions,
  deps: RunPreflightCompressionDeps,
): PreflightGateVerdict {
  const verdict: PreflightGateVerdict = {
    action: "fallthrough",
    compressionAttempts: opts.compressionAttempts,
    failed: false,
    compressionTimeoutExhausted: false,
    preflightCompressionBlocked: opts.preflightCompressionBlocked,
    providerOverflowRecoveryPending: opts.providerOverflowPreflight,
    lastPreflightPressure: null,
  };

  const eligible = (
    opts.compressionEnabled
    && opts.messagesCount > 1
    && verdict.compressionAttempts < opts.maxCompressionAttempts
  );

  if (eligible
    && !opts.reviewForkFirstRequestPending
    && (!verdict.preflightCompressionBlocked || opts.providerOverflowPreflight)
    && (!opts.deferPreflight(opts.requestPressureTokens) || opts.providerOverflowPreflight)
    && !opts.compressionCooldown
    && opts.shouldCompress(opts.requestPressureTokens)
  ) {
    // 执行压缩
    verdict.compressionAttempts += 1;
    verdict.lastPreflightPressure = opts.requestPressureTokens;

    deps.onCompressionAttempt(
      verdict.compressionAttempts,
      opts.maxCompressionAttempts,
      opts.requestPressureTokens,
      opts.compressorThresholdTokens,
    );

    const result = deps.compressContext();

    if (result.timedOut) {
      // 压缩超时：退款 + break
      deps.refundApiCall();
      verdict.action = "break";
      verdict.failed = true;
      verdict.compressionTimeoutExhausted = true;
      verdict.turnExitReason = "context_compression_timeout";
      verdict.finalResponse = COMPRESSION_TIMEOUT_FINAL_RESPONSE;
      return verdict;
    }

    if (result.changed) {
      // 压缩成功：退款 + 继续
      deps.refundApiCall();
      deps.resetRetryState();

      // 检查 reference-only handoff
      if (deps.shouldSkipModelCallForHandoff(result.messages)) {
        verdict.action = "break";
        verdict.turnExitReason = "compaction_handoff_not_actionable";
        verdict.finalResponse = HANDOFF_SKIP_FINAL_RESPONSE;
        return verdict;
      }

      verdict.action = "continue";
      return verdict;
    }

    // 压缩未改变 messages（锁/临时阻塞）：退款 + fallthrough
    deps.refundApiCall();
    verdict.compressionAttempts -= 1;
    verdict.lastPreflightPressure = null;
    verdict.action = "fallthrough";
    return verdict;
  }

  // Provider 溢出 + 压缩冷却 → fail closed
  if (opts.providerOverflowPreflight && opts.compressionCooldown) {
    verdict.action = "return";
    verdict.result = {
      error: "compression_deferred",
      reason: "transient_block",
    };
    return verdict;
  }

  // Provider 溢出 + 压缩耗尽 → fail closed
  if (opts.providerOverflowPreflight && verdict.compressionAttempts >= opts.maxCompressionAttempts) {
    verdict.action = "return";
    verdict.result = {
      error: "compression_exhausted",
      tokens: opts.requestPressureTokens,
    };
    return verdict;
  }

  // Provider 溢出 + 其他门控阻塞 → fail closed
  if (opts.providerOverflowPreflight) {
    verdict.action = "return";
    verdict.result = {
      error: "compression_exhausted",
      tokens: opts.requestPressureTokens,
    };
    return verdict;
  }

  // 无压缩资格 + 超过 context window → 去重警告
  if (!opts.compressionEnabled && opts.messagesCount > 1) {
    if (opts.compressorContextLength > 0 && opts.requestPressureTokens > opts.compressorContextLength) {
      // 由调用方发出去重警告
    }
  }

  return verdict;
}

/**
 * 工具后压缩决策。
 *
 * 压力来源：API 报告的 prompt_tokens（紧下界）→ last_prompt_tokens → 粗略估算。
 * 超过阈值但被阻塞 → 去重警告 + 工具结果裁剪。
 */
export function compressAfterToolResults(
  opts: {
    compressionEnabled: boolean;
    compressionAttempts: number;
    maxCompressionAttempts: number;
    realTokens: number;
    compressorThresholdTokens: number;
    awaitingRealUsageAfterCompression: boolean;
    shouldCompress: (tokens: number) => boolean;
  },
  deps: {
    compressContext: () => {
      messages: unknown[];
      changed: boolean;
    };
    refundApiCall: () => void;
    resetRetryState: () => void;
    shouldSkipModelCallForHandoff: (messages: unknown[]) => boolean;
    warnContextOverflowBlocked: (reason: string, tokens: number, threshold: number) => void;
    pruneToolResults: (messages: unknown[], currentTokens: number) => {
      messages: unknown[];
      count: number;
    };
    onPrune: (original: unknown[], pruned: unknown[], count: number) => void;
  },
): CompressAfterToolResultVerdict {
  const verdict: CompressAfterToolResultVerdict = {
    endTurn: false,
    compressionAttempts: opts.compressionAttempts,
  };

  // 等待真实 usage：新的 checkpoint 必须到达 provider
  if (opts.awaitingRealUsageAfterCompression) {
    return verdict;
  }

  if (opts.compressionEnabled && verdict.compressionAttempts < opts.maxCompressionAttempts) {
    if (opts.shouldCompress(opts.realTokens)) {
      verdict.compressionAttempts += 1;
      const result = deps.compressContext();

      if (result.changed) {
        deps.resetRetryState();

        if (deps.shouldSkipModelCallForHandoff(result.messages)) {
          verdict.endTurn = true;
          verdict.turnExitReason = "compaction_handoff_not_actionable";
          verdict.finalResponse = HANDOFF_SKIP_FINAL_RESPONSE;
          return verdict;
        }
      } else {
        // 锁跳过：退款
        verdict.compressionAttempts -= 1;
      }
    } else {
      // 超过阈值但压缩被阻塞
      deps.warnContextOverflowBlocked(
        "compression_cooldown",
        opts.realTokens,
        opts.compressorThresholdTokens,
      );

      // 工具结果裁剪
      const pruned = deps.pruneToolResults([], opts.realTokens);
      if (pruned.count > 0) {
        deps.onPrune([], pruned.messages, pruned.count);
      }
    }
  }

  return verdict;
}
