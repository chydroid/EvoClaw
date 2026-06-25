/**
 * Context Compressor — 多层上下文压缩
 *
 * 借鉴 Claude Code 的 4 层 Context Window 管理策略：
 *   - MicroCompact: 超出阈值后关闭旧工具结果（类似 cache_edits 注意力掩码）
 *   - Context Collapse: 折叠历史对话段为摘要占位符
 *   - Session Memory Compact: 基于会话记忆的压缩
 *   - Full Compact: LLM 驱动的完整对话总结
 *
 * 参考: https://decodeclaude.com/claude-code-compaction/
 *       https://code.claude.com/docs/en/agent-sdk/agent-loop#the-context-window
 */

// ── Types ──

export enum CompactionLevel {
  /** Keep all tool results inline (default) */
  None = "none",
  /** Offload old tool results (keep last N) — ≈ MicroCompact */
  Light = "light",
  /** Collapse conversation segments into summaries — ≈ Context Collapse */
  Medium = "medium",
  /** Full LLM-driven summarization — ≈ Full Compact */
  Deep = "deep",
}

export interface CompactionResult {
  level: CompactionLevel;
  /** Number of messages before compaction */
  messagesBefore: number;
  /** Number of messages after compaction */
  messagesAfter: number;
  /** Estimated tokens saved */
  tokensSaved: number;
  /** Whether compaction was performed (false if below threshold) */
  compacted: boolean;
}

export interface ToolResultEntry {
  id: string;
  name: string;
  content: string;
  timestamp: number;
  tokenCount: number;
}

export interface ContextMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolResultId?: string;
  timestamp: number;
}

// ── Token Estimation ──

/** Rough token estimation: ~1 token per 4 characters for English text */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Claude/OpenAI average: ~4 chars per token for English
  // For mixed/code content: ~3 chars per token
  return Math.ceil(text.length / 3.5);
}

/** Estimate tokens for an array of messages */
function estimateMessageTokens(messages: ContextMessage[]): number {
  let total = 0;
  for (const m of messages) {
    // Role overhead ~4 tokens
    total += 4;
    total += estimateTokens(m.content);
  }
  return total;
}

// ── Compressor ──

export class ContextCompressor {
  /** Max tokens before triggering Light compaction */
  private lightThreshold: number;
  /** Max tokens before triggering Medium compaction */
  private mediumThreshold: number;
  /** Max tokens before triggering Deep compaction */
  private deepThreshold: number;
  /** Number of recent tool results to keep inline during Light compaction */
  private keepRecentToolResults: number;

  constructor(options: {
    lightThreshold?: number;
    mediumThreshold?: number;
    deepThreshold?: number;
    keepRecentToolResults?: number;
  } = {}) {
    this.lightThreshold = options.lightThreshold ?? 20000;
    this.mediumThreshold = options.mediumThreshold ?? 40000;
    this.deepThreshold = options.deepThreshold ?? 80000;
    this.keepRecentToolResults = options.keepRecentToolResults ?? 3;
  }

  /**
   * Determine the appropriate compaction level based on current token usage.
   */
  assessLevel(totalTokens: number): CompactionLevel {
    if (totalTokens >= this.deepThreshold) return CompactionLevel.Deep;
    if (totalTokens >= this.mediumThreshold) return CompactionLevel.Medium;
    if (totalTokens >= this.lightThreshold) return CompactionLevel.Light;
    return CompactionLevel.None;
  }

  /**
   * Light Compaction: offload old tool results, keeping the most recent ones inline.
   * (Inspired by Claude's MicroCompact — cache_edits concept)
   *
   * Instead of deleting, we replace content with a file-path reference.
   */
  compactLight(messages: ContextMessage[]): {
    compacted: boolean;
    messages: ContextMessage[];
    offloadedCount: number;
    tokensSaved: number;
  } {
    const tokensBefore = estimateMessageTokens(messages);

    // Identify tool result messages and their indices
    const toolIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "tool") {
        toolIndices.push(i);
      }
    }

    if (toolIndices.length <= this.keepRecentToolResults) {
      return { compacted: false, messages, offloadedCount: 0, tokensSaved: 0 };
    }

    // Offload all but the last N tool results
    const offloadCount = toolIndices.length - this.keepRecentToolResults;
    const offloadSet = new Set(toolIndices.slice(0, offloadCount));
    const compacted = messages.map((m, i) => {
      if (m.role !== "tool") return m;
      if (!offloadSet.has(i)) return m;

      // Replace content with a compact reference (Claude Code uses file paths)
      return {
        ...m,
        content: `[Tool result saved to: evoclaw://session/${m.toolResultId ?? i}. Output omitted — ${estimateTokens(m.content)} tokens offloaded]`,
      };
    });

    const tokensAfter = estimateMessageTokens(compacted);
    return {
      compacted: true,
      messages: compacted,
      offloadedCount: offloadCount,
      tokensSaved: tokensBefore - tokensAfter,
    };
  }

  /**
   * Medium Compaction: collapse older conversation segments.
   * (Inspired by Claude's Context Collapse)
   *
   * Groups early messages into segment summaries, preserving recent context intact.
   */
  compactMedium(messages: ContextMessage[]): {
    compacted: boolean;
    messages: ContextMessage[];
    summaryText: string;
    tokensSaved: number;
  } {
    const tokensBefore = estimateMessageTokens(messages);
    if (tokensBefore < this.mediumThreshold) {
      return { compacted: false, messages, summaryText: "", tokensSaved: 0 };
    }

    // Keep last ~30% of messages intact
    const keepCount = Math.max(1, Math.floor(messages.length * 0.3));
    const earlyMessages = messages.slice(0, messages.length - keepCount);
    const recentMessages = messages.slice(messages.length - keepCount);

    // Build segment summary
    const userMsgs = earlyMessages.filter((m) => m.role === "user").length;
    const assistantMsgs = earlyMessages.filter((m) => m.role === "assistant").length;
    const toolMsgs = earlyMessages.filter((m) => m.role === "tool").length;
    const toolNames = [...new Set(earlyMessages.filter((m) => m.role === "tool").map((m) => m.toolName).filter(Boolean))];

    const summaryText = [
      `[${earlyMessages.length} earlier messages collapsed]`,
      `Messages: ${userMsgs} user, ${assistantMsgs} assistant, ${toolMsgs} tool results`,
      toolNames.length > 0 ? `Tools used: ${toolNames.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    const summaryMsg: ContextMessage = {
      role: "assistant",
      content: summaryText,
      timestamp: earlyMessages[earlyMessages.length - 1]?.timestamp ?? Date.now(),
    };

    const final = [summaryMsg, ...recentMessages];
    const tokensAfter = estimateMessageTokens(final);

    return {
      compacted: true,
      messages: final,
      summaryText,
      tokensSaved: tokensBefore - tokensAfter,
    };
  }

  /**
   * Deep Compaction: produce a structured summary suitable for LLM continuation.
   * (Inspired by Claude's Full Compact — the "compact contract")
   *
   * The summary must contain:
   *   1. User intent (original request + changes)
   *   2. Key technical decisions
   *   3. Files touched and why
   *   4. Errors encountered and fixes
   *   5. Pending tasks and current state
   */
  buildDeepCompactPrompt(messages: ContextMessage[]): {
    summaryPrompt: string;
    messagesToCompact: ContextMessage[];
  } {
    // Extract structured information from history
    const userMessages = messages.filter((m) => m.role === "user");
    const filePattern = /\b([\w./\\-]+\.[a-z]{2,5})\b/gi;

    const touchedFiles = new Set<string>();
    for (const m of messages) {
      const matches = m.content.matchAll(filePattern);
      for (const match of matches) {
        touchedFiles.add(match[1]);
      }
    }

    const summaryPrompt = [
      "You are compacting a long-running agent session. Produce a structured summary that allows exact continuation.",
      "",
      "INCLUDE:",
      "1. Original user intent and any changes to requirements",
      `   Intent: ${userMessages[0]?.content.substring(0, 200) ?? "N/A"}`,
      "2. Key technical decisions and concepts discovered",
      "3. Files touched and why they matter",
      `   Files: ${Array.from(touchedFiles).slice(0, 20).join(", ")}`,
      "4. Errors encountered and how they were fixed",
      "5. Current state: what's done, what's pending, exact next step",
      "",
      "FORMAT: Use bullet points. Be specific. Include file paths and error messages.",
      "Do NOT re-execute anything — just report the state.",
    ].join("\n");

    return { summaryPrompt, messagesToCompact: messages };
  }

  /**
   * Run a full compaction cycle: assess → execute at appropriate level.
   * Returns the compacted messages and a report.
   */
  compact(messages: ContextMessage[]): CompactionResult {
    const tokensBefore = estimateMessageTokens(messages);
    const level = this.assessLevel(tokensBefore);

    if (level === CompactionLevel.None) {
      return {
        level,
        messagesBefore: messages.length,
        messagesAfter: messages.length,
        tokensSaved: 0,
        compacted: false,
      };
    }

    if (level === CompactionLevel.Light) {
      const result = this.compactLight(messages);
      return {
        level: result.compacted ? CompactionLevel.Light : CompactionLevel.None,
        messagesBefore: messages.length,
        messagesAfter: result.messages.length,
        tokensSaved: result.tokensSaved,
        compacted: result.compacted,
      };
    }

    if (level === CompactionLevel.Medium) {
      const result = this.compactMedium(messages);
      return {
        level: result.compacted ? CompactionLevel.Medium : CompactionLevel.None,
        messagesBefore: messages.length,
        messagesAfter: result.messages.length,
        tokensSaved: result.tokensSaved,
        compacted: result.compacted,
      };
    }

    // Deep: we prepare the prompt but actual compaction is LLM-driven
    // Here we estimate based on content length reduction
    const deepResult = this.buildDeepCompactPrompt(messages);
    const estimatedOutputTokens = estimateTokens(deepResult.summaryPrompt) + 500;
    return {
      level: CompactionLevel.Deep,
      messagesBefore: messages.length,
      messagesAfter: 3, // summary + continuation
      tokensSaved: tokensBefore - estimatedOutputTokens,
      compacted: true,
    };
  }
}