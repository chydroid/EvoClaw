/**
 * ErrorRecoveryExecutor — 错误恢复执行分支
 *
 * 借鉴 hermes-agent agent/conversation_loop.py（lines 2200-3400）的 20+ FailoverReason 恢复分支：
 *
 * 核心设计：
 *   - 每个 FailoverReason 对应一个具体的恢复动作（不只是分类）
 *   - TurnRetryState 一次性守卫：同一 turn 内每种恢复动作只执行一次
 *   - 恢复动作实际修改消息/上下文，而非仅返回建议
 *
 * 恢复动作分类：
 *   1. 消息修改类：strip_thinking_blocks、strip_replay_blob、shrink_image、
 *      downgrade_multimodal_tool_content、strip_invalid_fields
 *   2. 上下文压缩类：trigger_compaction（context_overflow、long_context_tier、payload_too_large）
 *   3. 不可恢复类：直接 failover（auth、billing、model_not_found、content_policy_blocked）
 *   4. 简单重试类：rate_limit、overloaded、timeout、network、server_error
 *
 * TurnRetryState 守卫防止无限循环：
 *   - 例如：strip_thinking_blocks 已执行后，再次遇到 thinking_signature 不再剥离
 *   - 此时应该 failover 到下一个 provider
 */

import type { FailoverReason } from "./failover-policy";

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface RecoveryMessage {
  role: string;
  content: string | unknown[] | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  name?: string;
}

export interface RecoveryContext {
  /** 当前消息列表 */
  messages: RecoveryMessage[];
  /** 失败原因 */
  reason: FailoverReason;
  /** 错误文本（可选，用于诊断） */
  errorText?: string;
  /** HTTP 状态码（可选） */
  statusCode?: number;
  /** 当前 provider ID */
  providerId?: string;
  /** 是否允许 failover */
  allowFailover: boolean;
}

export interface RecoveryResult {
  /** 是否执行了恢复动作 */
  recovered: boolean;
  /** 修改后的消息列表 */
  messages: RecoveryMessage[];
  /** 恢复动作描述 */
  action?: string;
  /** 是否应该 failover 到下一个 provider */
  shouldFailover: boolean;
  /** 是否应该重试当前 provider */
  shouldRetry: boolean;
  /** 重试前等待的毫秒数 */
  retryDelayMs?: number;
  /** 诊断信息 */
  diagnostics?: Record<string, unknown>;
}

/**
 * TurnRetryState — 一次性守卫
 *
 * 借鉴 hermes-agent TurnRetryState：
 *   - 跟踪当前 turn 内已执行的恢复动作
 *   - 防止同种恢复动作重复执行
 *   - 在新 turn 开始时重置
 */
export class TurnRetryState {
  private executedActions = new Set<string>();
  private retryCount = 0;
  private readonly maxRetries: number;

  constructor(maxRetries: number = 3) {
    this.maxRetries = maxRetries;
  }

  /** 检查动作是否已执行 */
  hasExecuted(action: string): boolean {
    return this.executedActions.has(action);
  }

  /** 标记动作已执行 */
  markExecuted(action: string): void {
    this.executedActions.add(action);
  }

  /** 检查并标记（原子操作）：如果未执行则标记并返回 true */
  checkAndMark(action: string): boolean {
    if (this.executedActions.has(action)) return false;
    this.executedActions.add(action);
    return true;
  }

  /** 增加重试计数，返回是否还有重试预算 */
  consumeRetry(): boolean {
    if (this.retryCount >= this.maxRetries) return false;
    this.retryCount++;
    return true;
  }

  /** 当前重试次数 */
  getRetryCount(): number {
    return this.retryCount;
  }

  /** 重试预算是否耗尽 */
  isRetryExhausted(): boolean {
    return this.retryCount >= this.maxRetries;
  }

  /** 重置（新 turn 开始时调用） */
  reset(): void {
    this.executedActions.clear();
    this.retryCount = 0;
  }

  /** 已执行的动作列表（用于诊断） */
  getExecutedActions(): string[] {
    return Array.from(this.executedActions);
  }
}

// ── 恢复动作实现 ────────────────────────────────────────────────────────────

/**
 * 剥离 Anthropic thinking 块。
 *
 * 借鉴 hermes-agent _strip_thinking_blocks：
 *   thinking 块格式：{ type: "thinking", thinking: "...", signature: "..." }
 *   剥离后保留 text 块。
 */
function stripThinkingBlocks(messages: RecoveryMessage[]): RecoveryMessage[] {
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;

    const newContent = msg.content.filter((block: unknown) => {
      if (typeof block !== "object" || block === null) return true;
      const b = block as Record<string, unknown>;
      // 保留非 thinking 块
      if (b.type === "thinking") return false;
      // 也过滤 thinking_signature 块
      if (b.type === "redacted_thinking") return false;
      return true;
    });

    return { ...msg, content: newContent };
  });
}

/**
 * 剥离 Responses API replay blob（invalid_encrypted_content）。
 *
 * 借鉴 hermes-agent _strip_replay_blob：
 *   移除消息中的 encrypted_content 字段。
 */
function stripReplayBlob(messages: RecoveryMessage[]): RecoveryMessage[] {
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;

    const newContent = msg.content.map((block: unknown) => {
      if (typeof block !== "object" || block === null) return block;
      const b = block as Record<string, unknown>;
      if (b.type === "encrypted_content") return null;
      // 移除对象中的 encrypted_content 字段
      if ("encrypted_content" in b) {
        const { encrypted_content: _, ...rest } = b as Record<string, unknown> & { encrypted_content: unknown };
        return rest;
      }
      return block;
    }).filter((b) => b !== null);

    return { ...msg, content: newContent };
  });
}

/**
 * 缩小图片尺寸（image_too_large）。
 *
 * 借鉴 hermes-agent _shrink_image：
 *   - 移除图片块，替换为占位符文本
 *   - 实际实现需要图片处理库，这里做简化版
 */
function shrinkImages(messages: RecoveryMessage[]): RecoveryMessage[] {
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;

    let modified = false;
    const newContent = msg.content.map((block: unknown) => {
      if (typeof block !== "object" || block === null) return block;
      const b = block as Record<string, unknown>;
      if (b.type === "image_url" || b.type === "image") {
        modified = true;
        return { type: "text", text: "[image removed: too large for provider]" };
      }
      return block;
    });

    return modified ? { ...msg, content: newContent } : msg;
  });
}

/**
 * 降级 multimodal tool content 为纯文本。
 *
 * 借鉴 hermes-agent _downgrade_multimodal_tool_content：
 *   Provider 拒绝 tool 消息中的列表内容时，降级为字符串。
 */
function downgradeMultimodalToolContent(messages: RecoveryMessage[]): RecoveryMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    if (!Array.isArray(msg.content)) return msg;

    // 将数组内容合并为字符串
    const textParts: string[] = [];
    for (const block of msg.content) {
      if (typeof block === "string") {
        textParts.push(block);
      } else if (typeof block === "object" && block !== null) {
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") {
          textParts.push(b.text);
        } else if (typeof b.content === "string") {
          textParts.push(b.content);
        } else {
          textParts.push(JSON.stringify(b));
        }
      }
    }

    return { ...msg, content: textParts.join("\n") };
  });
}

/**
 * 触发上下文压缩（context_overflow、long_context_tier、payload_too_large）。
 *
 * 借鉴 hermes-agent _trigger_compaction：
 *   - 标记需要压缩
 *   - 实际压缩由 CompactionManager 执行
 *   - 这里只返回标记
 */
function triggerCompaction(messages: RecoveryMessage[]): RecoveryMessage[] {
  // 压缩由外部 CompactionManager 执行，这里只做标记
  // 返回原消息，由调用方检查 shouldTriggerCompaction 标志
  return messages;
}

// ── 主类 ────────────────────────────────────────────────────────────────────

/**
 * 错误恢复执行器。
 *
 * 借鉴 hermes-agent agent/conversation_loop.py 的错误恢复分支。
 */
export class ErrorRecoveryExecutor {
  private turnState: TurnRetryState;

  constructor(maxRetries: number = 3) {
    this.turnState = new TurnRetryState(maxRetries);
  }

  /**
   * 根据失败原因执行恢复动作。
   *
   * @param ctx 恢复上下文
   * @returns 恢复结果
   */
  executeRecovery(ctx: RecoveryContext): RecoveryResult {
    const { reason, messages, allowFailover } = ctx;
    const baseResult: RecoveryResult = {
      recovered: false,
      messages,
      shouldFailover: false,
      shouldRetry: false,
    };

    // 检查重试预算
    if (this.turnState.isRetryExhausted()) {
      return {
        ...baseResult,
        shouldFailover: allowFailover,
        action: "retry_budget_exhausted",
      };
    }

    switch (reason) {
      // ── 消息修改类 ──

      case "thinking_signature": {
        if (!this.turnState.checkAndMark("strip_thinking_blocks")) {
          // 已执行过，failover
          return {
            ...baseResult,
            shouldFailover: allowFailover,
            action: "thinking_signature_already_stripped",
          };
        }
        const newMessages = stripThinkingBlocks(messages);
        this.turnState.consumeRetry();
        return {
          ...baseResult,
          recovered: true,
          messages: newMessages,
          shouldRetry: true,
          action: "strip_thinking_blocks",
          diagnostics: { removedThinkingBlocks: true },
        };
      }

      case "invalid_encrypted_content": {
        if (!this.turnState.checkAndMark("strip_replay_blob")) {
          return {
            ...baseResult,
            shouldFailover: allowFailover,
            action: "replay_blob_already_stripped",
          };
        }
        const newMessages = stripReplayBlob(messages);
        this.turnState.consumeRetry();
        return {
          ...baseResult,
          recovered: true,
          messages: newMessages,
          shouldRetry: true,
          action: "strip_replay_blob",
          diagnostics: { removedReplayBlob: true },
        };
      }

      case "image_too_large": {
        if (!this.turnState.checkAndMark("shrink_images")) {
          return {
            ...baseResult,
            shouldFailover: allowFailover,
            action: "images_already_shrunk",
          };
        }
        const newMessages = shrinkImages(messages);
        this.turnState.consumeRetry();
        return {
          ...baseResult,
          recovered: true,
          messages: newMessages,
          shouldRetry: true,
          action: "shrink_images",
          diagnostics: { removedImages: true },
        };
      }

      case "multimodal_tool_content_unsupported": {
        if (!this.turnState.checkAndMark("downgrade_multimodal_tool_content")) {
          return {
            ...baseResult,
            shouldFailover: allowFailover,
            action: "multimodal_already_downgraded",
          };
        }
        const newMessages = downgradeMultimodalToolContent(messages);
        this.turnState.consumeRetry();
        return {
          ...baseResult,
          recovered: true,
          messages: newMessages,
          shouldRetry: true,
          action: "downgrade_multimodal_tool_content",
          diagnostics: { downgradedToText: true },
        };
      }

      // ── 上下文压缩类 ──

      case "context_overflow":
      case "long_context_tier":
      case "payload_too_large": {
        if (!this.turnState.checkAndMark("trigger_compaction")) {
          return {
            ...baseResult,
            shouldFailover: allowFailover,
            action: "compaction_already_triggered",
          };
        }
        const newMessages = triggerCompaction(messages);
        this.turnState.consumeRetry();
        return {
          ...baseResult,
          recovered: true,
          messages: newMessages,
          shouldRetry: true,
          action: "trigger_compaction",
          diagnostics: {
            needsCompaction: true,
            originalReason: reason,
          },
        };
      }

      // ── 简单重试类（带退避） ──

      case "rate_limit": {
        if (!this.turnState.consumeRetry()) {
          return {
            ...baseResult,
            shouldFailover: allowFailover,
            action: "rate_limit_retry_exhausted",
          };
        }
        return {
          ...baseResult,
          recovered: true,
          shouldRetry: true,
          retryDelayMs: 60_000, // 1 分钟
          action: "retry_with_backoff",
          diagnostics: { reason: "rate_limit", delayMs: 60_000 },
        };
      }

      case "overloaded":
      case "server_error": {
        if (!this.turnState.consumeRetry()) {
          return {
            ...baseResult,
            shouldFailover: allowFailover,
            action: `${reason}_retry_exhausted`,
          };
        }
        return {
          ...baseResult,
          recovered: true,
          shouldRetry: true,
          retryDelayMs: 5_000, // 5 秒
          action: "retry_with_backoff",
          diagnostics: { reason, delayMs: 5_000 },
        };
      }

      case "timeout":
      case "network": {
        if (!this.turnState.consumeRetry()) {
          return {
            ...baseResult,
            shouldFailover: allowFailover,
            action: `${reason}_retry_exhausted`,
          };
        }
        return {
          ...baseResult,
          recovered: true,
          shouldRetry: true,
          retryDelayMs: 2_000, // 2 秒
          action: "retry_with_backoff",
          diagnostics: { reason, delayMs: 2_000 },
        };
      }

      case "empty_response":
      case "no_error_details":
      case "unknown":
      case "unclassified": {
        if (!this.turnState.consumeRetry()) {
          return {
            ...baseResult,
            shouldFailover: allowFailover,
            action: `${reason}_retry_exhausted`,
          };
        }
        return {
          ...baseResult,
          recovered: true,
          shouldRetry: true,
          retryDelayMs: 1_000,
          action: "retry_with_backoff",
          diagnostics: { reason },
        };
      }

      // ── 不可恢复类（直接 failover） ──

      case "auth":
      case "auth_permanent":
      case "session_expired":
      case "billing":
      case "model_not_found":
      case "format":
      case "format_error":
      case "provider_policy_blocked":
      case "content_policy_blocked": {
        return {
          ...baseResult,
          shouldFailover: allowFailover,
          action: `failover_${reason}`,
          diagnostics: { reason, nonRetryable: true },
        };
      }

      default: {
        // 未知原因，保守重试一次
        if (!this.turnState.consumeRetry()) {
          return {
            ...baseResult,
            shouldFailover: allowFailover,
            action: "unknown_reason_retry_exhausted",
          };
        }
        return {
          ...baseResult,
          recovered: true,
          shouldRetry: true,
          retryDelayMs: 1_000,
          action: "retry_unknown_reason",
          diagnostics: { reason: String(reason) },
        };
      }
    }
  }

  /**
   * 获取当前 turn 的重试状态。
   */
  getTurnState(): TurnRetryState {
    return this.turnState;
  }

  /**
   * 重置 turn 状态（新 turn 开始时调用）。
   */
  resetTurn(): void {
    this.turnState.reset();
  }

  /**
   * 检查是否需要触发上下文压缩。
   */
  needsCompaction(result: RecoveryResult): boolean {
    return result.diagnostics?.needsCompaction === true;
  }
}

// ── 单例 ────────────────────────────────────────────────────────────────────

let singleton: ErrorRecoveryExecutor | null = null;

export function getErrorRecoveryExecutor(maxRetries?: number): ErrorRecoveryExecutor {
  // 当显式传入 maxRetries 时，返回新实例以尊重参数；否则使用单例
  if (maxRetries !== undefined) {
    return new ErrorRecoveryExecutor(maxRetries);
  }
  if (!singleton) {
    singleton = new ErrorRecoveryExecutor();
  }
  return singleton;
}

export function resetErrorRecoveryExecutor(): void {
  singleton = null;
}
