/**
 * TurnTruncation — finish_reason=length 截断恢复策略（对标 hermes-agent agent/turn_truncation.py）
 *
 * 在 StreamingRecoveryManager 已有的 length_continue / truncated_tool_call 基础上，
 * 补充 hermes 的截断恢复策略层：
 *
 *   1. 思考耗尽检测 — thinking 消耗全部输出 token，无可见响应产生
 *   2. 重复主导中止 — 响应被重复文本主导，继续只会产出更多重复
 *   3. 窗口填满检测 — prompt 填满 context window，无空间续写
 *   4. 续写上限 — 4 次 nudge 后放弃，丢弃碎片轨迹
 *   5. 上下文溢出终态 — 部分交付后 context overflow，不续写
 *
 * 这些策略决定「是否应该续写」以及「续写前是否需要先中止」，
 * 与 StreamingRecoveryManager 的「如何续写」形成分层。
 */

import { isRepetitionDominated } from "./repetition-guard";

// ─── 常量 ──────────────────────────────────────────────────

/** 续写所需最小空闲 token（nudge + 碎片约 100 token/次） */
const MIN_CONTINUATION_HEADROOM = 512;

/** 续写 nudge 最大次数（超过后放弃续写） */
const MAX_LENGTH_CONTINUE_RETRIES = 4;

/** thinking 标签正则 */
const THINK_TAG_RE = /<(?:think|thinking|reasoning|REASONING_SCRATCHPAD)[^>]*>/gi;

// ─── 用户可见文案 ──────────────────────────────────────────

export const THINKING_EXHAUSTED_USER =
  "⚠️ **Thinking Budget Exhausted**\n\nThe model used all its output tokens on reasoning " +
  "and had none left for the actual response.\n\nTo fix this:\n" +
  "→ Lower reasoning effort: `/reasoning low` or `/reasoning minimal`\n" +
  "→ Or switch to a larger/non-reasoning model with `/model`";

export const REPETITION_DOMINATED_USER =
  "⚠️ **Response Stopped — Repetition Detected**\n\nThe model fell into a repetition loop while " +
  "writing this response, so continuing would only produce more repeated text. " +
  "The partial response was discarded.\n\n" +
  "→ Switch to a different model with `/model`\n" +
  "→ Or resend your message (your conversation history is preserved)";

export const CEILING_NO_TEXT =
  "⚠️ **No visible answer was produced.** The model hit its output-token limit on every " +
  "continuation attempt — its reasoning consumed the entire budget each time.\n\nTo fix this:\n" +
  "→ Lower reasoning effort: `/reasoning low` or `/reasoning none`\n→ Or raise max_tokens for this model";

export const TRUNCATED_FINAL =
  "⚠️ **Response truncated.** The model's output was cut off mid-response due to output-token " +
  "limits. The partial response was discarded.\n\n" +
  "→ Try `/compress` to reduce context and free up tokens\n" +
  "→ Or resend your message with a simpler request";

export const FIRST_TRUNCATED_FINAL =
  "❌ **First response truncated.** The model's first response was cut off and could not be " +
  "recovered. Please try again with a simpler request.";

export const WINDOW_FILLED_USER = (promptTokens: number, ctxTokens: number) =>
  `⚠️ **Context window full.** The prompt used ${promptTokens.toLocaleString()} of this model's ` +
  `${ctxTokens.toLocaleString()}-token context window, leaving no room to answer in. ` +
  "This is a context-window limit, not an output-length limit.\n\nTo fix this:\n" +
  "→ Compress the conversation with `/compress` or start a new session\n" +
  "→ Or raise the model's context window";

export const CONTEXT_OVERFLOW_PARTIAL_FINAL =
  "The request no longer fits the model's context window, so the partial " +
  "response was not continued. Continue in a fresh session (/new; gateway " +
  "chats are reset automatically).";

// ─── 类型 ────────────────────────────────────────────────────

export interface TruncationCheckInput {
  /** 响应文本内容 */
  content: string;
  /** 是否有工具调用 */
  hasToolCalls: boolean;
  /** prompt token 数（用于窗口填满检测） */
  promptTokens: number;
  /** context window 大小 */
  contextLength: number;
  /** 是否已触发流式重复检测 */
  runawayRepetition: boolean;
  /** 是否上下文溢出终态 */
  overflowTerminal: boolean;
  /** 已尝试的续写次数 */
  lengthContinueRetries: number;
  /** 已交付的部分文本 */
  partialText: string;
}

export type TruncationAction =
  | "continue"          // 继续续写（正常 length 截断）
  | "abort_thinking"    // 思考耗尽，中止
  | "abort_repetition"  // 重复主导，中止
  | "abort_window"      // 窗口填满，中止
  | "abort_ceiling"     // 续写上限，中止
  | "abort_overflow"    // 上下文溢出终态，中止
  | "abort_first";      // 首条响应截断，无法恢复

export interface TruncationCheckResult {
  action: TruncationAction;
  /** 用户可见文案（中止时使用） */
  userMessage: string;
  /** 是否应该设置 failed 标志 */
  failed: boolean;
  /** 是否应该设置 compression_exhausted 标志 */
  compressionExhausted: boolean;
  /** 失败原因分类 */
  failureReason?: string;
}

// ─── 核心函数 ──────────────────────────────────────────────

/**
 * 检查 thinking 块后是否有可见内容。
 * 如果响应全是 thinking 且被截断，说明 thinking 耗尽了输出 token。
 */
export function isThinkingExhausted(content: string): boolean {
  if (!content) return false;
  const stripped = content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .replace(/<thinking[\s\S]*$/gi, "")
    .trim();
  return stripped.length === 0 && /<(?:think|thinking|reasoning|REASONING_SCRATCHPAD)[^>]*>/i.test(content);
}

/**
 * 检查 prompt 是否填满了 context window。
 * 返回 (promptTokens, contextLength) 当剩余空间不足时，否则 null。
 */
export function checkWindowFilled(promptTokens: number, contextLength: number): [number, number] | null {
  if (!promptTokens || !contextLength) return null;
  if (contextLength - promptTokens < MIN_CONTINUATION_HEADROOM) {
    return [promptTokens, contextLength];
  }
  return null;
}

/**
 * 截断恢复策略检查。
 *
 * 顺序是关键：
 *   1. 流式重复检测 → 中止（续写只会重新进入循环）
 *   2. 上下文溢出终态 → 中止（请求已超出窗口）
 *   3. thinking 耗尽 → 中止（无可见响应产生）
 *   4. 重复主导 → 中止（续写只会产出更多重复）
 *   5. 窗口填满 → 中止（无空间续写）
 *   6. 续写上限 → 中止（4 次 nudge 后放弃）
 *   7. 首条响应截断 → 失败
 *   8. 正常 length 截断 → 继续续写
 */
export function checkTruncation(input: TruncationCheckInput): TruncationCheckResult {
  // 1. 流式重复检测
  if (input.runawayRepetition) {
    return {
      action: "abort_repetition",
      userMessage: REPETITION_DOMINATED_USER,
      failed: false,
      compressionExhausted: false,
    };
  }

  // 2. 上下文溢出终态
  if (input.overflowTerminal) {
    return {
      action: "abort_overflow",
      userMessage: CONTEXT_OVERFLOW_PARTIAL_FINAL,
      failed: true,
      compressionExhausted: true,
      failureReason: "context_overflow",
    };
  }

  // 3. thinking 耗尽
  if (isThinkingExhausted(input.content)) {
    return {
      action: "abort_thinking",
      userMessage: THINKING_EXHAUSTED_USER,
      failed: false,
      compressionExhausted: false,
    };
  }

  // 4. 重复主导
  if (input.content && isRepetitionDominated(input.content)) {
    return {
      action: "abort_repetition",
      userMessage: REPETITION_DOMINATED_USER,
      failed: false,
      compressionExhausted: false,
    };
  }

  // 5. 窗口填满
  const windowFilled = checkWindowFilled(input.promptTokens, input.contextLength);
  if (windowFilled) {
    return {
      action: "abort_window",
      userMessage: WINDOW_FILLED_USER(windowFilled[0], windowFilled[1]),
      failed: false,
      compressionExhausted: false,
    };
  }

  // 6. 续写上限
  if (input.lengthContinueRetries >= MAX_LENGTH_CONTINUE_RETRIES) {
    return {
      action: "abort_ceiling",
      userMessage: CEILING_NO_TEXT,
      failed: false,
      compressionExhausted: false,
    };
  }

  // 7. 首条响应截断
  if (input.lengthContinueRetries === 0 && !input.partialText.trim()) {
    // 首次截断且无部分内容
    if (input.hasToolCalls) {
      // 有工具调用的截断，可以重试工具调用
      return {
        action: "continue",
        userMessage: "",
        failed: false,
        compressionExhausted: false,
      };
    }
    // 无工具调用的首次截断
    return {
      action: "abort_first",
      userMessage: FIRST_TRUNCATED_FINAL,
      failed: true,
      compressionExhausted: false,
      failureReason: "truncated",
    };
  }

  // 8. 正常 length 截断 → 继续续写
  return {
    action: "continue",
    userMessage: "",
    failed: false,
    compressionExhausted: false,
  };
}

/**
 * 构建续写 nudge 指令。
 * 在截断的响应后追加续写提示，让模型继续输出。
 */
export function buildContinuationNudge(): string {
  return "\n\n[SYSTEM: Your response was truncated due to output length limits. " +
    "Continue directly from where you stopped — do not repeat what was already written. " +
    "Output only the continuation.]";
}

/**
 * 合并截断片段。
 * 将多段截断文本合并为完整响应，去除 thinking 块。
 */
export function mergeTruncatedParts(parts: string[]): string {
  if (parts.length === 0) return "";
  const joined = parts.join("");
  // 先移除闭合 thinking 块（含内容），再移除未闭合 thinking 块（含内容）
  let result = joined
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .replace(/<thinking[\s\S]*$/gi, "");
  return result.trim();
}

/**
 * 检查是否可以继续续写。
 * 返回 false 时表示应该中止（调用方使用 userMessage 作为最终响应）。
 */
export function shouldContinueTruncation(input: TruncationCheckInput): boolean {
  return checkTruncation(input).action === "continue";
}
