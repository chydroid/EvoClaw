/**
 * CompactionManager — OpenClaw-style conversation compaction with successor transcripts.
 *
 * When a session grows too large, we create a "successor transcript" that summarizes
 * the old conversation and starts a new continuation session, chaining them together
 * so the full history can be reconstructed on demand.
 *
 * 历史前缀追踪（灵感来自 hermes-agent context_compressor.py）：
 * 当摘要前缀变更时，旧版本前缀在重新压缩时被剥离，防止过时指令（如"resume exactly"）
 * 嵌入正文持续劫持回复。
 */

import * as fs from "fs";
import * as path from "path";

export interface CompactionSummary {
  /** Unique ID for this compaction */
  id: string;
  /** Session that was compacted */
  parentSessionId: string;
  /** New successor session ID */
  successorSessionId: string;
  /** Summary of the compacted content */
  summary: string;
  /** Key facts extracted from the conversation */
  keyFacts: string[];
  /** Key decisions made */
  decisions: string[];
  /** Pending items that need follow-up */
  pendingItems: string[];
  /** Number of turns compacted */
  compactedTurnCount: number;
  /** Timestamp */
  timestamp: string;
}

export interface CompactionConfig {
  /** Token threshold to trigger compaction */
  tokenThreshold: number;
  /** Number of recent turns to always preserve */
  keepRecentTurns: number;
  /** Maximum summary length in characters */
  maxSummaryLength: number;
  /** Whether to use LLM for summarization (if available) */
  useLLMSummarization: boolean;
  /** Data directory for storing compaction records */
  dataDir: string;
}

const DEFAULT_CONFIG: CompactionConfig = {
  tokenThreshold: 3000,
  keepRecentTurns: 4,
  maxSummaryLength: 2000,
  useLLMSummarization: true,
  dataDir: path.join(process.cwd(), "data", "compactions"),
};

/**
 * 当前摘要前缀。变更此值时，旧前缀会被加入 HISTORICAL_SUMMARY_PREFIXES，
 * 在重新压缩时被剥离，防止过时指令劫持回复。
 */
const SUMMARY_PREFIX = "[Compacted";
const SUCCESSOR_PREFIX = "[This is a continuation of session";
/** 历史前缀列表：这些前缀在重新压缩时会被剥离。 */
const HISTORICAL_SUMMARY_PREFIXES: string[] = [
  "[Compacted",           // 当前
  "[Conversation compacted", // 旧版
  "[Session compacted",   // 更旧版
];
const HISTORICAL_SUCCESSOR_PREFIXES: string[] = [
  "[This is a continuation of session", // 当前
  "[Continuing from session",           // 旧版
  "[Resuming session",                  // 更旧版
];

/**
 * 原子写入文件（temp + fsync + rename）。
 * 防止崩溃时产生截断的 compaction 记录。
 */
function atomicWriteFileLocal(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, content, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EXDEV" || code === "EBUSY") {
      const c = fs.readFileSync(tmpPath, "utf-8");
      const fd2 = fs.openSync(targetPath, "w");
      try {
        fs.writeFileSync(fd2, c, "utf-8");
        fs.fsyncSync(fd2);
      } finally {
        fs.closeSync(fd2);
      }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    } else {
      throw err;
    }
  }
}

/** 从文本中剥离所有历史前缀标记，防止过时指令存活。 */
function stripHistoricalPrefixes(text: string, prefixes: string[]): string {
  let result = text;
  for (const prefix of prefixes) {
    // 剥离形如 "[Prefix ...]" 的标记（到下一个 ] 为止）
    let idx = result.indexOf(prefix);
    while (idx >= 0) {
      const end = result.indexOf("]", idx);
      if (end < 0) break;
      result = result.slice(0, idx) + result.slice(end + 1).replace(/^\s+/, "");
      idx = result.indexOf(prefix);
    }
  }
  return result.trim();
}

export class CompactionManager {
  private config: CompactionConfig;
  private compactions = new Map<string, CompactionSummary[]>();
  private compactionCounter = 0;

  constructor(config?: Partial<CompactionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureDataDir();
  }

  private ensureDataDir(): void {
    try {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    } catch {}
  }

  /** Build a compaction summary from conversation turns */
  buildSummary(
    sessionId: string,
    olderTurns: Array<{ role: string; content: string | null }>,
  ): CompactionSummary {
    const id = `comp-${Date.now()}-${++this.compactionCounter}`;
    const successorId = `${sessionId}-succ-${this.compactionCounter}`;

    // Extract key information
    const userMessages = olderTurns
      .filter((t) => t.role === "user" && t.content)
      .map((t) => t.content!);
    const assistantMessages = olderTurns
      .filter((t) => t.role === "assistant" && t.content)
      .map((t) => t.content!);

    // Simple rule-based summarization (LLM version would be richer)
    const keyFacts = this.extractKeyFacts(userMessages, assistantMessages);
    const decisions = this.extractDecisions(assistantMessages);
    const pendingItems = this.extractPendingItems(assistantMessages);

    const summaryParts: string[] = [];

    if (userMessages.length > 0) {
      const topics = userMessages
        .map((m) => this.extractTopic(m))
        .filter(Boolean);
      summaryParts.push(
        `${SUMMARY_PREFIX} ${olderTurns.length} turns from session "${sessionId}".]`,
      );
      if (topics.length > 0) {
        summaryParts.push(`Topics discussed: ${topics.join("; ")}.`);
      }
    }

    if (keyFacts.length > 0) {
      summaryParts.push(
        `Key facts: ${keyFacts.slice(0, 8).join("; ")}.`,
      );
    }

    if (decisions.length > 0) {
      summaryParts.push(
        `Decisions made: ${decisions.slice(0, 5).join("; ")}.`,
      );
    }

    if (pendingItems.length > 0) {
      summaryParts.push(
        `Pending: ${pendingItems.slice(0, 5).join("; ")}.`,
      );
    }

    let summary = summaryParts.join(" ");
    // CJK 安全截断：不在 UTF-16 代理对中间截断
    if (summary.length > this.config.maxSummaryLength) {
      const maxLen = this.config.maxSummaryLength - 3;
      let cut = maxLen;
      // 如果截断位置在高代理项后，向前退一位
      if (cut > 0 && cut < summary.length) {
        const code = summary.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) {
          cut -= 1;
        }
      }
      summary = summary.slice(0, cut) + "...";
    }

    const compaction: CompactionSummary = {
      id,
      parentSessionId: sessionId,
      successorSessionId: successorId,
      summary,
      keyFacts: keyFacts.slice(0, 10),
      decisions: decisions.slice(0, 8),
      pendingItems: pendingItems.slice(0, 8),
      compactedTurnCount: olderTurns.length,
      timestamp: new Date().toISOString(),
    };

    // Store in-memory chain
    const chain = this.compactions.get(sessionId) || [];
    chain.push(compaction);
    this.compactions.set(sessionId, chain);

    // Persist to disk
    this.persistCompaction(compaction);

    return compaction;
  }

  /** Build system prompt injection for successor session */
  buildSuccessorPrompt(compaction: CompactionSummary): string {
    // 剥离历史前缀，防止过时指令（如"resume exactly"）存活
    const cleanSummary = stripHistoricalPrefixes(compaction.summary, HISTORICAL_SUMMARY_PREFIXES);
    const parts: string[] = [
      `${SUCCESSOR_PREFIX} "${compaction.parentSessionId}". Previous context has been compacted.]`,
      ``,
      `Previous summary: ${cleanSummary}`,
    ];

    if (compaction.keyFacts.length > 0) {
      parts.push(
        `Key facts remembered: ${compaction.keyFacts.join("; ")}`,
      );
    }

    if (compaction.pendingItems.length > 0) {
      parts.push(
        `Items still pending: ${compaction.pendingItems.join("; ")}`,
      );
    }

    return parts.join("\n");
  }

  /** Get the full compaction chain for a session */
  getCompactionChain(sessionId: string): CompactionSummary[] {
    return this.compactions.get(sessionId) || [];
  }

  /** Get the latest successor session ID */
  getLatestSuccessor(sessionId: string): string {
    const chain = this.compactions.get(sessionId);
    if (!chain || chain.length === 0) return sessionId;
    return chain[chain.length - 1].successorSessionId;
  }

  /** Flush compaction summary to long-term memory (caller provides memory hub) */
  buildMemoryEntry(compaction: CompactionSummary): {
    content: string;
    type: "conversation";
    metadata: {
      source: string;
      parentSessionId: string;
      successorSessionId: string;
      tags: string[];
      importance: number;
      keyFacts: string[];
      decisions: string[];
      pendingItems: string[];
    };
  } {
    return {
      content: compaction.summary,
      type: "conversation",
      metadata: {
        source: "session_compaction",
        parentSessionId: compaction.parentSessionId,
        successorSessionId: compaction.successorSessionId,
        tags: ["compaction", "conversation"],
        importance: 0.7,
        keyFacts: compaction.keyFacts,
        decisions: compaction.decisions,
        pendingItems: compaction.pendingItems,
      },
    };
  }

  /** Create an LLM-optimized summary prompt */
  buildLLMSummaryPrompt(
    turns: Array<{ role: string; content: string | null }>,
  ): string {
    const conversation = turns
      .filter((t) => t.content)
      .map((t) => `${t.role}: ${t.content!.slice(0, 500)}`)
      .join("\n\n");

    return [
      "Summarize the following conversation. Extract:",
      "1. Key facts and information learned",
      "2. Decisions made",
      "3. Pending items that need follow-up",
      "4. User preferences or patterns noticed",
      "",
      "Keep the summary concise (max 500 words).",
      "",
      "Conversation:",
      conversation,
    ].join("\n");
  }

  // ====== Private helpers ======

  private extractTopic(message: string): string {
    // Extract first meaningful phrase as topic
    const cleaned = message
      .replace(/[，。！？,.!?]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const words = cleaned.split(" ");
    if (words.length <= 6) return cleaned;
    return words.slice(0, 6).join(" ") + "...";
  }

  private extractKeyFacts(
    userMessages: string[],
    assistantMessages: string[],
  ): string[] {
    const facts: string[] = [];

    for (const msg of assistantMessages) {
      // Look for factual statements
      const lines = msg
        .split("\n")
        .filter(
          (l) =>
            l.includes("是") ||
            l.includes("确定") ||
            l.includes("发现") ||
            l.includes("找到") ||
            l.includes("完成") ||
            l.includes("创建") ||
            l.includes("保存"),
        );
      for (const line of lines.slice(0, 3)) {
        const cleaned = line.replace(/^[-*#>\s]+/, "").trim();
        if (cleaned.length > 10 && cleaned.length < 150) {
          facts.push(cleaned);
        }
      }
    }

    // Also extract facts from explicit user statements
    for (const msg of userMessages) {
      if (
        msg.includes("是") ||
        msg.includes("喜欢") ||
        msg.includes("需要") ||
        msg.includes("设置") ||
        msg.includes("配置")
      ) {
        const cleaned = msg.slice(0, 100).trim();
        if (cleaned.length > 5) facts.push(`User stated: ${cleaned}`);
      }
    }

    return [...new Set(facts)].slice(0, 10);
  }

  private extractDecisions(assistantMessages: string[]): string[] {
    const decisions: string[] = [];
    const decisionKeywords = [
      "决定",
      "选择",
      "建议",
      "推荐",
      "采用",
      "使用",
      "配置为",
      "设置为",
      "done",
      "completed",
      "resolved",
      "decided",
    ];

    for (const msg of assistantMessages) {
      for (const kw of decisionKeywords) {
        if (msg.includes(kw)) {
          const idx = msg.indexOf(kw);
          const context = msg.slice(Math.max(0, idx - 20), idx + 80).trim();
          if (context.length > 10) {
            decisions.push(context);
            break;
          }
        }
      }
    }

    return [...new Set(decisions)].slice(0, 8);
  }

  private extractPendingItems(assistantMessages: string[]): string[] {
    const pending: string[] = [];
    const pendingKeywords = [
      "待",
      "还需",
      "接下来",
      "下一步",
      "继续",
      "稍后",
      "pending",
      "todo",
      "next",
      "follow",
      "剩余",
    ];

    for (const msg of assistantMessages) {
      for (const kw of pendingKeywords) {
        if (msg.includes(kw)) {
          const idx = msg.indexOf(kw);
          const context = msg.slice(idx, idx + 100).trim();
          if (context.length > 10) {
            pending.push(context);
            break;
          }
        }
      }
    }

    return [...new Set(pending)].slice(0, 8);
  }

  private persistCompaction(compaction: CompactionSummary): void {
    try {
      const filePath = path.join(
        this.config.dataDir,
        `${compaction.parentSessionId}.json`,
      );

      let existing: CompactionSummary[] = [];
      if (fs.existsSync(filePath)) {
        try {
          existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        } catch (err) { process.stderr.write(`[CompactionManager] Failed to parse existing compaction file "${filePath}":` + " " + err); }
      }

      existing.push(compaction);
      // 使用原子写入，防止崩溃时产生截断 JSON
      atomicWriteFileLocal(filePath, JSON.stringify(existing, null, 2));
    } catch (err) {
      process.stderr.write(
        `[CompactionManager] Failed to persist compaction: ${err}`,
      );
    }
  }

  /** Load compaction chain from disk */
  loadCompactionChain(sessionId: string): CompactionSummary[] {
    try {
      const filePath = path.join(this.config.dataDir, `${sessionId}.json`);
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (Array.isArray(data)) {
          this.compactions.set(sessionId, data);
          return data;
        }
      }
    } catch (err) {
      process.stderr.write(
        `[CompactionManager] Failed to load compaction chain: ${err}`,
      );
    }
    return [];
  }

  /** Clear all compactions for a session */
  clearCompactions(sessionId: string): void {
    this.compactions.delete(sessionId);
    try {
      const filePath = path.join(this.config.dataDir, `${sessionId}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {}
  }
}