// Session persistence and compaction for AgentModelExecutor
// Extracted from agent-model-executor.ts for modularity

import * as fs from "fs";
import * as path from "path";
import type { MemoryEntry, MemorySearchQuery, MemorySearchResult } from "@evoclaw/core";
import { estimateMessagesTokens } from "./error-classifier";
import type { CompactionManager } from "./compaction-manager";
import type { AgentLifecycleManager } from "./agent-lifecycle";
import type { SessionManager } from "./session-manager";

/** Conversation history entry type */
export interface SessionHistoryEntry {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

/** Memory hub interface for session persistence */
export interface SessionMemoryHub {
  getLongTerm(): {
    store(entry: MemoryEntry): Promise<MemoryEntry>;
    search(query: MemorySearchQuery): Promise<MemorySearchResult[]>;
  };
}

/** Dependencies needed by session persistence functions */
export interface SessionPersistenceDeps {
  sessionDataDir: string;
  sessionPersistenceEnabled: boolean;
  autoCompactionEnabled: boolean;
  compactionTokenThreshold: number;
  conversationHistory: Map<string, Array<SessionHistoryEntry>>;
  compactionManager: CompactionManager | null;
  lifecycleManager: AgentLifecycleManager | null;
  sessionManager: SessionManager | null;
  memoryHub: SessionMemoryHub | null;
}

/** Compute the file path for a session's JSONL persistence file */
export function sessionFilePath(deps: SessionPersistenceDeps, sessionId: string): string {
  if (!fs.existsSync(deps.sessionDataDir)) {
    fs.mkdirSync(deps.sessionDataDir, { recursive: true });
  }
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(deps.sessionDataDir, `${safeId}.jsonl`);
  if (!path.resolve(filePath).startsWith(path.resolve(deps.sessionDataDir))) {
    throw new Error("Invalid session ID: path traversal detected");
  }
  return filePath;
}

/** Persist a single conversation turn to the session file */
export function persistSessionTurn(
  deps: SessionPersistenceDeps,
  sessionId: string,
  role: string,
  content: string | null,
  metadata?: Record<string, unknown>,
): void {
  if (!deps.sessionPersistenceEnabled) return;
  try {
    const filePath = sessionFilePath(deps, sessionId);
    // fix-3: 保留 tool_calls / tool_call_id / name 字段，支持工具消息持久化
    const entry = JSON.stringify({
      role,
      content,
      timestamp: new Date().toISOString(),
      ...(metadata || {}),
    });
    fs.appendFileSync(filePath, entry + "\n", "utf-8");
  } catch (err) {
    process.stderr.write(`[SessionPersistence] Failed to persist session turn: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ── fix-3: 工具执行增量持久化（防止崩溃丢失进度） ──

/**
 * 工具执行检查点持久化选项
 */
export interface ToolCheckpointMetadata {
  /** 工具调用 ID */
  tool_call_id?: string;
  /** 工具名称 */
  name?: string;
  /** assistant 消息的 tool_calls 数组 */
  tool_calls?: SessionHistoryEntry["tool_calls"];
  /** token 使用量 */
  tokensUsed?: number;
  /** 当前工具执行轮次 */
  round?: number;
}

/**
 * 持久化工具执行检查点。
 *
 * 在每个工具执行轮次后调用，将 assistant 消息（含 tool_calls）和工具响应消息
 * 追加到 session JSONL 文件。这样即使进程崩溃，下次启动时可通过 loadSessionHistory
 * 恢复到最后一个检查点，避免丢失已完成的工具执行进度。
 *
 * 借鉴 hermes-agent 的增量 session 持久化（每个工具结果后刷盘）。
 *
 * @param role 消息角色（assistant/tool）
 * @param content 消息内容
 * @param metadata 工具相关元数据
 */
export function persistToolExecutionCheckpoint(
  deps: SessionPersistenceDeps,
  sessionId: string,
  role: string,
  content: string | null,
  metadata?: ToolCheckpointMetadata,
): void {
  if (!deps.sessionPersistenceEnabled) return;
  try {
    const filePath = sessionFilePath(deps, sessionId);
    const entry = JSON.stringify({
      role,
      content,
      timestamp: new Date().toISOString(),
      ...(metadata || {}),
    });
    fs.appendFileSync(filePath, entry + "\n", "utf-8");
  } catch (err) {
    process.stderr.write(`[SessionPersistence] Failed to persist tool checkpoint: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/** Persist a conversation turn for early-return paths (skill install, config query, etc.) */
export function persistEarlyReturn(
  deps: SessionPersistenceDeps,
  sessionId: string,
  userMessage: string,
  assistantReply: string,
): void {
  if (!sessionId || !assistantReply) return;
  // Persist via SessionManager (primary)
  // Note: user turn was already persisted at chat() entry, so only persist assistant turn
  if (deps.sessionManager) {
    try {
      const agentId = "default";
      deps.sessionManager.getOrCreateSession(agentId, sessionId);
      deps.sessionManager.appendTurn(agentId, sessionId, {
        turnIndex: 0, role: "assistant", content: assistantReply, timestamp: new Date().toISOString(),
      });
    } catch (err) {
      process.stderr.write(`[SessionPersistence] persistEarlyReturn SessionManager failed: ${err}\n`);
    }
  }
  // Also persist via legacy file-based method (assistant only — user was persisted early)
  persistSessionTurn(deps, sessionId, "assistant", assistantReply);
  // Update in-memory conversation history
  const history = deps.conversationHistory.get(sessionId) || [];
  history.push({ role: "user", content: userMessage });
  history.push({ role: "assistant", content: assistantReply });
  deps.conversationHistory.set(sessionId, history);
}

/** Load session history from the JSONL persistence file */
export function loadSessionHistory(
  deps: SessionPersistenceDeps,
  sessionId: string,
): Array<{ role: string; content: string | null }> {
  if (!deps.sessionPersistenceEnabled) return [];
  try {
    const filePath = sessionFilePath(deps, sessionId);
    if (!fs.existsSync(filePath)) return [];
    const data = fs.readFileSync(filePath, "utf-8");
    const lines = data.split("\n").filter((l) => l.trim());
    return lines.map((line) => {
      try {
        const entry = JSON.parse(line);
        // fix-3: 保留 tool_calls / tool_call_id / name 字段，
        // 使崩溃恢复后能重建完整的工具调用序列。
        // 注意：返回类型声明为 { role, content } 但实际包含额外字段，
        // 调用方（如 closeInterruptedToolSequence）通过 SessionHistoryEntry 访问。
        return {
          role: entry.role,
          content: entry.content,
          ...(entry.tool_calls ? { tool_calls: entry.tool_calls } : {}),
          ...(entry.tool_call_id ? { tool_call_id: entry.tool_call_id } : {}),
          ...(entry.name ? { name: entry.name } : {}),
        };
      } catch {
        return null; // skip malformed JSON lines in session history
      }
    }).filter((entry): entry is { role: string; content: string | null } => entry !== null);
  } catch (err) {
    process.stderr.write(`[SessionPersistence] Failed to load session history: ${err instanceof Error ? err.message : String(err)}\n`);
    return [];
  }
}

// ── fix-2: 中断后孤儿 tool_call 清理（对齐 hermes close_interrupted_tool_sequence） ──

/**
 * 检测并修复中断的 tool_call 序列。
 *
 * 当 LLM 流式响应中途中断（网络错误/超时/用户 abort）时，assistant 消息可能
 * 包含 tool_calls 但没有对应的 tool response 消息跟随。下一轮发送给 provider
 * 时会返回 400 错误："messages must end with a tool message after a tool_call"。
 *
 * 此函数扫描历史末尾的 assistant 消息，如果发现 tool_calls 缺失对应的 tool
 * response，则追加合成的 tool 消息（content 标注中断），使序列闭合。
 *
 * 等价于 hermes-agent 的 close_interrupted_tool_sequence。
 *
 * @returns 追加的合成消息数量（0 表示无需修复）
 */
export function closeInterruptedToolSequence(
  deps: SessionPersistenceDeps,
  sessionId: string,
): number {
  const history = deps.conversationHistory.get(sessionId);
  if (!history || history.length === 0) return 0;

  // 找到最后一条 assistant 消息（可能带 tool_calls）
  let lastAssistantIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
    // 如果遇到 user 消息，说明序列已闭合（user 发了新消息），无需修复
    if (history[i].role === "user") return 0;
  }
  if (lastAssistantIdx === -1) return 0;

  const lastAssistant = history[lastAssistantIdx];
  const toolCalls = lastAssistant.tool_calls;
  if (!toolCalls || toolCalls.length === 0) return 0;

  // 收集该 assistant 消息之后所有 tool response 的 tool_call_id
  const respondedIds = new Set<string>();
  for (let i = lastAssistantIdx + 1; i < history.length; i++) {
    const entry = history[i];
    if (entry.role === "tool" && entry.tool_call_id) {
      respondedIds.add(entry.tool_call_id);
    }
  }

  // 找出缺失 response 的 tool_call
  const orphanCalls = toolCalls.filter((tc) => !respondedIds.has(tc.id));
  if (orphanCalls.length === 0) return 0;

  // 追加合成 tool response 消息使序列闭合
  const syntheticMessages: SessionHistoryEntry[] = orphanCalls.map((tc) => ({
    role: "tool",
    tool_call_id: tc.id,
    name: tc.function?.name || "unknown",
    content: JSON.stringify({
      error: "interrupted",
      reason: "Tool call was interrupted before completion (stream aborted or timed out).",
      timestamp: Date.now(),
    }),
  }));

  history.push(...syntheticMessages);

  process.stderr.write(
    `[SessionPersistence] Closed ${syntheticMessages.length} interrupted tool_call(s) for session "${sessionId}"\n`,
  );

  return syntheticMessages.length;
}

/** Check if a session's conversation history needs compaction */
export function needsCompaction(
  deps: SessionPersistenceDeps,
  sessionId: string,
  systemPrompt: string,
  maxTokens: number,
): boolean {
  if (!deps.autoCompactionEnabled) return false;
  const history = deps.conversationHistory.get(sessionId) || [];
  const systemTokens = estimateMessagesTokens([{ role: "system", content: systemPrompt }]);
  const historyTokens = estimateMessagesTokens(history.map((h) => ({ role: h.role, content: h.content })));
  const totalTokens = systemTokens + historyTokens;
  return totalTokens > deps.compactionTokenThreshold;
}

/** Compact conversation history by summarizing older turns and keeping recent ones */
export function compactConversationHistory(
  deps: SessionPersistenceDeps,
  sessionId: string,
  keepRecentTurns: number = 3,
): void {
  const history = deps.conversationHistory.get(sessionId);
  if (!history || history.length <= keepRecentTurns * 2) return;

  const recentEntries = history.slice(-keepRecentTurns * 2);
  const olderEntries = history.slice(0, -(keepRecentTurns * 2));

  // Use CompactionManager if available for richer summary with successor transcripts
  let summary = "";
  let successorId = sessionId;
  if (deps.compactionManager) {
    const compaction = deps.compactionManager.buildSummary(
      sessionId,
      olderEntries.map((e) => ({ role: e.role, content: e.content })),
    );
    summary = deps.compactionManager.buildSuccessorPrompt(compaction);
    successorId = compaction.successorSessionId;

    // Flush to long-term memory
    if (deps.memoryHub) {
      const memEntry = deps.compactionManager.buildMemoryEntry(compaction);
      const longTerm = deps.memoryHub.getLongTerm();
      longTerm.store({
        content: memEntry.content,
        type: memEntry.type,
        metadata: {
          source: memEntry.metadata.source,
          sessionId,
          userId: "default",
          tags: memEntry.metadata.tags,
          importance: memEntry.metadata.importance,
          associations: [],
          entities: [],
        },
        ttl: 30 * 24 * 3600 * 1000,
        embedding: null,
        id: "",
        createdAt: new Date(),
        accessedAt: new Date(),
      }).catch((err: unknown) => process.stderr.write(`[SessionPersistence] Memory flush failed: ${err}\n`));
    }

    // Emit lifecycle event
    if (deps.lifecycleManager) {
      deps.lifecycleManager.compacted(sessionId, olderEntries.length, successorId);
    }
  } else {
    // Fallback to simple compaction
    const userMessages = olderEntries
      .filter((e) => e.role === "user" && e.content)
      .map((e) => e.content as string);
    const assistantMessages = olderEntries
      .filter((e) => e.role === "assistant" && e.content)
      .map((e) => e.content as string);
    if (userMessages.length > 0 || assistantMessages.length > 0) {
      summary = `[Compacted ${olderEntries.length} turns. `;
      if (userMessages.length > 0) {
        summary += `User discussed: ${userMessages.map((m) => m.slice(0, 80)).join("; ")}. `;
      }
      if (assistantMessages.length > 0) {
        summary += `Assistant covered: ${assistantMessages.map((m) => m.slice(0, 80)).join("; ")}.`;
      }
      summary += "]";
    }
  }

  const compacted: Array<{ role: string; content: string | null }> = [
    { role: "system", content: summary || "[Previous conversation has been compacted.]" },
    ...recentEntries,
  ];

  // ── fix-5: 确保压缩后的历史以 user turn 结束（对齐 hermes _ensure_compressed_has_user_turn） ──
  // 如果压缩后历史末尾不是 user 消息，LLM 可能没有明确的"用户请求"可响应，
  // 导致生成不相关或困惑的回复。此函数检查末尾并在必要时追加合成 user 消息。
  if (compacted.length > 0) {
    const lastEntry = compacted[compacted.length - 1];
    if (lastEntry.role !== "user") {
      compacted.push({
        role: "user",
        content: "[Context was compacted. Please continue from where we left off based on the summary above.]",
      });
      process.stdout.write(`[SessionPersistence] Appended synthetic user turn after compaction for session "${sessionId}"\n`);
    }
  }

  deps.conversationHistory.set(sessionId, compacted);
  process.stdout.write(`[SessionPersistence] Compacted session "${sessionId}" -> "${successorId}": ${olderEntries.length} older turns summarized, ${recentEntries.length} recent turns kept.\n`);

  // Fallback: Store compacted summary in long-term memory (only when CompactionManager not available, as it already handles this)
  if (!deps.compactionManager && deps.memoryHub && summary) {
    const longTerm = deps.memoryHub.getLongTerm();
    longTerm.store({
      content: summary,
      type: "system",
      metadata: {
        source: "compaction",
        sessionId: sessionId,
        userId: "default",
        tags: ["conversation", "compacted"],
        importance: 0.6,
        associations: [],
        entities: [],
      },
      ttl: 30 * 24 * 3600 * 1000, // 30 days
      embedding: null,
      id: "",
      createdAt: new Date(),
      accessedAt: new Date(),
    }).catch((err: unknown) => process.stderr.write(`[SessionPersistence] Failed to store compaction summary: ${err}\n`));
  }
}
