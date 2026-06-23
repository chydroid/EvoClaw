/**
 * StreamingRecoveryManager — 流式响应中断恢复管理器
 *
 * 借鉴 hermes-agent agent/conversation_loop.py（lines 4080-4119）：
 *
 * 核心机制：
 *   流式响应可能因网络中断、服务器超时、输出截断等原因中断。
 *   本模块提供多策略恢复，优先使用已交付内容，避免浪费 API 调用。
 *
 * 恢复策略（按优先级）：
 *   1. partial_stream_recovery — 使用已交付的流内容作为最终响应
 *   2. truncated_tool_call_retries — 流中断 mid tool-call 时重试（最多 3 次）
 *   3. length_continue_retries — 输出截断时请求 continuation
 *   4. thinking_prefill_retries — thinking-only 响应的 prefill continuation
 *   5. post_tool_empty_retried — 工具调用后空响应的 nudge 重试
 *   6. housekeeping_fallback — housekeeping 工具回退（memory save 后无更多内容）
 *
 * 关键设计：
 *   - PARTIAL_STREAM_STUB_ID 标识流中断 stub 响应
 *   - _has_content_after_think_block 检查 thinking 块后是否有实质内容
 *   - housekeeping 工具识别（memory、todo 等）
 */

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface StreamRecoveryContext {
  /** 已交付的部分流文本 */
  partialText: string;
  /** 是否在 thinking 块中中断 */
  interruptedInThinking: boolean;
  /** 是否在 tool-call 中中断 */
  interruptedInToolCall: boolean;
  /** 是否因 length 限制截断 */
  truncatedByLength: boolean;
  /** 本 turn 调用的工具名称列表 */
  toolCallsThisTurn: string[];
  /** 是否已有 turn 级内容交付 */
  hasPriorTurnContent: boolean;
  /** 重试次数 */
  retryCount: number;
}

export interface StreamRecoveryResult {
  /** 恢复策略名称 */
  strategy: string;
  /** 恢复后的响应文本 */
  response: string;
  /** 是否应该重试 */
  shouldRetry: boolean;
  /** 是否使用已交付内容 */
  usedPartialContent: boolean;
  /** 是否需要 continuation 请求 */
  needsContinuation: boolean;
  /** 诊断信息 */
  diagnostics: Record<string, unknown>;
}

export interface StreamingRecoveryConfig {
  /** truncated_tool_call 最大重试次数 */
  maxTruncatedToolCallRetries: number;
  /** length_continue 最大重试次数 */
  maxLengthContinueRetries: number;
  /** thinking_prefill 最大重试次数 */
  maxThinkingPrefillRetries: number;
  /** post_tool_empty 最大重试次数 */
  maxPostToolEmptyRetries: number;
}

export const DEFAULT_STREAMING_RECOVERY_CONFIG: StreamingRecoveryConfig = {
  maxTruncatedToolCallRetries: 3,
  maxLengthContinueRetries: 3,
  maxThinkingPrefillRetries: 2,
  maxPostToolEmptyRetries: 2,
};

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 流中断 stub 响应 ID */
export const PARTIAL_STREAM_STUB_ID = "partial-stream-stub";

/** housekeeping 工具集合（无实质副作用，仅记忆/记录） */
const HOUSEKEEPING_TOOLS = new Set([
  "memory", "save_memory", "remember", "forget",
  "todo", "add_todo", "update_todo", "complete_todo",
  "note", "take_note",
  "session_save", "save_session",
  "bookmark", "tag",
]);

// ── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 检查 thinking 块后是否有实质内容。
 * 借鉴 hermes-agent _has_content_after_think_block。
 */
export function hasContentAfterThinkBlock(text: string): boolean {
  if (!text) return false;

  // Anthropic thinking 块格式：<think>...</think> 或 { type: "thinking" }
  // 这里检查文本中 thinking 块结束后是否有非空白内容
  const thinkEndPatterns = [
    /<\/think>\s*\S/,
    /<\/thinking>\s*\S/,
  ];

  for (const pattern of thinkEndPatterns) {
    if (pattern.test(text)) return true;
  }

  // 如果没有 thinking 块，检查是否有任何非空白内容
  if (!text.includes("<think") && !text.includes("<thinking")) {
    return text.trim().length > 0;
  }

  return false;
}

/**
 * 剥离 thinking 块。
 * 借鉴 hermes-agent _strip_think_blocks。
 */
export function stripThinkBlocks(text: string): string {
  if (!text) return "";

  // 剥离 <think>...</think>
  let result = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // 剥离 <thinking>...</thinking>
  result = result.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  // 剥离未闭合的 thinking 块（中断时可能发生）
  result = result.replace(/<think>[\s\S]*$/gi, "");
  result = result.replace(/<thinking>[\s\S]*$/gi, "");

  return result.trim();
}

/**
 * 检查工具是否为 housekeeping 工具。
 */
function isHousekeepingTool(toolName: string): boolean {
  if (!toolName) return false;
  return HOUSEKEEPING_TOOLS.has(toolName.toLowerCase());
}

/**
 * 检查本 turn 所有工具是否都是 housekeeping 工具。
 */
function allToolsAreHousekeeping(toolNames: string[]): boolean {
  if (!toolNames || toolNames.length === 0) return false;
  return toolNames.every(isHousekeepingTool);
}

// ── 主类 ────────────────────────────────────────────────────────────────────

/**
 * 流式响应中断恢复管理器。
 *
 * 借鉴 hermes-agent agent/conversation_loop.py 的流式恢复策略。
 */
export class StreamingRecoveryManager {
  private config: StreamingRecoveryConfig;
  private retryCounters: Map<string, number> = new Map();

  constructor(config: Partial<StreamingRecoveryConfig> = {}) {
    this.config = { ...DEFAULT_STREAMING_RECOVERY_CONFIG, ...config };
  }

  /**
   * 执行流式恢复。
   *
   * 借鉴 hermes-agent conversation_loop.py lines 4080-4119 的多策略恢复。
   *
   * @param ctx 恢复上下文
   */
  recover(ctx: StreamRecoveryContext): StreamRecoveryResult {
    // 策略 1: partial_stream_recovery
    // 如果已交付内容在 thinking 块后有实质内容，直接使用
    if (hasContentAfterThinkBlock(ctx.partialText)) {
      const recovered = stripThinkBlocks(ctx.partialText);
      if (recovered.length > 0) {
        return {
          strategy: "partial_stream_recovery",
          response: recovered,
          shouldRetry: false,
          usedPartialContent: true,
          needsContinuation: false,
          diagnostics: {
            partialChars: ctx.partialText.length,
            recoveredChars: recovered.length,
            stubId: PARTIAL_STREAM_STUB_ID,
          },
        };
      }
    }

    // 策略 2: truncated_tool_call_retries
    // 流中断 mid tool-call 时重试
    if (ctx.interruptedInToolCall) {
      const retryKey = "truncated_tool_call";
      const count = this.retryCounters.get(retryKey) ?? 0;
      if (count < this.config.maxTruncatedToolCallRetries) {
        this.retryCounters.set(retryKey, count + 1);
        return {
          strategy: "truncated_tool_call_retries",
          response: "",
          shouldRetry: true,
          usedPartialContent: false,
          needsContinuation: false,
          diagnostics: {
            retryCount: count + 1,
            maxRetries: this.config.maxTruncatedToolCallRetries,
          },
        };
      }
    }

    // 策略 3: length_continue_retries
    // 输出因 length 限制截断时请求 continuation
    if (ctx.truncatedByLength) {
      const retryKey = "length_continue";
      const count = this.retryCounters.get(retryKey) ?? 0;
      if (count < this.config.maxLengthContinueRetries) {
        this.retryCounters.set(retryKey, count + 1);
        return {
          strategy: "length_continue_retries",
          response: ctx.partialText, // 保留已生成内容，请求 continuation
          shouldRetry: true,
          usedPartialContent: false,
          needsContinuation: true,
          diagnostics: {
            retryCount: count + 1,
            maxRetries: this.config.maxLengthContinueRetries,
            partialChars: ctx.partialText.length,
          },
        };
      }
    }

    // 策略 4: thinking_prefill_retries
    // thinking-only 响应（无 text 内容）的 prefill continuation
    if (ctx.interruptedInThinking && !hasContentAfterThinkBlock(ctx.partialText)) {
      const retryKey = "thinking_prefill";
      const count = this.retryCounters.get(retryKey) ?? 0;
      if (count < this.config.maxThinkingPrefillRetries) {
        this.retryCounters.set(retryKey, count + 1);
        return {
          strategy: "thinking_prefill_retries",
          response: "",
          shouldRetry: true,
          usedPartialContent: false,
          needsContinuation: true,
          diagnostics: {
            retryCount: count + 1,
            maxRetries: this.config.maxThinkingPrefillRetries,
          },
        };
      }
    }

    // 策略 5: post_tool_empty_retried
    // 工具调用后空响应的 nudge 重试
    if (ctx.toolCallsThisTurn.length > 0 && !ctx.partialText.trim()) {
      const retryKey = "post_tool_empty";
      const count = this.retryCounters.get(retryKey) ?? 0;
      if (count < this.config.maxPostToolEmptyRetries) {
        this.retryCounters.set(retryKey, count + 1);
        return {
          strategy: "post_tool_empty_retried",
          response: "",
          shouldRetry: true,
          usedPartialContent: false,
          needsContinuation: false,
          diagnostics: {
            retryCount: count + 1,
            maxRetries: this.config.maxPostToolEmptyRetries,
            toolsCalled: ctx.toolCallsThisTurn,
          },
        };
      }
    }

    // 策略 6: housekeeping_fallback
    // 如果上一 turn 已交付真实内容 + 本 turn 只有 housekeeping 工具调用
    // 模型可能已说完话，只是保存了 memory
    if (ctx.hasPriorTurnContent && allToolsAreHousekeeping(ctx.toolCallsThisTurn)) {
      return {
        strategy: "housekeeping_fallback",
        response: ctx.partialText || "[task completed]",
        shouldRetry: false,
        usedPartialContent: true,
        needsContinuation: false,
        diagnostics: {
          housekeepingTools: ctx.toolCallsThisTurn,
          hasPriorContent: ctx.hasPriorTurnContent,
        },
      };
    }

    // 兜底：如果有部分内容，使用它
    if (ctx.partialText.trim().length > 0) {
      const recovered = stripThinkBlocks(ctx.partialText);
      if (recovered.length > 0) {
        return {
          strategy: "fallback_partial_content",
          response: recovered,
          shouldRetry: false,
          usedPartialContent: true,
          needsContinuation: false,
          diagnostics: {
            partialChars: ctx.partialText.length,
            recoveredChars: recovered.length,
          },
        };
      }
    }

    // 最终兜底：无法恢复
    return {
      strategy: "unrecoverable",
      response: "[stream interrupted and could not be recovered]",
      shouldRetry: false,
      usedPartialContent: false,
      needsContinuation: false,
      diagnostics: {
        partialTextLength: ctx.partialText.length,
        interruptedInThinking: ctx.interruptedInThinking,
        interruptedInToolCall: ctx.interruptedInToolCall,
        truncatedByLength: ctx.truncatedByLength,
      },
    };
  }

  /**
   * 重置重试计数器（新 turn 开始时调用）。
   */
  resetTurn(): void {
    this.retryCounters.clear();
  }

  /**
   * 获取重试计数。
   */
  getRetryCount(strategy: string): number {
    return this.retryCounters.get(strategy) ?? 0;
  }

  /**
   * 更新配置。
   */
  updateConfig(config: Partial<StreamingRecoveryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取配置。
   */
  getConfig(): StreamingRecoveryConfig {
    return { ...this.config };
  }
}

// ── 单例 ────────────────────────────────────────────────────────────────────

let singleton: StreamingRecoveryManager | null = null;

export function getStreamingRecoveryManager(config?: Partial<StreamingRecoveryConfig>): StreamingRecoveryManager {
  if (!singleton) {
    singleton = new StreamingRecoveryManager(config);
  } else if (config) {
    singleton.updateConfig(config);
  }
  return singleton;
}

export function resetStreamingRecoveryManager(): void {
  singleton = null;
}
