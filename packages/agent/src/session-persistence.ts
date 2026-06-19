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
  return path.join(deps.sessionDataDir, `${sessionId}.jsonl`);
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
    const entry = JSON.stringify({
      role,
      content,
      timestamp: new Date().toISOString(),
      ...(metadata || {}),
    });
    fs.appendFileSync(filePath, entry + "\n", "utf-8");
  } catch (err) {
    process.stderr.write(`[SessionPersistence] Failed to persist session turn: ${err instanceof Error ? err.message : String(err)}`);
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
      process.stderr.write(`[SessionPersistence] persistEarlyReturn SessionManager failed: ${err}`);
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
        return { role: entry.role, content: entry.content };
      } catch {
        return null; // skip malformed JSON lines in session history
      }
    }).filter((entry): entry is { role: string; content: string | null } => entry !== null);
  } catch (err) {
    process.stderr.write(`[SessionPersistence] Failed to load session history: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
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
      }).catch((err: unknown) => process.stderr.write(`[SessionPersistence] Memory flush failed: ${err}`));
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

  deps.conversationHistory.set(sessionId, compacted);
  process.stdout.write(`[SessionPersistence] Compacted session "${sessionId}" -> "${successorId}": ${olderEntries.length} older turns summarized, ${recentEntries.length} recent turns kept.`);

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
    }).catch((err: unknown) => process.stderr.write(`[SessionPersistence] Failed to store compaction summary: ${err}`));
  }
}
