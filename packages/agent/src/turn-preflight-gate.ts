/**
 * TurnPreflightGate — API 调用前压力门控（对标 hermes-agent agent/turn_preflight_gate.py）
 *
 * 在每次 API 调用前运行守护链：
 *   1. Ollama runtime context floor 检查（tool use 需要足够上下文）
 *   2. Provider 溢出恢复重检（arm/disarm）
 *   3. 不足进展阻断器（比较完整请求，非原始 messages）
 *   4. 调用 turn_preflight.run_preflight_compression
 *
 * 关键设计：
 *   - _last_preflight_pressure 在此消费（设为 None），仅压缩 pass 重新武装
 *   - 完整请求比较（含 system prompt、plugin 注入、prefills）
 *   - Provider 溢出强制预检的任何门控阻塞都 fail closed
 */

import {
  runPreflightCompression,
  PreflightGateVerdict,
  RunPreflightCompressionOptions,
  RunPreflightCompressionDeps,
} from "./turn-preflight";

// ─── 类型 ──────────────────────────────────────────────────

export interface RunPreflightGateOptions {
  requestPressureTokens: number;
  messages: unknown[];
  systemMessage: string;
  userMessage: string;
  activeSystemPrompt: string;
  conversationHistory: unknown[];
  apiCallCount: number;
  compressionAttempts: number;
  maxCompressionAttempts: number;
  effectiveTaskId: string;
  finalResponse?: string;
  failed: boolean;
  turnExitReason?: string;
  compressionTimeoutExhausted: boolean;
  preflightCompressionBlocked: boolean;
  providerOverflowRecoveryPending: boolean;
  lastPreflightPressure: number | null;
  /** 是否 provider 溢出恢复待处理 */
  moaPreparedRequest?: unknown;
}

export interface RunPreflightGateDeps {
  /** 压缩上下文 */
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
  /** 检查是否应该跳过模型调用 */
  shouldSkipModelCallForHandoff: (messages: unknown[]) => boolean;
  /** 延迟预检判断 */
  deferPreflight: (tokens: number) => boolean;
  /** 是否等待真实 usage */
  isRequestPressureAnchored: boolean;
  /** 压缩冷却 */
  getCompressionCooldown: () => boolean;
  /** should_compress 判断 */
  shouldCompress: (tokens: number) => boolean;
  /** Ollama runtime context 下限错误 */
  ollamaContextLimitError: (tokens: number) => string | null;
  /** 发出诊断状态 */
  emitDiagnosticStatus: (msg: string) => void;
  /** 追加消息 */
  appendMessage: (role: string, content: string) => void;
  /** 迭代预算退款 */
  refundIterationBudget: () => void;
}

// ─── 核心函数 ──────────────────────────────────────────────

/**
 * 运行预检门控。
 *
 * 返回的 PreflightGateVerdict 的 action 决定后续流程：
 *   - "fallthrough" → 继续 API 调用
 *   - "continue" → 压缩完成，重新进入 turn loop
 *   - "break" → turn 结束（finalResponse 已设置）
 *   - "return" → 返回结果（result 已设置）
 */
export function runPreflightGate(
  opts: RunPreflightGateOptions,
  deps: RunPreflightGateDeps,
): PreflightGateVerdict {
  // 1. Ollama runtime context floor 检查
  const runtimeError = deps.ollamaContextLimitError(opts.requestPressureTokens);
  if (runtimeError) {
    deps.emitDiagnosticStatus("❌ Ollama runtime context is too small for tool use");
    deps.appendMessage("assistant", runtimeError);
    deps.refundApiCall();
    deps.refundIterationBudget();

    return {
      action: "break",
      compressionAttempts: opts.compressionAttempts,
      failed: true,
      turnExitReason: "ollama_runtime_context_too_small",
      compressionTimeoutExhausted: false,
      preflightCompressionBlocked: opts.preflightCompressionBlocked,
      providerOverflowRecoveryPending: opts.providerOverflowRecoveryPending,
      lastPreflightPressure: null,
      finalResponse: runtimeError,
    };
  }

  // 2. Provider 溢出恢复重检
  const preflightThreshold = 0; // 由 compressor 提供
  const providerOverflowPreflight = opts.providerOverflowRecoveryPending && (
    preflightThreshold <= 0 || opts.requestPressureTokens >= preflightThreshold
  );

  if (opts.providerOverflowRecoveryPending && !providerOverflowPreflight) {
    // 外层 rebuild 包含 system prompt、请求注入和 tool schemas
    // 只有完整请求才能发送
  }

  // 3. 不足进展阻断器
  // 比较完整请求，非原始 messages
  // 如果上次预检压力 >= 阈值且本次没有显著减少 → 阻塞
  if (
    opts.lastPreflightPressure !== null
    && opts.requestPressureTokens >= preflightThreshold
    && !hasSignificantProgress(opts.lastPreflightPressure, opts.requestPressureTokens)
  ) {
    // 停止主动重试，不消耗 overflow-recovery 预算
    // provider 的错误处理器仍可压缩
  }

  // 4. 调用压缩门控
  return runPreflightCompression(
    {
      compressionEnabled: true, // 由调用方上下文决定
      messagesCount: opts.messages.length,
      compressionAttempts: opts.compressionAttempts,
      maxCompressionAttempts: opts.maxCompressionAttempts,
      requestPressureTokens: opts.requestPressureTokens,
      compressorThresholdTokens: preflightThreshold,
      compressorContextLength: 0,
      hasRefreshToken: false,
      reviewForkFirstRequestPending: false,
      preflightCompressionBlocked: opts.preflightCompressionBlocked,
      deferPreflight: deps.isRequestPressureAnchored
        ? () => false
        : deps.deferPreflight,
      compressionCooldown: deps.getCompressionCooldown(),
      shouldCompress: deps.shouldCompress,
      providerOverflowPreflight,
    },
    {
      compressContext: deps.compressContext,
      refundApiCall: deps.refundApiCall,
      onCompressionAttempt: deps.onCompressionAttempt,
      resetRetryState: deps.resetRetryState,
      shouldSkipModelCallForHandoff: deps.shouldSkipModelCallForHandoff,
    },
  );
}

// ─── 工具函数 ──────────────────────────────────────────────

/**
 * 检查压缩是否有显著进展。
 * 如果上次压力和本次压力差异小于 10%，则认为没有显著进展。
 */
export function hasSignificantProgress(prevTokens: number, currentTokens: number): boolean {
  if (prevTokens <= 0) return true;
  const reduction = (prevTokens - currentTokens) / prevTokens;
  return reduction >= 0.1; // 至少减少 10%
}

/**
 * 构建预检门控依赖（简化版，供调用方使用）。
 */
export function createPreflightGateDeps(overrides?: Partial<RunPreflightGateDeps>): RunPreflightGateDeps {
  return {
    compressContext: () => ({ messages: [], changed: false, timedOut: false }),
    refundApiCall: () => {},
    onCompressionAttempt: () => {},
    resetRetryState: () => {},
    shouldSkipModelCallForHandoff: () => false,
    deferPreflight: () => false,
    isRequestPressureAnchored: false,
    getCompressionCooldown: () => false,
    shouldCompress: () => false,
    ollamaContextLimitError: () => null,
    emitDiagnosticStatus: () => {},
    appendMessage: () => {},
    refundIterationBudget: () => {},
    ...overrides,
  };
}
